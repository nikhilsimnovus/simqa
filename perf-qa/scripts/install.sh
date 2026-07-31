#!/bin/bash
# perf-qa one-shot installer.
#
# Runs on a fresh Linux host (Ubuntu/Debian or RHEL/CentOS family). Installs
# OS prereqs via the system package manager, creates the perfqa user, lays
# down files into FHS-aligned locations, builds the Python venv with Flask +
# Playwright (downloads headless Chromium), installs + starts the systemd
# unit on port 8080. Idempotent — safe to re-run.
#
# Usage:
#   tar xzf perf-qa-deploy-<ts>.tar.gz
#   cd perf-qa
#   sudo bash scripts/install.sh
#
# Override the listen port (default 8080) by exporting PERFQA_PORT first.

set -euo pipefail

# ---- Sanity ----------------------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
    echo "ERROR: install.sh must run as root (use sudo)" >&2
    exit 1
fi

# Resolve the script's own dir + the perf-qa source root (parent of scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(dirname "${SCRIPT_DIR}")"
[[ -f "${SRC_ROOT}/collect_perf_data.sh" ]] || {
    echo "ERROR: expected ${SRC_ROOT}/collect_perf_data.sh; running from wrong dir?" >&2
    exit 1
}

# ---- Knobs -----------------------------------------------------------------
SERVICE_USER="${PERFQA_USER:-perfqa}"
SERVICE_GROUP="${PERFQA_GROUP:-perfqa}"
PERFQA_HOME="${PERFQA_HOME:-/var/lib/perfqa}"
SCRIPT_INSTALL_DIR="${PERFQA_SCRIPT_DIR:-/opt/perf-qa}"
UI_INSTALL_DIR="${PERFQA_UI_DIR:-/opt/perf-qa-ui}"
BUNDLE_DIR="${PERFQA_BUNDLE_ROOT:-/var/lib/perf-qa/bundles}"
LISTEN_PORT="${PERFQA_PORT:-8080}"
SYSTEMD_UNIT="${PERFQA_UNIT:-/etc/systemd/system/perf-qa-ui.service}"

log() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1) Detect distro + install OS prereqs --------------------------------
log "Detecting package manager"
if   command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf     >/dev/null 2>&1; then PKG=dnf
elif command -v yum     >/dev/null 2>&1; then PKG=yum
else fail "no supported package manager (apt-get / dnf / yum)"
fi
log "Using ${PKG}"

PREREQS_APT="bash python3 python3-venv python3-pip openssh-client sshpass curl jq zip tar unzip ca-certificates"
PREREQS_RPM="bash python3 python3-pip openssh-clients sshpass curl jq zip tar unzip ca-certificates"

case "${PKG}" in
  apt)
    log "Updating apt index"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    log "Installing prereqs: ${PREREQS_APT}"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${PREREQS_APT}
    ;;
  dnf|yum)
    log "Installing prereqs: ${PREREQS_RPM}"
    ${PKG} install -y -q ${PREREQS_RPM}
    ;;
esac

# ---- 2) Create service user + dirs ----------------------------------------
if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    log "User ${SERVICE_USER} already exists"
else
    log "Creating user ${SERVICE_USER} (home=${PERFQA_HOME})"
    useradd --system --create-home --home "${PERFQA_HOME}" --shell /bin/bash "${SERVICE_USER}"
fi

log "Creating install directories"
install -d -m 0755 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" \
    "${SCRIPT_INSTALL_DIR}" "${UI_INSTALL_DIR}" "${BUNDLE_DIR}"

# ---- 3) Copy files ---------------------------------------------------------
log "Installing collector scripts to ${SCRIPT_INSTALL_DIR}"
install -m 0755 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" \
    "${SRC_ROOT}/collect_perf_data.sh" \
    "${SRC_ROOT}/analyze_bundle.py" \
    "${SRC_ROOT}/build_system_md.py" \
    "${SRC_ROOT}/beszel_screenshot.py" \
    "${SRC_ROOT}/simnovator_screenshot.py" \
    "${SCRIPT_INSTALL_DIR}/"

# Seed setup.conf only if it doesn't already exist — preserve existing config
# across re-runs of the installer.
if [[ ! -f "${SCRIPT_INSTALL_DIR}/setup.conf" ]]; then
    log "Seeding ${SCRIPT_INSTALL_DIR}/setup.conf from example"
    install -m 0640 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" \
        "${SRC_ROOT}/setup.conf.example" "${SCRIPT_INSTALL_DIR}/setup.conf"
else
    log "Keeping existing ${SCRIPT_INSTALL_DIR}/setup.conf (re-run; edit by hand to update)"
fi

log "Installing Flask UI to ${UI_INSTALL_DIR}"
install -m 0644 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" \
    "${SRC_ROOT}/ui/app.py" \
    "${SRC_ROOT}/ui/favicon.png" \
    "${SRC_ROOT}/ui/logo_light.svg" \
    "${SRC_ROOT}/ui/logo_dark.svg" \
    "${UI_INSTALL_DIR}/"

# ---- 4) Python venv + Flask + Playwright ----------------------------------
if [[ -x "${UI_INSTALL_DIR}/venv/bin/python" ]]; then
    log "Venv already exists at ${UI_INSTALL_DIR}/venv — upgrading deps"
else
    log "Creating Python venv at ${UI_INSTALL_DIR}/venv"
    sudo -u "${SERVICE_USER}" python3 -m venv "${UI_INSTALL_DIR}/venv"
fi

# pip_install: try a normal `pip install`; if TLS verification fails because
# the customer has an SSL-inspecting proxy (Zscaler / Palo Alto / etc.), retry
# once with --trusted-host on the official PyPI hosts. Customers can avoid
# this fallback entirely by exporting PIP_CERT=/path/to/corp-ca-bundle.crt
# (preferred), PIP_INDEX_URL=<their internal mirror>, or PIP_TRUSTED_HOST=...
# before invoking install.sh — all are honoured automatically by pip.
pip_install() {
    local logf
    logf="$(mktemp)"
    if sudo -u "${SERVICE_USER}" -E "${UI_INSTALL_DIR}/venv/bin/pip" install --quiet "$@" >"$logf" 2>&1; then
        rm -f "$logf"
        return 0
    fi
    if grep -qE 'CERTIFICATE_VERIFY_FAILED|SSLError|self-signed certificate' "$logf"; then
        warn "pip TLS verification failed — looks like a corporate SSL-inspecting proxy."
        warn "Retrying with --trusted-host fallback. To avoid this next time, point pip"
        warn "at your enterprise CA bundle:  export PIP_CERT=/etc/ssl/certs/ca-bundle.crt"
        warn "(or set PIP_INDEX_URL to an internal mirror, or PIP_TRUSTED_HOST=<host>)."
        if sudo -u "${SERVICE_USER}" -E "${UI_INSTALL_DIR}/venv/bin/pip" install --quiet \
                --trusted-host pypi.org \
                --trusted-host files.pythonhosted.org \
                --trusted-host pypi.python.org \
                "$@" >"$logf" 2>&1; then
            rm -f "$logf"
            return 0
        fi
    fi
    # Final failure — surface the actual error so the customer can fix it.
    echo "----- pip output (last 30 lines) -----" >&2
    tail -30 "$logf" >&2
    rm -f "$logf"
    fail "pip install failed for: $*"
}
log "Installing Flask + Playwright into venv (pip)"
pip_install --upgrade pip
pip_install --upgrade flask playwright

# Playwright browsers — install order (each step skipped if the previous
# already put a chromium-* dir into the cache):
#   (a) Use vendored browsers shipped IN the tarball (perf-qa/vendor/
#       playwright-browsers/) — zero network needed at the customer site.
#   (b) Skip entirely if SKIP_PLAYWRIGHT=1 — Beszel + Simnovator GUI
#       screenshots disabled; everything else still works.
#   (c) Fall through to `playwright install chromium` over HTTPS (needs
#       outbound to cdn.playwright.dev — fails if a TLS-inspecting proxy
#       intercepts unless NODE_EXTRA_CA_CERTS points at the corp bundle).
PW_BROWSERS="${PERFQA_HOME}/.cache/ms-playwright"
VENDOR_BROWSERS="${SRC_ROOT}/vendor/playwright-browsers"
# Plumb a customer-supplied CA bundle through to Playwright (Node HTTPS).
PW_CA_BUNDLE="${NODE_EXTRA_CA_CERTS:-${SSL_CERT_FILE:-${PIP_CERT:-}}}"

# Helper: returns 0 if at least one chromium-<version> dir exists under $1.
# Plain `[[ -d "$1/chromium-"* ]]` does NOT work — bash's [[ ]] disables
# filename globbing, so the `*` stays literal and the test always fails.
# compgen -G expands the glob in a context that does match real files.
has_chromium() { compgen -G "$1/chromium-*" >/dev/null 2>&1; }

# (a) Vendored browsers shipped inside the tarball — preferred path.
if has_chromium "${VENDOR_BROWSERS}" && ! has_chromium "${PW_BROWSERS}"; then
    log "Installing pre-staged Playwright browsers from ${VENDOR_BROWSERS}"
    sudo -u "${SERVICE_USER}" mkdir -p "${PW_BROWSERS}"
    # Copy preserving owner-writable perms; -a keeps symlinks + executables.
    sudo cp -a "${VENDOR_BROWSERS}"/. "${PW_BROWSERS}/"
    sudo chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${PW_BROWSERS}"
    log "Vendored: $(du -sh "${PW_BROWSERS}" | cut -f1) under ${PW_BROWSERS}"
fi

if has_chromium "${PW_BROWSERS}"; then
    log "Playwright Chromium already present in ${PW_BROWSERS}"
elif [[ "${SKIP_PLAYWRIGHT:-0}" == "1" ]]; then
    warn "SKIP_PLAYWRIGHT=1 — Beszel + Simnovator GUI screenshots will be disabled"
else
    log "Downloading Playwright Chromium (~150 MB, one-shot)"
    pw_env=(PLAYWRIGHT_BROWSERS_PATH="${PW_BROWSERS}")
    [[ -n "${PW_CA_BUNDLE}" ]] && pw_env+=(NODE_EXTRA_CA_CERTS="${PW_CA_BUNDLE}" SSL_CERT_FILE="${PW_CA_BUNDLE}")
    [[ -n "${HTTPS_PROXY:-}" ]] && pw_env+=(HTTPS_PROXY="${HTTPS_PROXY}")
    [[ -n "${HTTP_PROXY:-}"  ]] && pw_env+=(HTTP_PROXY="${HTTP_PROXY}")
    if ! sudo -u "${SERVICE_USER}" env "${pw_env[@]}" \
            "${UI_INSTALL_DIR}/venv/bin/playwright" install chromium 2>&1; then
        warn "playwright install chromium FAILED."
        warn "Common cause: corporate SSL-inspecting proxy."
        warn "Fix: export NODE_EXTRA_CA_CERTS=/path/to/corp-ca-bundle.crt before re-running."
        warn "Or: re-run with SKIP_PLAYWRIGHT=1 to skip browser install (GUI screenshots disabled)."
        warn "Or: ask the simqa operator to pre-stage browsers (Deploy build tarball will then"
        warn "    include them) — they run:  bash perf-qa/scripts/fetch-vendor.sh"
        fail "playwright install chromium failed (see message above)"
    fi
fi

# Install OS libs needed by headless Chromium (apt only — RPM ships them).
# Runs whenever browsers are present, even if they were pre-staged — the
# system libs are separate from the browser binary.
if has_chromium "${PW_BROWSERS}" && [[ "${PKG}" == "apt" ]]; then
    log "Installing headless-Chromium OS libs via playwright install-deps"
    "${UI_INSTALL_DIR}/venv/bin/playwright" install-deps chromium || \
        warn "playwright install-deps failed; some libs may be missing"
fi

# ---- 5) systemd unit -------------------------------------------------------
log "Installing systemd unit -> ${SYSTEMD_UNIT}"
# Generate from the shipped template so port + paths are baked in.
cat > "${SYSTEMD_UNIT}" <<UNIT
[Unit]
Description=perf-qa collector UI (Flask)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${UI_INSTALL_DIR}
Environment=HOME=${PERFQA_HOME}
Environment=USER=${SERVICE_USER}
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PERFQA_SCRIPT_DIR=${SCRIPT_INSTALL_DIR}
Environment=PERFQA_BUNDLE_ROOT=${BUNDLE_DIR}
Environment=PERFQA_PORT=${LISTEN_PORT}
Environment=PLAYWRIGHT_BROWSERS_PATH=${PW_BROWSERS}
ExecStart=${UI_INSTALL_DIR}/venv/bin/python ${UI_INSTALL_DIR}/app.py
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

# ---- 5b) Self-update plumbing ---------------------------------------------
# The UI's Update button (POST /api/update inside the Flask app) re-runs
# this same installer to pull in the latest perf-qa from the canonical
# GitHub repo. The service user has no sudo by default, so we plant:
#   * /usr/local/sbin/perfqa-update — a tiny script that downloads the
#     latest tarball and re-runs install.sh from it.
#   * /etc/sudoers.d/perfqa        — NOPASSWD entry whitelisting *only*
#     that one script (not blanket sudo).
# Canonical source is the PRIVATE Simnovus-Tech/oneclick repo. Private repos
# can't be fetched unauthenticated, so the updater uses the GitHub API tarball
# endpoint with a Bearer token read from a root-only file (or PERFQA_UPDATE_TOKEN
# env). Provide the token at install time via ONECLICK_UPDATE_TOKEN; use a
# fine-grained, read-only (Contents: read) token scoped to just this repo.
UPDATE_TARBALL_URL_DEFAULT="https://api.github.com/repos/Simnovus-Tech/oneclick/tarball/main"
UPDATER_PATH="/usr/local/sbin/perfqa-update"
UPDATE_TOKEN_FILE="/etc/oneclick/update_token"

# Baked-in read token for the private repo. INTENTIONALLY EMPTY in git — the
# customer build (dist tarball) injects the real value here at build time, so a
# hand-delivered build self-authenticates with zero key handling on the customer
# side. It is never committed, so the public mirror + GitHub secret-scanning
# never see it.
UPDATE_TOKEN_BAKED=""

# Token precedence: explicit env > baked-in build value > whatever's already on
# disk (left untouched). Plant it root-only so the perfqa-update wrapper can auth.
_tok_to_plant="${ONECLICK_UPDATE_TOKEN:-${UPDATE_TOKEN_BAKED}}"
if [[ -n "${_tok_to_plant}" ]]; then
    install -d -m 0700 /etc/oneclick
    printf '%s' "${_tok_to_plant}" > "${UPDATE_TOKEN_FILE}"
    chmod 0600 "${UPDATE_TOKEN_FILE}"
    log "Stored private-repo update token -> ${UPDATE_TOKEN_FILE} (root-only 0600)"
fi

log "Installing self-update helper -> ${UPDATER_PATH}"
cat > "${UPDATER_PATH}" <<UPDATER
#!/bin/bash
# Auto-generated by OneClick install.sh. Triggered by the Update icon in
# the Flask UI (POST /api/update). Downloads the latest tarball from the
# canonical (private) GitHub repo and re-runs scripts/install.sh from it.
set -euo pipefail
TARBALL_URL="\${PERFQA_UPDATE_TARBALL:-${UPDATE_TARBALL_URL_DEFAULT}}"
TOKEN_FILE="${UPDATE_TOKEN_FILE}"

# Auth for the private repo: PERFQA_UPDATE_TOKEN env wins, else the token file.
TOKEN="\${PERFQA_UPDATE_TOKEN:-}"
[[ -z "\$TOKEN" && -r "\$TOKEN_FILE" ]] && TOKEN="\$(cat "\$TOKEN_FILE" 2>/dev/null || true)"
AUTH=()
[[ -n "\$TOKEN" ]] && AUTH=(-H "Authorization: Bearer \$TOKEN" -H "Accept: application/vnd.github+json")

TD=\$(mktemp -d -p /tmp perfqa-update-XXXXXX)
trap 'rm -rf "\$TD"' EXIT
echo "[perfqa-update] downloading \$TARBALL_URL"

# Try strict SSL first. At customer sites with a TLS-inspecting proxy,
# curl fails with SELF_SIGNED_CERT_IN_CHAIN. Retry with -k (insecure)
# in that case so the update isn't blocked by the proxy. For proper
# verification, set CURL_CA_BUNDLE=/path/to/corp-ca.pem (curl picks it
# up automatically) in /etc/systemd/system/perf-qa-ui.service.d/.
if ! curl -fsSL "\${AUTH[@]}" "\$TARBALL_URL" -o "\$TD/main.tar.gz" 2>"\$TD/curl.err"; then
    if grep -qiE 'self.signed|certificate|SSL' "\$TD/curl.err"; then
        echo "[perfqa-update] SSL verification failed (corporate proxy?) — retrying with -k (insecure)" >&2
        curl -fkSL "\${AUTH[@]}" "\$TARBALL_URL" -o "\$TD/main.tar.gz"
    else
        cat "\$TD/curl.err" >&2
        [[ -z "\$TOKEN" ]] && echo "[perfqa-update] no update token found. Repo is PRIVATE — write a read-only GitHub token to \$TOKEN_FILE (root, 0600) or set PERFQA_UPDATE_TOKEN." >&2
        exit 1
    fi
fi

tar xzf "\$TD/main.tar.gz" -C "\$TD" --strip-components=1
[[ -x "\$TD/scripts/install.sh" ]] || chmod +x "\$TD/scripts/install.sh"
exec bash "\$TD/scripts/install.sh"
UPDATER
chmod 0755 "${UPDATER_PATH}"

SUDOERS_FILE="/etc/sudoers.d/perfqa"
log "Granting ${SERVICE_USER} passwordless sudo for ${UPDATER_PATH}"
cat > "${SUDOERS_FILE}" <<SUDO
# Auto-generated by perf-qa install.sh. Lets the perf-qa-ui service
# (running as ${SERVICE_USER}) trigger a self-update via the Update icon
# WITHOUT granting it general sudo. Whitelist is intentionally narrow:
# only the perfqa-update wrapper, which re-runs this install.sh.
${SERVICE_USER} ALL=(root) NOPASSWD: ${UPDATER_PATH}
SUDO
chmod 0440 "${SUDOERS_FILE}"
# visudo -c -f catches typos before they break the whole sudoers chain
if visudo -c -f "${SUDOERS_FILE}" >/dev/null 2>&1; then
    log "sudoers entry validated"
else
    warn "sudoers entry has a syntax issue — removing to keep sudo working"
    rm -f "${SUDOERS_FILE}"
fi

systemctl daemon-reload
log "Enabling + starting perf-qa-ui"
systemctl enable --now perf-qa-ui.service
sleep 2
if systemctl is-active --quiet perf-qa-ui.service; then
    log "perf-qa-ui is ACTIVE"
else
    warn "perf-qa-ui failed to start — see: journalctl -u perf-qa-ui -n 50"
    systemctl status perf-qa-ui --no-pager || true
    exit 1
fi

# ---- 6) Report -------------------------------------------------------------
HOSTNAME_BEST=$(hostname -I 2>/dev/null | awk '{print $1}')
[[ -z "${HOSTNAME_BEST}" ]] && HOSTNAME_BEST="<host-ip>"
cat <<DONE

============================================================
  perf-qa is installed and running.
============================================================

  URL:           http://${HOSTNAME_BEST}:${LISTEN_PORT}/
  Service:       systemctl status perf-qa-ui
  Logs:          journalctl -u perf-qa-ui -f
  Config:        ${SCRIPT_INSTALL_DIR}/setup.conf
  Bundles:       ${BUNDLE_DIR}

Next steps:
  1. Open the URL in a browser.
  2. Go to the Setup tab and fill in your rack's host IPs + credentials.
  3. Go to the Collector tab, pick "LAST_RUN", click Run.

Uninstall:
  sudo systemctl disable --now perf-qa-ui
  sudo rm -f ${SYSTEMD_UNIT}
  sudo rm -rf ${SCRIPT_INSTALL_DIR} ${UI_INSTALL_DIR} ${BUNDLE_DIR} ${PERFQA_HOME}
  sudo userdel ${SERVICE_USER}
  sudo systemctl daemon-reload
DONE

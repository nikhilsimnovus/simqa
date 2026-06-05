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
log "Installing Flask + Playwright into venv"
sudo -u "${SERVICE_USER}" "${UI_INSTALL_DIR}/venv/bin/pip" install --upgrade --quiet pip
sudo -u "${SERVICE_USER}" "${UI_INSTALL_DIR}/venv/bin/pip" install --upgrade --quiet flask playwright

# Playwright browsers — only install if not already present (~150 MB download).
PW_BROWSERS="${PERFQA_HOME}/.cache/ms-playwright"
if [[ -d "${PW_BROWSERS}/chromium-"* ]]; then
    log "Playwright Chromium already present in ${PW_BROWSERS}"
else
    log "Downloading Playwright Chromium (~150 MB, one-shot)"
    sudo -u "${SERVICE_USER}" PLAYWRIGHT_BROWSERS_PATH="${PW_BROWSERS}" \
        "${UI_INSTALL_DIR}/venv/bin/playwright" install chromium
    # Install OS libs needed by headless Chromium (apt only — RPM ships them).
    if [[ "${PKG}" == "apt" ]]; then
        log "Installing headless-Chromium OS libs via playwright install-deps"
        "${UI_INSTALL_DIR}/venv/bin/playwright" install-deps chromium || \
            warn "playwright install-deps failed; some libs may be missing"
    fi
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

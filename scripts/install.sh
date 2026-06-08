#!/bin/bash
# simqa one-shot installer.
#
# Runs on a fresh Linux host (Ubuntu/Debian or RHEL/CentOS family). Installs
# OS prereqs via the system package manager (incl. Node.js 20.x), creates
# the `simqa` user, lays down the source under /opt/simqa, runs `npm ci` +
# `npm run build`, installs + starts the systemd unit on port 4100.
# Idempotent — safe to re-run.
#
# Mirrors the OneClick (perf-qa) install pattern: same updater wrapper
# layout, same sudoers shape, same systemd conventions. The Update pill in
# simqa's sidebar topbar (POST /api/update) shells out to
# /usr/local/sbin/simqa-update which re-runs this same script from the
# latest tarball pulled off GitHub.
#
# Usage:
#   tar xzf simqa-deploy-<ts>.tar.gz   # OR clone the simqa repo
#   cd simqa
#   sudo bash scripts/install.sh
#
# Tunable env knobs (all optional):
#   SIMQA_PORT          listen port (default 4100; avoids OneClick on 4000)
#   SIMQA_USER          service user (default simqa)
#   SIMQA_HOME          install root (default /opt/simqa)
#   SIMQA_UPDATE_TARBALL  GitHub tarball URL for /api/update
#                         (default https://github.com/nikhilsimnovus/simqa
#                          /archive/refs/heads/main.tar.gz)

set -euo pipefail

# ---- Sanity ----------------------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
    echo "ERROR: install.sh must run as root (use sudo)" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(dirname "${SCRIPT_DIR}")"
[[ -f "${SRC_ROOT}/package.json" ]] || {
    echo "ERROR: expected ${SRC_ROOT}/package.json — running from wrong dir?" >&2
    exit 1
}

# ---- Knobs -----------------------------------------------------------------
SERVICE_USER="${SIMQA_USER:-simqa}"
SERVICE_GROUP="${SIMQA_GROUP:-${SERVICE_USER}}"
SIMQA_HOME="${SIMQA_HOME:-/opt/simqa}"
LISTEN_PORT="${SIMQA_PORT:-4100}"
SYSTEMD_UNIT="/etc/systemd/system/simqa.service"
UPDATE_TARBALL_URL_DEFAULT="https://github.com/nikhilsimnovus/simqa/archive/refs/heads/main.tar.gz"

log() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1) Detect distro + install OS prereqs --------------------------------
log "Detecting package manager"
if   command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf     >/dev/null 2>&1; then PKG=dnf
elif command -v yum     >/dev/null 2>&1; then PKG=yum
else fail "no supported package manager (need apt/dnf/yum)"
fi

PREREQS_APT="curl ca-certificates tar gzip git python3 build-essential openssh-client sshpass"
PREREQS_RPM="curl ca-certificates tar gzip git python3 gcc gcc-c++ make openssh-clients sshpass"

case "${PKG}" in
  apt)
    log "apt-get update + installing prereqs"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${PREREQS_APT}
    # NodeSource Node.js 20.x — Next.js 15 needs ≥18.18.
    if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)" 2>/dev/null; then
      log "Installing Node.js 20.x via NodeSource"
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
    else
      log "Node $(node -v) already installed — skipping"
    fi
    ;;
  dnf|yum)
    ${PKG} install -y -q ${PREREQS_RPM}
    if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)" 2>/dev/null; then
      log "Installing Node.js 20.x via NodeSource (rpm)"
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
      ${PKG} install -y -q nodejs
    fi
    ;;
esac

command -v node >/dev/null 2>&1 || fail "node still not on PATH after install"
command -v npm  >/dev/null 2>&1 || fail "npm still not on PATH after install"

# ---- 2) Service user + dirs ----------------------------------------------
if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    log "User ${SERVICE_USER} already exists"
else
    log "Creating user ${SERVICE_USER} (home=${SIMQA_HOME})"
    useradd --system --create-home --home "${SIMQA_HOME}" --shell /bin/bash "${SERVICE_USER}"
fi

install -d -m 0755 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${SIMQA_HOME}"

# ---- 3) Lay down the source tree under /opt/simqa -------------------------
log "Syncing source from ${SRC_ROOT} -> ${SIMQA_HOME}"
# Use rsync if available (preserves perms, faster on re-runs), else tar pipe.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude '.next' \
    --exclude 'dist/build-reports' --exclude 'dist/ui-runs' \
    --exclude 'data' --exclude '.DS_Store' \
    "${SRC_ROOT}/" "${SIMQA_HOME}/"
else
  ( cd "${SRC_ROOT}" && tar --exclude=.git --exclude=node_modules --exclude=.next \
                            --exclude=dist/build-reports --exclude=dist/ui-runs \
                            --exclude=data \
                            -cf - . ) | tar -xf - -C "${SIMQA_HOME}"
fi

# Preserve any existing inventory.yaml on re-install — otherwise the
# admin's lab config gets clobbered every update. The shipped tree carries
# inventory.example.yaml so the first install has a starting point.
if [[ -f "${SIMQA_HOME}/inventory.yaml" ]]; then
  log "Keeping existing ${SIMQA_HOME}/inventory.yaml"
elif [[ -f "${SIMQA_HOME}/inventory.example.yaml" ]]; then
  log "Seeding ${SIMQA_HOME}/inventory.yaml from inventory.example.yaml"
  install -m 0644 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" \
    "${SIMQA_HOME}/inventory.example.yaml" "${SIMQA_HOME}/inventory.yaml"
fi

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${SIMQA_HOME}"

# ---- 4) npm install + production build -----------------------------------
log "Running npm ci (production deps + dev deps for build)"
su -s /bin/bash -c "cd '${SIMQA_HOME}' && npm ci --no-audit --no-fund" "${SERVICE_USER}"

log "Running next build"
su -s /bin/bash -c "cd '${SIMQA_HOME}' && npm run build" "${SERVICE_USER}"

# ---- 5) Systemd unit ------------------------------------------------------
log "Writing systemd unit to ${SYSTEMD_UNIT}"
cat > "${SYSTEMD_UNIT}" <<UNIT
[Unit]
Description=simqa — QA Ka BAAP, Next.js UI for Simnovator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${SIMQA_HOME}
Environment=PORT=${LISTEN_PORT}
Environment=NODE_ENV=production
Environment=HOSTNAME=0.0.0.0
# `npm run start` invokes scripts/run.cjs which reads PORT from env.
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=5
# NB: do NOT set NoNewPrivileges=true — sudo needs the setuid bit, and
# this unit invokes sudo -n /usr/local/sbin/simqa-update from the
# /api/update handler. NoNewPrivileges blocks that escalation.
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable simqa.service >/dev/null
log "Restarting simqa.service (listening on :${LISTEN_PORT})"
systemctl restart simqa.service

# ---- 5b) Self-update plumbing --------------------------------------------
# The UI's Update pill (POST /api/update inside the Next.js app) re-runs
# this same installer to pull in the latest simqa from the canonical
# GitHub repo. The service user has no sudo by default, so we plant:
#   * /usr/local/sbin/simqa-update — a tiny script that downloads the
#     latest tarball and re-runs scripts/install.sh from it.
#   * /etc/sudoers.d/simqa         — NOPASSWD entry whitelisting *only*
#     that one script (not blanket sudo).
UPDATER_PATH="/usr/local/sbin/simqa-update"
log "Installing self-update helper -> ${UPDATER_PATH}"
cat > "${UPDATER_PATH}" <<UPDATER
#!/bin/bash
# Auto-generated by simqa scripts/install.sh. Triggered by the Update
# pill in the simqa sidebar topbar (POST /api/update). Downloads the
# latest tarball from the canonical GitHub repo and re-runs
# scripts/install.sh from it.
set -euo pipefail
TARBALL_URL="\${SIMQA_UPDATE_TARBALL:-${UPDATE_TARBALL_URL_DEFAULT}}"
TD=\$(mktemp -d -p /tmp simqa-update-XXXXXX)
trap 'rm -rf "\$TD"' EXIT
echo "[simqa-update] downloading \$TARBALL_URL"

# Strict SSL first. At customer sites with a TLS-inspecting proxy curl
# trips SELF_SIGNED_CERT_IN_CHAIN; retry with -k in that case so the
# update isn't blocked. For proper verification, set
# CURL_CA_BUNDLE=/path/to/corp-ca.pem in the systemd unit drop-in.
if ! curl -fsSL "\$TARBALL_URL" -o "\$TD/main.tar.gz" 2>"\$TD/curl.err"; then
    if grep -qiE 'self.signed|certificate|SSL' "\$TD/curl.err"; then
        echo "[simqa-update] SSL verification failed (corporate proxy?) — retrying with -k" >&2
        curl -fkSL "\$TARBALL_URL" -o "\$TD/main.tar.gz"
    else
        cat "\$TD/curl.err" >&2
        exit 1
    fi
fi

tar xzf "\$TD/main.tar.gz" -C "\$TD" --strip-components=1
[[ -x "\$TD/scripts/install.sh" ]] || chmod +x "\$TD/scripts/install.sh"
exec bash "\$TD/scripts/install.sh"
UPDATER
chmod 0755 "${UPDATER_PATH}"

SUDOERS_FILE="/etc/sudoers.d/simqa"
log "Granting ${SERVICE_USER} passwordless sudo for ${UPDATER_PATH}"
cat > "${SUDOERS_FILE}" <<SUDO
# Auto-generated by simqa install.sh. Allows the simqa service user to
# trigger ONLY the self-update wrapper without entering a password —
# nothing else.
${SERVICE_USER} ALL=(root) NOPASSWD: ${UPDATER_PATH}
Defaults!${UPDATER_PATH} env_keep += "SIMQA_UPDATE_TARBALL"
SUDO
chmod 0440 "${SUDOERS_FILE}"
# Validate so a malformed line doesn't lock us out of sudo entirely.
if ! visudo -cf "${SUDOERS_FILE}" >/dev/null; then
    rm -f "${SUDOERS_FILE}"
    fail "sudoers entry was invalid; removed ${SUDOERS_FILE} for safety"
fi

# ---- 6) Wait for HTTP to come up ------------------------------------------
log "Waiting for simqa to answer on :${LISTEN_PORT}"
for i in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${LISTEN_PORT}/api/bulk-tests/status"; then
        log "simqa is up after $((i*2))s — http://$(hostname -I | awk '{print $1}'):${LISTEN_PORT}"
        exit 0
    fi
    sleep 2
done
warn "simqa did not answer within 60s — check 'journalctl -u simqa -n 50 --no-pager'"
exit 1

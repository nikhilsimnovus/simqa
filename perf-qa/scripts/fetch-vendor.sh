#!/bin/bash
# Pre-stage the Playwright browser binaries that the customer install needs.
#
# Run this ONCE on whichever host generates the deploy tarball (typically
# the simqa host). The browsers land under perf-qa/vendor/playwright-browsers/
# and get picked up by the /api/perf-qa/deploy-build route + included in the
# tarball so the customer install never has to download them.
#
# Re-run after a Playwright version bump to refresh.
#
# Usage:
#   bash perf-qa/scripts/fetch-vendor.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PERF_QA_ROOT="$(dirname "${SCRIPT_DIR}")"
VENDOR_DIR="${PERF_QA_ROOT}/vendor/playwright-browsers"

log() { printf '\033[1;34m[fetch-vendor]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

log "Vendor dir: ${VENDOR_DIR}"
mkdir -p "${VENDOR_DIR}"

# Two ways to drive `playwright install`:
#   1. The Node Playwright (npx) — preferred when simqa is the build host
#      (it has playwright as a devDependency already).
#   2. A Python venv with the playwright package — fallback.
# Either way, the browsers land in PLAYWRIGHT_BROWSERS_PATH and are
# cross-compatible (same binaries used by both language clients).
if command -v npx >/dev/null 2>&1 && [[ -f "${PERF_QA_ROOT}/../package.json" ]]; then
    log "Using Node Playwright via npx"
    cd "${PERF_QA_ROOT}/.."
    PLAYWRIGHT_BROWSERS_PATH="${VENDOR_DIR}" npx --yes playwright install chromium
elif command -v python3 >/dev/null 2>&1; then
    log "Using Python Playwright via a throwaway venv"
    TMPVENV="$(mktemp -d)"
    trap 'rm -rf "${TMPVENV}"' EXIT
    python3 -m venv "${TMPVENV}/venv"
    "${TMPVENV}/venv/bin/pip" install --quiet --upgrade pip playwright
    PLAYWRIGHT_BROWSERS_PATH="${VENDOR_DIR}" \
        "${TMPVENV}/venv/bin/playwright" install chromium
else
    fail "neither npx nor python3 found — install one and re-run"
fi

log ""
log "Done. Vendored browsers:"
du -sh "${VENDOR_DIR}"/* 2>/dev/null | sed 's|^|  |'
log ""
log "Next: the deploy-build API will now include vendor/playwright-browsers/"
log "in every tarball. Customer install will skip the Chromium download."

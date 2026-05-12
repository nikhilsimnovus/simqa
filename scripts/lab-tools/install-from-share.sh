#!/usr/bin/env bash
# install-from-share.sh — one-shot installer for QA Ka BAAP from a cloud share link.
#
# Designed for customer sites where:
#   • The tarball is hosted on SharePoint / OneDrive / Dropbox / Google Drive
#   • Outbound HTTPS to that provider works, but other things might be blocked
#   • Port 4000 might be firewalled (we default to 8080 — override with PORT=<n>)
#   • No system Chrome — we pass --skip-playwright (Build Check + UI Tests need
#     a browser, but everything else works without one)
#
# Usage:
#   bash install-from-share.sh '<SHARE-URL>'
#   PORT=9000 bash install-from-share.sh '<SHARE-URL>'
#   INSTALL_DIR=/opt/simqa bash install-from-share.sh '<SHARE-URL>'
#
# What it does:
#   1. Rewrites the share URL to its direct-download form (&download=1, ?dl=1, etc.)
#   2. wgets the tarball with a Mozilla User-Agent (share hosts reject default wget UA)
#   3. Verifies the download is actually a gzip tarball, not an HTML login page
#   4. Extracts into $INSTALL_DIR/qakabaap-<version>/ (auto-detects dirname)
#   5. Copies inventory.yaml + .env.local from a previous install if present
#   6. Runs install.cjs --skip-playwright --port $PORT --no-prompt
#   7. Starts `npm run dev` so the user can open http://<box>:<port> immediately
#
# If you only want steps 1-6 and not the launch, set START=0:
#   START=0 bash install-from-share.sh '<URL>'

set -euo pipefail

# ── 0. Args + defaults ────────────────────────────────────────────────────
URL="${1:-}"
if [[ -z "$URL" ]]; then
  cat <<USAGE >&2
Usage: $0 '<sharepoint-or-onedrive-or-dropbox-or-drive-share-url>'

Env vars:
  PORT          — port to run on. Default: 8080.
  INSTALL_DIR   — parent dir to install under. Default: \$HOME/simqa.
  START         — 1 to launch \`npm run dev\` after install, 0 to stop after.
                  Default: 1.

Example:
  $0 'https://simnovus-my.sharepoint.com/:u:/p/nikhil/IQDXyZ...?e=AbCdEf'
USAGE
  exit 2
fi

PORT="${PORT:-8080}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/simqa}"
START="${START:-1}"

# Colours (TTY only).
if [[ -t 1 ]]; then
  C_BOLD='\033[1m'; C_DIM='\033[2m'; C_GREEN='\033[32m'; C_RED='\033[31m'
  C_YELLOW='\033[33m'; C_CYAN='\033[36m'; C_RESET='\033[0m'
else
  C_BOLD=''; C_DIM=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_CYAN=''; C_RESET=''
fi
say()  { printf '%b\n' "${C_DIM}→${C_RESET} $*"; }
ok()   { printf '%b\n' "${C_GREEN}✓${C_RESET} $*"; }
fail() { printf '%b\n' "${C_RED}✗ $*${C_RESET}" >&2; exit 1; }
warn() { printf '%b\n' "${C_YELLOW}!${C_RESET} $*"; }

# ── 1. URL rewrite for direct download ────────────────────────────────────
# We mirror the logic in src/lib/shareUrls.ts so the on-box wget gets the
# right URL regardless of which cloud the customer is using.
rewrite_share_url() {
  local in="$1"
  local host
  host=$(echo "$in" | sed -E 's,^https?://([^/]+)/.*,\1,' | tr '[:upper:]' '[:lower:]')
  case "$host" in
    *sharepoint.com|*onedrive.live.com|*1drv.ms)
      # Append &download=1 if absent
      if [[ "$in" == *download=1* ]]; then echo "$in"; return; fi
      if [[ "$in" == *\?* ]]; then echo "${in}&download=1"; else echo "${in}?download=1"; fi
      ;;
    *dropbox.com)
      if [[ "$in" == *dl=1* ]]; then echo "$in"; return; fi
      if [[ "$in" == *\?* ]]; then echo "${in}&dl=1"; else echo "${in}?dl=1"; fi
      ;;
    *drive.google.com|*docs.google.com)
      local id
      id=$(echo "$in" | sed -nE 's,.*/file/d/([^/]+).*,\1,p')
      if [[ -z "$id" ]]; then
        id=$(echo "$in" | sed -nE 's,.*[?&]id=([^&]+).*,\1,p')
      fi
      if [[ -n "$id" ]]; then
        echo "https://drive.google.com/uc?export=download&id=$id"
      else
        echo "$in"
      fi
      ;;
    *)
      echo "$in"
      ;;
  esac
}

DL_URL=$(rewrite_share_url "$URL")
if [[ "$DL_URL" != "$URL" ]]; then
  say "Rewrote share URL for direct download:"
  say "  ${C_DIM}$DL_URL${C_RESET}"
fi

# ── 2. Sanity: required tools ─────────────────────────────────────────────
for tool in wget tar file node npm; do
  command -v "$tool" >/dev/null || fail "$tool not installed. apt install $tool"
done
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if (( NODE_MAJOR < 18 )); then
  fail "Node 18+ required, you have $(node --version)"
fi

# ── 3. Download to a staging file ─────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
STAGE="$INSTALL_DIR/.staging-$$"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

TARBALL="$STAGE/qakabaap.tar.gz"
say "Downloading tarball..."
say "  ${C_DIM}from: $DL_URL${C_RESET}"
say "  ${C_DIM}to:   $TARBALL${C_RESET}"

# --content-disposition: SharePoint sends the real filename in Content-Disposition.
# We capture it but use our -O target name; --content-disposition without -O would
# rename to whatever the server sends, which is unpredictable.
wget --no-check-certificate -q --show-progress \
     -U "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" \
     -O "$TARBALL" \
     "$DL_URL" \
  || fail "wget failed. Check the URL is correct + the share is set to 'Anyone with the link'."

if ! file "$TARBALL" | grep -qE 'gzip|tar archive'; then
  printf '%b\n' "${C_RED}✗ Download is NOT a tarball.${C_RESET}" >&2
  warn "First 300 bytes of what we got:"
  head -c 300 "$TARBALL" >&2; echo "" >&2
  warn "Common causes:"
  warn "  • Share permission isn't 'Anyone with the link' (SharePoint returns an HTML sign-in page)"
  warn "  • Wrong URL — verify by pasting it into a browser"
  warn "  • Provider isn't recognised — manually add &download=1 (SharePoint) or ?dl=1 (Dropbox)"
  exit 1
fi
SIZE=$(stat -c%s "$TARBALL" 2>/dev/null || stat -f%z "$TARBALL")
ok "Downloaded: $SIZE bytes ($(file -b "$TARBALL" | head -c 80))"

# ── 4. Detect the version-stamped dir inside the tarball ──────────────────
INNER_DIR=$(tar -tzf "$TARBALL" | head -1 | cut -d/ -f1)
if [[ -z "$INNER_DIR" ]]; then
  fail "Could not determine inner directory name from tarball table of contents."
fi
ok "Tarball contains: $INNER_DIR/"

TARGET="$INSTALL_DIR/$INNER_DIR"
if [[ -d "$TARGET" ]]; then
  warn "Target already exists: $TARGET"
  warn "Removing the old copy (inventory.yaml + .env.local will be preserved before removal)."
  # Stash the keepers from the existing target.
  for keeper in inventory.yaml .env.local; do
    if [[ -f "$TARGET/$keeper" ]]; then
      cp -p "$TARGET/$keeper" "$STAGE/$keeper.from-target"
      say "  preserved $TARGET/$keeper"
    fi
  done
  rm -rf "$TARGET"
fi

# ── 5. Extract ─────────────────────────────────────────────────────────────
say "Extracting into $INSTALL_DIR/ ..."
tar -zxf "$TARBALL" -C "$INSTALL_DIR"
[[ -d "$TARGET" ]] || fail "Extraction did not produce $TARGET as expected."
ok "Extracted: $TARGET"

# ── 6. Inventory + env inheritance from the most recent previous install ──
# We look at: keepers from the just-overwritten target first, then the most-
# recently-modified previous qakabaap-*/ dir under $INSTALL_DIR.
for keeper in inventory.yaml .env.local; do
  src=""
  if [[ -f "$STAGE/$keeper.from-target" ]]; then
    src="$STAGE/$keeper.from-target"
  else
    # Newest qakabaap-* dir other than the one we just extracted.
    prev=$(ls -dt "$INSTALL_DIR"/qakabaap-*/ 2>/dev/null | grep -v "$INNER_DIR/" | head -1 || true)
    if [[ -n "$prev" && -f "${prev}${keeper}" ]]; then src="${prev}${keeper}"; fi
  fi
  if [[ -n "$src" && -f "$src" ]]; then
    cp -p "$src" "$TARGET/$keeper"
    ok "Inherited $keeper from previous install ($src)"
  fi
done

# ── 7. Run installer ──────────────────────────────────────────────────────
cd "$TARGET"
say "Running install.cjs (--skip-playwright --port $PORT --no-prompt)..."
node install.cjs --skip-playwright --port "$PORT" --no-prompt

# ── 8. Launch (optional) ──────────────────────────────────────────────────
if [[ "$START" == "1" ]]; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost)
  printf '\n%b%bQA Ka BAAP installed at:%b %s\n' "$C_GREEN" "$C_BOLD" "$C_RESET" "$TARGET"
  printf '%bStarting dev server on port %s...%b\n' "$C_DIM" "$PORT" "$C_RESET"
  printf '%bOpen:%b %bhttp://%s:%s%b\n\n' "$C_DIM" "$C_RESET" "$C_CYAN" "$IP" "$PORT" "$C_RESET"
  exec npm run dev
else
  printf '\n%b%bInstalled, not started (START=0).%b\n' "$C_GREEN" "$C_BOLD" "$C_RESET"
  printf 'Next: %bcd %s && npm run dev%b\n' "$C_BOLD" "$TARGET" "$C_RESET"
fi

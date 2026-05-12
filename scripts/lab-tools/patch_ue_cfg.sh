#!/usr/bin/env bash
# patch_ue_cfg.sh — watch for /root/ue/config/ue.cfg and swap the SDR
# rf_driver block with an #include of the IP loopback config (rf_driver/config.cfg).
#
# Designed for lab UE-sim boxes that DO NOT have SDR hardware. App Manager
# generates ue.cfg with an SDR-style rf_driver block on every test execution;
# this watcher rewrites it in place before lteue opens it, so the test runs
# against the Amarisoft IP loopback frontend instead of complaining about
# missing /dev/sdr0.
#
# Deployed + supervised by simqa's Tools page (/tools). Also runnable
# standalone:
#   sudo bash patch_ue_cfg.sh
#
# Stop:
#   sudo pkill -f patch_ue_cfg.sh
#
# All edited cfgs are backed up alongside as ue.cfg.orig.<unix-ts> so you can
# diff what App Manager produced vs what got handed to lteue.

set -euo pipefail

CFG=/root/ue/config/ue.cfg
DIR=/root/ue/config
INCLUDE_LINE='#include "rf_driver/config.cfg"'

command -v inotifywait >/dev/null || { echo "FATAL: inotifywait not installed (apt install -y inotify-tools)"; exit 1; }
command -v python3     >/dev/null || { echo "FATAL: python3 not installed"; exit 1; }

echo "[patch_ue_cfg] $(date -u +%FT%TZ)  start  watching $CFG"

# Watch the directory rather than the file: App Manager may atomically rename
# (tmp + rename → ue.cfg), which would invalidate a file-level watch.
inotifywait -m -q --format '%e %f' -e close_write,moved_to "$DIR" |
while read -r ev file; do
  [[ "$file" == "ue.cfg" ]] || continue
  echo "[patch_ue_cfg] $(date -u +%FT%TZ)  event=$ev  patching $CFG"

  # Keep an .orig copy for diff / debug — sortable by timestamp.
  cp -p "$CFG" "$CFG.orig.$(date +%s)" 2>/dev/null || true

  python3 - "$CFG" "$INCLUDE_LINE" <<'PY'
import re, sys
path, include_line = sys.argv[1], sys.argv[2]

with open(path) as f:
    src = f.read()

# 1) Strip the SDR rf_driver block. The cfg uses Amarisoft's JSON-with-CPP
#    syntax — rf_driver: { ... } can contain nested braces (rf_ports: [{ ... }]),
#    so we do brace-balanced extraction rather than a naive regex.
def strip_rf_driver(s):
    m = re.search(r'rf_driver\s*:\s*\{', s)
    if not m: return s, False
    i = m.end() - 1   # position of the opening {
    depth = 0
    j = i
    in_str = False
    while j < len(s):
        c = s[j]
        if c == '"' and (j == 0 or s[j-1] != '\\'):
            in_str = not in_str
        elif not in_str:
            if c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    # Eat trailing comma + whitespace
                    k = j + 1
                    while k < len(s) and s[k] in ' \t,': k += 1
                    # Eat one trailing newline if present
                    if k < len(s) and s[k] == '\n': k += 1
                    return s[:m.start()] + include_line + '\n' + s[k:], True
        j += 1
    return s, False

src, did_strip = strip_rf_driver(src)
if not did_strip and include_line not in src:
    # No existing rf_driver block and no include yet — prepend.
    src = include_line + '\n' + src

# 2) Strip top-level tx_gain: / rx_gain: lines (the include provides them).
src = re.sub(r'^\s*tx_gain\s*:.*$\n?', '', src, flags=re.M)
src = re.sub(r'^\s*rx_gain\s*:.*$\n?', '', src, flags=re.M)

with open(path, 'w') as f:
    f.write(src)
PY

  echo "[patch_ue_cfg] $(date -u +%FT%TZ)  done"
done

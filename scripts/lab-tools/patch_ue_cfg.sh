#!/usr/bin/env bash
# patch_ue_cfg.sh — watch /root/ue/config/ue.cfg and rewrite the SDR
# rf_driver block to the Amarisoft IP loopback driver, so lab UE-sim
# boxes without SDR hardware can run tests end-to-end.
#
# Strategy: keep the IP rf_driver definition in a single, externally
# maintained file (/root/ue/config/rf_driver/config.cfg), and on every
# write to ue.cfg replace whatever rf_driver block App Manager wrote with
# an `#include "rf_driver/config.cfg"` directive that the Amarisoft
# parser expands at load time. That way the IP config has ONE source of
# truth and this watcher only does deletion + one-line injection.
#
# Deployed + supervised by simqa's Tools page (/tools). Also runnable
# standalone:
#   sudo bash patch_ue_cfg.sh
#
# Stop:
#   sudo pkill -f patch_ue_cfg.sh
#
# History:
#  - v3 (2026-05-13): drop the inline IP block experiment from v2 and go
#    back to the include-based approach. v2's inline block was missing
#    fields the real rf_driver/config.cfg provides (rf_ports etc.), so
#    lteue still failed with "Could not start LTE" even after patching.
#    The include path keeps rf_driver/config.cfg as the single source of
#    truth — edit one file, all testcases pick up the change.
#  - v2 (2026-05-13): handle JSON-style cfgs (App Manager 4.x writes
#    "rf_driver": { ... } with quotes; the v1 regex expected bare-key
#    style and silently no-op'd, leaving the SDR block in place); add an
#    idempotency check so a re-fire on already-patched cfg skips the
#    rewrite (was causing 90+ patches per test from an inotify feedback
#    loop, each one logging close_write,close from our own write).

set -euo pipefail

CFG=/root/ue/config/ue.cfg
DIR=/root/ue/config
# Bare-key Amarisoft include directive (NOT cpp-style `#include`). The
# cpp form is textually pasted by the preprocessor AND shifts the
# parser's relative-path base into the included file's directory, which
# breaks downstream relative paths in ue.cfg — e.g. `tun_setup_script:
# "ue-ifup"` ends up resolving as `config/rf_driver/ue-ifup` instead of
# `config/ue-ifup`, so lteue can't bring up the tun interface. The
# bare-key `include "...",` form is a regular cfg object member with a
# trailing comma; the parser merges the file's content as additional
# members without touching the relative-path base. Reference: the
# canonical Amarisoft cfg template, which uses this exact syntax inside
# the top-level object.
INCLUDE_LINE='include "rf_driver/config.cfg",'

command -v inotifywait >/dev/null || { echo "FATAL: inotifywait not installed (apt install -y inotify-tools)"; exit 1; }
command -v python3     >/dev/null || { echo "FATAL: python3 not installed"; exit 1; }

echo "[patch_ue_cfg] $(date -u +%FT%TZ)  start  watching $CFG (rf_driver source: $DIR/rf_driver/config.cfg)"

# Watch the directory rather than the file: App Manager may atomically
# rename (tmp + rename → ue.cfg), which would invalidate a file-level
# watch.
inotifywait -m -q --format '%e %f' -e close_write,moved_to "$DIR" |
while read -r ev file; do
  [[ "$file" == "ue.cfg" ]] || continue

  # Idempotency check (cheap — runs before we log/backup).
  # Skip if the file already has the include AND no remaining SDR refs.
  # This prevents the inotify feedback loop where each of our own writes
  # fires another close_write event.
  if grep -qF "$INCLUDE_LINE" "$CFG" 2>/dev/null \
     && ! grep -q '"rf_driver"[[:space:]]*:' "$CFG" 2>/dev/null \
     && ! grep -q 'dev0=/dev/sdr0' "$CFG" 2>/dev/null \
     && ! grep -q '^[[:space:]]*"rx_gain"' "$CFG" 2>/dev/null \
     && ! grep -q '^[[:space:]]*"tx_gain"' "$CFG" 2>/dev/null; then
    # already patched — quietly do nothing
    continue
  fi

  echo "[patch_ue_cfg] $(date -u +%FT%TZ)  event=$ev  patching $CFG"

  # Snapshot what App Manager wrote for diff/debug.
  cp -p "$CFG" "$CFG.orig.$(date +%s%N)" 2>/dev/null || true

  python3 - "$CFG" "$INCLUDE_LINE" <<'PY'
import re, sys
path, include_line = sys.argv[1], sys.argv[2]

with open(path) as f:
    src = f.read()

# ── helpers ────────────────────────────────────────────────────────────
def find_balanced(s, start_idx, open_ch, close_ch):
    """Given index of an opening bracket char, return index AFTER the
    matching close bracket. Handles nested brackets + quoted strings.
    Returns -1 if not balanced."""
    if start_idx >= len(s) or s[start_idx] != open_ch:
        return -1
    depth = 0
    i = start_idx
    in_str = False
    while i < len(s):
        c = s[i]
        if c == '"' and (i == 0 or s[i-1] != '\\'):
            in_str = not in_str
        elif not in_str:
            if c == open_ch:
                depth += 1
            elif c == close_ch:
                depth -= 1
                if depth == 0:
                    return i + 1
        i += 1
    return -1

def strip_field(s, field_name, open_ch, close_ch):
    """Strip the first occurrence of `field_name: {...}` or
    `field_name: [...]`. Handles BOTH bare-key (rf_driver:) and
    JSON-quoted-key ("rf_driver":) styles. Eats one trailing
    comma+whitespace+newline so the surrounding cfg stays well-formed."""
    # re.escape the open char — '[' opens a character class, '{' is a
    # quantifier delimiter; naively concatenating with a backslash before
    # them produced "unterminated character set" errors.
    pattern = r'"?' + re.escape(field_name) + r'"?\s*:\s*' + re.escape(open_ch)
    m = re.search(pattern, s)
    if not m:
        return s, False
    end = find_balanced(s, m.end() - 1, open_ch, close_ch)
    if end < 0:
        return s, False
    k = end
    while k < len(s) and s[k] in ' \t,': k += 1
    if k < len(s) and s[k] == '\n': k += 1
    return s[:m.start()] + s[k:], True

# ── strip the SDR rf_driver + tx_gain + rx_gain blocks ────────────────
src, _ = strip_field(src, 'rf_driver', '{', '}')
src, _ = strip_field(src, 'tx_gain',  '[', ']')
src, _ = strip_field(src, 'rx_gain',  '[', ']')

# ── inject the include directive INSIDE the top-level JSON object ─────
#     (single source of truth: /root/ue/config/rf_driver/config.cfg on
#     disk, externally maintained).
#
# CRITICAL: the include must land INSIDE the JSON `{ ... }`, not before
# it. The Amarisoft `#include` directive is cpp-style — its content is
# textually expanded at parse time. If we put the include OUTSIDE the
# object, the expanded `rf_driver: { ... } tx_gain: ... rx_gain: ...`
# ends up as bare top-level statements followed by a JSON object,
# which lteue rejects with "expecting property name" at line 2 col 1.
# Putting it RIGHT AFTER the `{` makes the expansion land as
# additional bare-key members of the object — which lteue's parser
# accepts (it's permissive about mixing quoted + bare keys).
if include_line not in src:
    # Find the first '{' that opens the top-level JSON object (skipping
    # whitespace and C-style / line comments).
    i = 0
    while i < len(src):
        c = src[i]
        if c.isspace():
            i += 1; continue
        if c == '/' and i + 1 < len(src) and src[i+1] == '/':
            nl = src.find('\n', i); i = nl + 1 if nl >= 0 else len(src); continue
        if c == '/' and i + 1 < len(src) and src[i+1] == '*':
            end = src.find('*/', i + 2); i = end + 2 if end >= 0 else len(src); continue
        break
    if i < len(src) and src[i] == '{':
        # `include "...",` already carries its own trailing comma — it's
        # a regular object member that separates from the next property
        # ("log_options": ...) via that comma. We only inject the literal
        # line + a newline.
        src = src[:i+1] + '\n  ' + include_line + '\n' + src[i+1:].lstrip('\n')
    else:
        # Fallback: bare-key cfg with no outer { } — original v1 behaviour.
        src = include_line + '\n' + src

with open(path, 'w') as f:
    f.write(src)
PY

  echo "[patch_ue_cfg] $(date -u +%FT%TZ)  done"
done

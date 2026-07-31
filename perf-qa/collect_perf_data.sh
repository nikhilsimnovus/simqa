#!/usr/bin/env bash
# =============================================================================
# collect_perf_data.sh
# Portable performance-data collector for UESIM / Simnovator / callbox / app-server.
#
# Usage:
#   ./collect_perf_data.sh [path/to/setup.conf]
#   (defaults to ./setup.conf if no argument is given)
#
# Design:
#   - Reads everything from setup.conf. Nothing is hard-coded.
#   - Defensive: missing files/commands are SKIPPED and recorded, never fatal.
#   - Writes a timestamped bundle dir + MANIFEST.txt + collect.log, then tars it.
#   - Safe to run on any of the roles; toggles in setup.conf decide what runs.
# =============================================================================
set -uo pipefail

# ---------------------------------------------------------------------------
# Load config
#   Resolution order:
#     1. $1 if given                          (explicit caller-supplied path)
#     2. <script's own folder>/setup.conf     (so `bash /path/to/collect_perf_data.sh` works from anywhere)
#     3. ./setup.conf                         (current working directory)
#   If none of the above exist, error out with the paths tried.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${1:-}" ]]; then
    CONF="$1"
elif [[ -f "${SCRIPT_DIR}/setup.conf" ]]; then
    CONF="${SCRIPT_DIR}/setup.conf"
elif [[ -f "./setup.conf" ]]; then
    CONF="./setup.conf"
else
    {
      echo "ERROR: no setup.conf found. Tried:"
      echo "  - <arg>             (not provided)"
      echo "  - ${SCRIPT_DIR}/setup.conf"
      echo "  - $(pwd)/setup.conf"
      echo
      echo "Usage: $0 [path/to/setup.conf]"
      echo "Place setup.conf next to the script, run from its folder, or pass an explicit path."
    } >&2
    exit 1
fi
if [[ ! -f "$CONF" ]]; then
    echo "ERROR: config file not found: $CONF" >&2
    exit 1
fi
echo "[setup] using config: $CONF" >&2
# shellcheck disable=SC1090
source "$CONF"

# Test case default: if the conf doesn't set TEST_CASE_NAME (or leaves it
# blank), use LAST_RUN so the REST section auto-discovers the most recent
# executed testcase from the GUI's footer endpoint.
: "${TEST_CASE_NAME:=LAST_RUN}"

# ---------------------------------------------------------------------------
# Ad-hoc time-window mode
#   If LOOKBACK_MINUTES is set (positive integer), skip REST iter resolution
#   and just collect everything from now-N minutes through now. Useful when
#   there's no specific test case to anchor against — e.g. "something just
#   went sideways, grab the last hour". The REST block sees START/END already
#   populated and skips its own resolution; container/iperf logs use this
#   window for --since/--until slicing. TEST_CASE_NAME becomes "lookback_<N>m"
#   so the bundle is obvious in the Logs tab.
# ---------------------------------------------------------------------------
LOOKBACK_MINUTES="${LOOKBACK_MINUTES:-}"
if [[ -n "$LOOKBACK_MINUTES" && "$LOOKBACK_MINUTES" =~ ^[0-9]+$ && "$LOOKBACK_MINUTES" -gt 0 ]]; then
    END="$(date +%s)"
    START="$((END - LOOKBACK_MINUTES * 60))"
    TEST_CASE_NAME="lookback_${LOOKBACK_MINUTES}m"
    LOOKBACK_ACTIVE=1
    echo "[setup] LOOKBACK mode: last ${LOOKBACK_MINUTES} min (START=${START} END=${END})" >&2
else
    LOOKBACK_ACTIVE=0
fi

# Defaults for anything the conf might omit. Bundle dir matches the Flask UI's
# BUNDLE_ROOT (= /var/lib/perf-qa/bundles) so a missing/blank OUTPUT_DIR in
# setup.conf still produces a bundle the UI can find. Pre-v1.0.4 this defaulted
# to /tmp/perf_collect, causing "Report FAIL — No bundle produced" even though
# the bundle was written successfully (just to the wrong place).
: "${OUTPUT_DIR:=/var/lib/perf-qa/bundles}"
: "${COLLECTION_LABEL:=perftest}"
: "${COLLECT_UE:=1}"; : "${COLLECT_SIMNOVATOR:=1}"
: "${COLLECT_CALLBOX:=1}"; : "${COLLECT_APP_SERVER:=1}"; : "${COLLECT_REST_API:=1}"
: "${UESIM_LOG_MAX_MB:=200}"
: "${DOCKER_LOG_TAIL:=20000}"
: "${SIM_API_AUTH_STYLE:=none}"
: "${CALLBOX_USER:=root}"; : "${CALLBOX_SSH_PORT:=22}"
: "${APP_SERVER_USER:=simnovus}"; : "${APP_SERVER_SSH_PORT:=22}"

TS="$(date +%Y%m%d_%H%M%S)"
HOST="$(hostname -s 2>/dev/null || echo unknown)"
# Use a placeholder bundle dir while we run. At the end we rename it to
# `<testcase-name>_diagnostics_<TS>` once REST has resolved the testcase
# (or fall back to the legacy host-based name).
BUNDLE="${OUTPUT_DIR}/.pending_${TS}"
LOG="${BUNDLE}/collect.log"
MANIFEST="${BUNDLE}/MANIFEST.txt"
mkdir -p "$BUNDLE"

# Stamp the manifest header for LOOKBACK mode now (REST block won't run its
# usual header since there's no resolved iter). For test-case mode, the REST
# block writes its own header once it knows the iter.
if [[ "${LOOKBACK_ACTIVE:-0}" == "1" ]]; then
    {
      echo "Mode: LOOKBACK (no test case)"
      echo "Window: last ${LOOKBACK_MINUTES} min (Unix ${START} - ${END})"
      echo "Window (ISO): $(date -u -d "@${START}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null) - $(date -u -d "@${END}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
      echo "------------------------------------------------------------"
    } >> "$MANIFEST"
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
# mark writes to MANIFEST.txt AND echoes to stdout so the UI's SSE stream
# can update its per-section progress checklist live.
mark() {
    local line; line=$(printf '%-10s %s' "$1" "$2")
    echo "$line" >> "$MANIFEST"
    echo "$line"
}
have() { command -v "$1" >/dev/null 2>&1; }
# On Windows, `python3` is often the Microsoft Store alias stub — `have python3`
# is true but invoking it prints "Python was not found". Actually run it.
have_python3() { command -v python3 >/dev/null 2>&1 && python3 -c '' >/dev/null 2>&1; }

# Run a command, save stdout+stderr to a file, record in manifest.
capture() {  # capture <outfile> <label> <command...>
    local out="$1" label="$2"; shift 2
    if have "$1"; then
        { echo "# \$ $*"; "$@"; } > "${BUNDLE}/${out}" 2>&1
        mark "COLLECTED" "$label -> ${out}"
    else
        mark "SKIPPED" "$label (command '$1' not found)"
    fi
}

# Copy a file if it exists (with size cap), record in manifest.
copy_file() {  # copy_file <src> <destname> <label>
    local src="$1" dest="$2" label="$3"
    if [[ -f "$src" ]]; then
        local sz_mb; sz_mb=$(( $(stat -c%s "$src" 2>/dev/null || echo 0) / 1024 / 1024 ))
        if (( sz_mb > UESIM_LOG_MAX_MB )); then
            tail -c "$(( UESIM_LOG_MAX_MB * 1024 * 1024 ))" "$src" > "${BUNDLE}/${dest}"
            mark "TRUNCATED" "$label -> ${dest} (last ${UESIM_LOG_MAX_MB}MB of ${sz_mb}MB)"
        else
            cp -p "$src" "${BUNDLE}/${dest}"
            mark "COLLECTED" "$label -> ${dest}"
        fi
    else
        mark "SKIPPED" "$label (not found: $src)"
    fi
}

# Run a command over SSH if host set, else locally. Output to file.
# Optional 7th arg = SSH password (uses sshpass + key-based fallback off).
remote_or_local() {  # <host> <user> <port> <outfile> <label> <cmd-string> [password]
    local host="$1" user="$2" port="$3" out="$4" label="$5" cmd="$6" pass="${7:-}"
    if [[ -n "$host" ]]; then
        if ! have ssh; then
            mark "SKIPPED" "$label (ssh not available for remote ${host})"; return
        fi
        if [[ -n "$pass" ]]; then
            if have sshpass; then
                sshpass -p "$pass" ssh -o StrictHostKeyChecking=accept-new \
                    -o ConnectTimeout=8 -p "$port" "${user}@${host}" "$cmd" \
                    > "${BUNDLE}/${out}" 2>&1 \
                    && mark "COLLECTED" "$label (remote ${host}) -> ${out}" \
                    || mark "FAILED" "$label (remote ${host} unreachable / auth / cmd error)"
            else
                mark "SKIPPED" "$label (password set for ${host} but sshpass not installed)"
            fi
        else
            ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 \
                -p "$port" "${user}@${host}" "$cmd" > "${BUNDLE}/${out}" 2>&1 \
                && mark "COLLECTED" "$label (remote ${host}) -> ${out}" \
                || mark "FAILED" "$label (remote ${host} unreachable / key auth / cmd error)"
        fi
    else
        bash -c "$cmd" > "${BUNDLE}/${out}" 2>&1 \
            && mark "COLLECTED" "$label (local) -> ${out}" \
            || mark "FAILED" "$label (local cmd error)"
    fi
}

# Send a script via SSH stdin (no quoting hell) and pipe its stdout into a
# bundle file. Used for slightly elaborate tarballs (heat-monitor with mtime
# filters, UESIM logs by find expression). Marks COLLECTED/FAILED + size.
remote_script_pipe() {  # <host> <user> <port> <outfile> <label> <pass> <script-text>
    local host="$1" user="$2" port="$3" out="$4" label="$5" pass="$6" stdin="$7"
    local target="${BUNDLE}/${out}"; mkdir -p "$(dirname "$target")"
    local rc=1
    if [[ -z "$host" ]]; then
        printf '%s' "$stdin" | bash > "$target" 2>>"$LOG"; rc=$?
    elif [[ -n "$pass" ]] && have sshpass; then
        printf '%s' "$stdin" | sshpass -p "$pass" ssh -o StrictHostKeyChecking=accept-new \
            -o ConnectTimeout=8 -p "$port" "${user}@${host}" bash > "$target" 2>>"$LOG"; rc=$?
    elif [[ -z "$pass" ]]; then
        printf '%s' "$stdin" | ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
            -o ConnectTimeout=8 -p "$port" "${user}@${host}" bash > "$target" 2>>"$LOG"; rc=$?
    else
        mark "SKIPPED" "$label (password set for ${host} but sshpass not installed)"; return
    fi
    if [[ $rc -eq 0 ]] && [[ -s "$target" ]]; then
        local sz; sz=$(stat -c%s "$target" 2>/dev/null || echo 0)
        mark "COLLECTED" "$label -> ${out} (${sz} bytes)"
    else
        rm -f "$target"
        mark "FAILED" "$label (rc=$rc; empty/error - see collect.log)"
    fi
}

# Pipe a remote command's STDOUT (binary-safe, no log capture) into a file in
# the bundle. Used for tarballs (e.g. UESIM logs, iperf logs). Marks
# COLLECTED/FAILED + size; deletes empty output on failure.
remote_pipe() {  # <host> <user> <port> <outfile> <label> <cmd-string> [password]
    local host="$1" user="$2" port="$3" out="$4" label="$5" cmd="$6" pass="${7:-}"
    local target="${BUNDLE}/${out}"
    mkdir -p "$(dirname "$target")"
    local rc
    if [[ -z "$host" ]]; then
        bash -c "$cmd" > "$target" 2>>"$LOG"; rc=$?
    elif [[ -n "$pass" ]] && have sshpass; then
        sshpass -p "$pass" ssh -o StrictHostKeyChecking=accept-new \
            -o ConnectTimeout=8 -p "$port" "${user}@${host}" "$cmd" \
            > "$target" 2>>"$LOG"; rc=$?
    elif [[ -z "$pass" ]]; then
        ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 \
            -p "$port" "${user}@${host}" "$cmd" > "$target" 2>>"$LOG"; rc=$?
    else
        mark "SKIPPED" "$label (password set for ${host} but sshpass not installed)"; return
    fi
    if [[ $rc -eq 0 ]] && [[ -s "$target" ]]; then
        local sz; sz=$(stat -c%s "$target" 2>/dev/null || echo 0)
        mark "COLLECTED" "$label -> ${out} (${sz} bytes)"
    else
        rm -f "$target"
        mark "FAILED" "$label (rc=$rc; empty/error - see collect.log)"
    fi
}

# Like remote_pipe, but an empty/failed result is SKIPPED rather than FAILED —
# for optional artifacts that legitimately may not exist (e.g. iperf logs when
# no iperf run happened in the collection window). Binary-safe stdout.
remote_pipe_optional() {  # <host> <user> <port> <outfile> <label> <cmd-string> [password]
    local host="$1" user="$2" port="$3" out="$4" label="$5" cmd="$6" pass="${7:-}"
    local target="${BUNDLE}/${out}"; mkdir -p "$(dirname "$target")"
    local rc
    if [[ -z "$host" ]]; then
        bash -c "$cmd" > "$target" 2>>"$LOG"; rc=$?
    elif [[ -n "$pass" ]] && have sshpass; then
        sshpass -p "$pass" ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 \
            -p "$port" "${user}@${host}" "$cmd" > "$target" 2>>"$LOG"; rc=$?
    elif [[ -z "$pass" ]]; then
        ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 \
            -p "$port" "${user}@${host}" "$cmd" > "$target" 2>>"$LOG"; rc=$?
    else
        mark "SKIPPED" "$label (password set for ${host} but sshpass not installed)"; return
    fi
    if [[ ${rc:-1} -eq 0 ]] && [[ -s "$target" ]]; then
        local sz; sz=$(stat -c%s "$target" 2>/dev/null || echo 0)
        mark "COLLECTED" "$label -> ${out} (${sz} bytes)"
    else
        rm -f "$target"
        mark "SKIPPED" "$label — none in the collected window"
    fi
}

# ---- UE-side helpers --------------------------------------------------------
# When UE_HOST is set, all UE captures happen over SSH; otherwise local.
# Helpers transparently use UE_HOST/USER/PORT/PASS from setup.conf.
ue_capture() {  # ue_capture <outfile> <label> <cmd-string>
    local out="$1" label="$2" cmd="$3"
    if [[ -n "${UE_HOST:-}" ]]; then
        remote_or_local "$UE_HOST" "${UE_USER:-sysadmin}" "${UE_SSH_PORT:-22}" \
            "$out" "$label" "$cmd" "${UE_PASS:-}"
    else
        bash -c "$cmd" > "${BUNDLE}/${out}" 2>&1 \
            && mark "COLLECTED" "$label (local) -> ${out}" \
            || mark "FAILED" "$label (local cmd error)"
    fi
}

ue_copy_file() {  # ue_copy_file <src> <destname> <label>
    local src="$1" dest="$2" label="$3"
    if [[ -n "${UE_HOST:-}" ]]; then
        # cat with sudo fallback. If both fail, file genuinely isn't readable.
        local cmd="cat '$src' 2>/dev/null || sudo -n cat '$src'"
        remote_or_local "$UE_HOST" "${UE_USER:-sysadmin}" "${UE_SSH_PORT:-22}" \
            "$dest" "$label" "$cmd" "${UE_PASS:-}"
    else
        copy_file "$src" "$dest" "$label"
    fi
}

# ---- Host info probe ---------------------------------------------------------
# Emits a compact KEY=value inventory for one host. The same script runs on
# every host (UE, Simnovator, Callbox, App-server) so the cross-host SYSTEM.md
# builder gets a uniform schema. Anything not detectable comes out blank.
host_info_probe_script() {
    cat <<'HIPROBE'
#!/bin/bash
set +e
hn=$(hostname 2>/dev/null)
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
machine="Physical"
if command -v systemd-detect-virt >/dev/null 2>&1; then
    v=$(systemd-detect-virt 2>/dev/null)
    [[ "$v" != "none" && -n "$v" ]] && machine="Virtual ($v)"
fi
uptime_pretty=$(uptime -p 2>/dev/null | sed 's/^up //')
os_name=$( { . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; } )
kernel=$(uname -r 2>/dev/null)
cpu_model=$(lscpu 2>/dev/null | awk -F: '/Model name/{sub(/^[ \t]+/,"",$2);print $2;exit}')
cpu_cores=$(nproc 2>/dev/null)
# RAM in GB (rounded). dmidecode for slots is sudo-only — degrade gracefully.
ram_gb=$(free -g 2>/dev/null | awk '/Mem:/{print $2}')
ram_slots=$(sudo -n dmidecode -t memory 2>/dev/null | grep -c "^Memory Device$")
# Root FS only — perf-qa only cares about the box's main disk.
disk=$(df -h --output=size,used,avail / 2>/dev/null | tail -1 | tr -s ' ' ' ')
mb_vendor=$(sudo -n dmidecode -s baseboard-manufacturer 2>/dev/null)
mb_model=$(sudo -n dmidecode -s baseboard-product-name 2>/dev/null)
mb=$([[ -n "$mb_vendor$mb_model" ]] && echo "$mb_vendor $mb_model" || echo "")
# SDR devices + per-device summary if sdr_util is on PATH (Amarisoft tool).
sdr_devs=$(ls /dev/sdr* 2>/dev/null | head -8 | tr '\n' ' ')
sdr_summary=""
if command -v sdr_util >/dev/null 2>&1; then
    sdr_summary=$(for d in /dev/sdr*; do
        [[ -e "$d" ]] || continue
        sdr_util "$d" 2>/dev/null | awk -v d="$d" '
            /^Board ID/   {bid=$NF}
            /^Board type/ {bt=$NF}
            /^FPGA revision/ {fpga=$3" "$4}
            /^Software version/ {sw=$3}
            /^Serial/     {gsub(/'\''/,"",$2); ser=$2}
            END {printf "%s|%s|%s|%s|%s|%s\n", d, bid, bt, fpga, sw, ser}'
    done | paste -sd';' - )
fi
# iperf3 version (for cross-host match check). `iperf3 --version` prints
# version on stdout's first line; older `iperf` (v2) prints on stderr.
iperf3_ver=$(iperf3 --version 2>/dev/null | head -1 | sed 's/^iperf //')
# Active CPU governor (read once from cpu0 — uniform across cores in
# practice for perf rigs). Empty if cpufreq driver not loaded (VMs).
cpu_gov=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null)
# Swap usage in MB (non-zero swap on a perf box is a red flag — it points to
# memory pressure or unintended swapping).
swap_used_mb=$(free -m 2>/dev/null | awk '/^Swap:/{print $3}')
# Transparent huge pages state — perf rigs usually want [never] for predictable
# latency. /sys file contains the values with the active one in brackets.
thp=$(cat /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null | grep -oP '\[\K[^\]]+')
# Time sync status — checks chrony or systemd-timesyncd, whichever is active.
time_sync=$( { timedatectl 2>/dev/null | grep -E 'NTP|synchronized' | tr '\n' ';' || true; } )
cat <<EOF
HOSTNAME=$hn
IP=$ip
MACHINE=$machine
UPTIME=$uptime_pretty
OS=$os_name
KERNEL=$kernel
CPU_MODEL=$cpu_model
CPU_CORES=$cpu_cores
RAM_GB=$ram_gb
RAM_SLOTS=$ram_slots
DISK=$disk
MOTHERBOARD=$mb
SDR_DEVICES=$sdr_devs
SDR_SUMMARY=$sdr_summary
IPERF3_VER=$iperf3_ver
CPU_GOVERNOR=$cpu_gov
SWAP_USED_MB=$swap_used_mb
THP=$thp
TIME_SYNC=$time_sync
EOF
HIPROBE
}

# Run the host-info probe on one host (label-by-role), save under <role>/system/.
host_info_collect() {  # <role> <host> <user> <port> <pass>
    local role="$1" host="$2" user="$3" port="$4" pass="$5"
    local out="${role}/system/host_info.txt"
    mkdir -p "${BUNDLE}/${role}/system"
    remote_script_pipe "$host" "$user" "$port" "$out" \
        "${role}: host inventory probe" "$pass" "$(host_info_probe_script)"
}


# ---- Simnovator-host helpers ------------------------------------------------
# Run a podman command on the Simnovator host (remote or local). The first
# arg is the output file (relative to bundle), then label, then podman args.
sim_podman() {  # sim_podman <outfile> <label> <podman-args...>
    local out="$1" label="$2"; shift 2
    local cmd
    cmd="$(printf '%q ' "${PODMAN_BIN:-podman}" "$@")"
    if [[ -n "${SIMNOVATOR_HOST:-}" ]]; then
        remote_or_local "$SIMNOVATOR_HOST" "${SIMNOVATOR_USER:-sysadmin}" "${SIMNOVATOR_SSH_PORT:-22}" \
            "$out" "$label" "$cmd" "${SIMNOVATOR_PASS:-}"
    else
        bash -c "$cmd" > "${BUNDLE}/${out}" 2>&1 \
            && mark "COLLECTED" "$label (local) -> ${out}" \
            || mark "FAILED" "$label (local cmd error)"
    fi
}

# Return the container engine on the Simnovator host (podman or docker).
sim_detect_engine() {
    if [[ -n "${CONTAINER_ENGINE:-}" ]]; then echo "$CONTAINER_ENGINE"; return; fi
    if [[ -n "${SIMNOVATOR_HOST:-}" ]]; then
        ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 \
            -p "${SIMNOVATOR_SSH_PORT:-22}" \
            "${SIMNOVATOR_USER:-sysadmin}@${SIMNOVATOR_HOST}" \
            'command -v podman >/dev/null 2>&1 && echo podman || (command -v docker >/dev/null 2>&1 && echo docker)' \
            2>/dev/null
    else
        if have podman; then echo podman; elif have docker; then echo docker; fi
    fi
}

# List container names on the Simnovator host.
sim_container_names() {
    local engine="$1"
    if [[ -n "${SIMNOVATOR_HOST:-}" ]]; then
        ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 \
            -p "${SIMNOVATOR_SSH_PORT:-22}" \
            "${SIMNOVATOR_USER:-sysadmin}@${SIMNOVATOR_HOST}" \
            "$engine ps --format '{{.Names}}'" 2>/dev/null
    else
        "$engine" ps --format '{{.Names}}' 2>/dev/null
    fi
}

# Run an arbitrary shell command on the Simnovator host (remote or local),
# capturing stdout+stderr to a bundle file. Sibling to sim_podman for the
# non-podman probes added for quadlet support (systemctl, journalctl, the
# native `simnovator` CLI).
sim_run() {  # sim_run <outfile> <label> <shell-cmd>
    local out="$1" label="$2" cmd="$3"
    if [[ -n "${SIMNOVATOR_HOST:-}" ]]; then
        remote_or_local "$SIMNOVATOR_HOST" "${SIMNOVATOR_USER:-sysadmin}" "${SIMNOVATOR_SSH_PORT:-22}" \
            "$out" "$label" "$cmd" "${SIMNOVATOR_PASS:-}"
    else
        bash -c "$cmd" > "${BUNDLE}/${out}" 2>&1 \
            && mark "COLLECTED" "$label (local) -> ${out}" \
            || mark "FAILED" "$label (local cmd error)"
    fi
}

# Podman quadlets name a container "systemd-<unit>" unless the .container file
# sets ContainerName= explicitly, so `podman ps` may return either the bare
# name (podman-compose / explicit) or the systemd-prefixed name (quadlet
# default). Strip the prefix to get the logical service name used as the key
# in SIM_APP_LOGS and as the stable bundle path — so the bundle layout is
# identical on both old and new (quadlet) hosts.
# Assumes Simnovator's two naming conventions only: pre-quadlet compose names
# are bare (simnovator-*), quadlet names are systemd-prefixed. Section 6b's
# matcher tries BOTH forms, so a stripped name still resolves to the right
# running container regardless.
sim_logical_name() { echo "${1#systemd-}"; }

# Binary-safe stdout pull from the Simnovator host where MISSING output is a
# NOTE, not a FAILED. Mirrors remote_pipe's transport but is for best-effort
# bonus artifacts (the native `simnovator logs` tar) that shouldn't redden the
# pipeline if engineering's CLI syntax differs from our guess.
sim_pipe_best_effort() {  # <outfile> <label> <cmd-string>
    local out="$1" label="$2" cmd="$3"
    local target="${BUNDLE}/${out}"; mkdir -p "$(dirname "$target")"
    local host="${SIMNOVATOR_HOST:-}" user="${SIMNOVATOR_USER:-sysadmin}"
    local port="${SIMNOVATOR_SSH_PORT:-22}" pass="${SIMNOVATOR_PASS:-}" rc
    if [[ -z "$host" ]]; then
        bash -c "$cmd" > "$target" 2>>"$LOG"; rc=$?
    elif [[ -n "$pass" ]] && have sshpass; then
        sshpass -p "$pass" ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 \
            -p "$port" "${user}@${host}" "$cmd" > "$target" 2>>"$LOG"; rc=$?
    elif [[ -z "$pass" ]]; then
        ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 \
            -p "$port" "${user}@${host}" "$cmd" > "$target" 2>>"$LOG"; rc=$?
    else
        mark NOTE "$label (password set but sshpass not installed)"; return
    fi
    if [[ ${rc:-1} -eq 0 && -s "$target" ]]; then
        local sz; sz=$(stat -c%s "$target" 2>/dev/null || echo 0)
        mark COLLECTED "$label -> ${out} (${sz} bytes)"
    else
        rm -f "$target"
        mark NOTE "$label — not produced (see native_logs/logs_help.txt for the exact supported syntax)"
    fi
}

# ---------------------------------------------------------------------------
log "=== Performance data collection started ==="
log "Config:  $CONF"
log "Host:    $HOST"
log "Bundle:  $BUNDLE"
{
  echo "Collection bundle: $BUNDLE"
  echo "Host: $HOST    Date: $(date)"
  echo "Config: $CONF"
  echo "Test case: ${TEST_CASE_NAME:-${TEST_CASE_ID:-<none>}}"
  echo "============================================================"
} > "$MANIFEST"

# ===========================================================================
# 1) UE SIDE
# ===========================================================================
if [[ "$COLLECT_UE" == "1" && -z "${UE_HOST:-}" ]]; then
    mark SKIPPED "ue: UE_HOST is blank — section skipped (set IP in setup.conf)"
elif [[ "$COLLECT_UE" == "1" ]]; then
    log "--- UE side (remote ${UE_HOST}) ---"
    UE="${BUNDLE}/ue"
    mkdir -p "$UE/system" "$UE/config" "$UE/cpu" "$UE/net" "$UE/logs" "$UE/heat"

    # --- system/host_info.txt — single uniform inventory probe (used by SYSTEM.md)
    host_info_collect "ue" "$UE_HOST" "${UE_USER:-sysadmin}" "${UE_SSH_PORT:-22}" "${UE_PASS:-}"

    # --- system/ — host identity + topology ---
    ue_capture  "ue/system/uname.txt"      "system: uname"           "uname -a"
    ue_capture  "ue/system/os-release.txt" "system: os-release"      "cat /etc/os-release"
    ue_capture  "ue/system/cmdline.txt"    "system: kernel cmdline"  "cat /proc/cmdline"
    ue_copy_file "/etc/default/grub" "ue/system/grub.default"        "system: grub setting"
    ue_capture  "ue/system/lscpu.txt"      "system: lscpu"           "lscpu"
    ue_capture  "ue/system/numactl.txt"    "system: numactl -H"      "numactl --hardware"
    ue_capture  "ue/system/meminfo.txt"    "system: meminfo"         "cat /proc/meminfo"
    ue_capture  "ue/system/hugepages.txt"  "system: hugepages"       "grep -i huge /proc/meminfo; ls -l /sys/kernel/mm/hugepages 2>/dev/null"
    ue_capture  "ue/system/cpu_freq.txt"   "system: cpu governor"    \
        'for c in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo "$c: $(cat $c 2>/dev/null)"; done'
    ue_capture  "ue/system/numa_topology.txt" "system: numa topology" \
        'for n in /sys/devices/system/node/node*; do echo "== $n =="; cat "$n/cpulist" 2>/dev/null; done'
    [[ -n "${NUMA_CONFIG_PATH:-}" ]] && ue_copy_file "$NUMA_CONFIG_PATH" "ue/system/numa_config" "system: numa_config file"

    # --- config/ — workload_affinity.json (+ single-array shape sanity check) ---
    # Optional file — present only on some UE rigs. Capture with a sentinel so a
    # missing file is SKIPPED, not a red FAILED.
    if [[ -n "${WORKLOAD_AFFINITY_JSON:-}" ]]; then
        ue_capture "ue/config/workload_affinity.json" "workload config" \
            "cat '${WORKLOAD_AFFINITY_JSON}' 2>/dev/null || sudo -n cat '${WORKLOAD_AFFINITY_JSON}' 2>/dev/null || echo '__WAF_NOT_FOUND__'"
        if [[ -f "${UE}/config/workload_affinity.json" ]] && grep -q '__WAF_NOT_FOUND__' "${UE}/config/workload_affinity.json" 2>/dev/null; then
            rm -f "${UE}/config/workload_affinity.json"
            mark SKIPPED "workload config (not present at ${WORKLOAD_AFFINITY_JSON})"
        elif [[ -s "${UE}/config/workload_affinity.json" ]] && have_python3; then
            python3 - "${UE}/config/workload_affinity.json" > "${UE}/config/workload_affinity_check.txt" 2>&1 <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("PARSE ERROR:", e); sys.exit(0)
def shape(v):
    if isinstance(v, list):
        return "array-of-arrays" if v and isinstance(v[0], list) else "single-array"
    return type(v).__name__
print("Top-level keys:", list(d) if isinstance(d, dict) else "(not an object)")
for k, v in (d.items() if isinstance(d, dict) else []):
    s = shape(v)
    flag = "  <-- EXPECTED single-array for core pinning" if s == "array-of-arrays" else ""
    print(f"  {k}: shape={s}{flag}")
PYEOF
            mark COLLECTED "workload config: shape check -> ue/config/workload_affinity_check.txt"
        fi
    else
        mark SKIPPED "workload config (WORKLOAD_AFFINITY_JSON unset)"
    fi

    # --- config/ — ue.cfg ---
    ue_copy_file "${UE_CFG_PATH:-}" "ue/config/ue.cfg" "config: ue.cfg"

    # --- logs/ots.log (standalone, size-capped) for quick access; the full
    #     UESIM log dirs are also tarred below for completeness.
    ue_copy_file "/var/log/lte/ots.log" "ue/logs/ots.log" "logs: ots.log (standalone)"

    # --- logs/ — UESIM debug log tar (full *.log/*.txt/*.pcap set, size-capped) ---
    if [[ -n "${UESIM_LOG_DIR:-}" ]]; then
        local_or_remote_cmd="sudo -n find ${UESIM_LOG_DIR} -maxdepth 1 -type f \\( -name '*.log' -o -name '*.txt' -o -name '*.pcap' \\) 2>/dev/null | head -200 | sudo -n tar czf - --ignore-failed-read --files-from=-"
        if [[ -n "${UE_HOST:-}" ]]; then
            remote_pipe "$UE_HOST" "${UE_USER:-sysadmin}" "${UE_SSH_PORT:-22}" \
                "ue/logs/uesim_logs.tar.gz" "uesim logs (tar)" "$local_or_remote_cmd" "${UE_PASS:-}"
        else
            remote_pipe "" "" "" "ue/logs/uesim_logs.tar.gz" "uesim logs (tar)" "$local_or_remote_cmd"
        fi
    fi

    # --- cpu/ — per-thread CPU + core alloc + smp aff ---
    # Build the cpu-affinity snippet with PERF_PROC_NAMES *pre-substituted*
    # locally (quoted heredoc otherwise blocks $-expansion) — internal $pid /
    # $pname / $irq are kept literal so they evaluate on the target host.
    CPU_AFFINITY_SNIPPET="$(cat <<'BASH'
echo "# Per-process CPU / core allocation / SMP affinity"
for pname in __PERF_PROC_NAMES__; do
  for pid in $(pgrep -x "$pname" 2>/dev/null; pgrep -f "$pname" 2>/dev/null); do
    [[ -d /proc/$pid ]] || continue
    echo "============================================================"
    echo "PROCESS: $pname  PID: $pid"
    echo "--- /proc/$pid/status (affinity) ---"
    grep -E 'Cpus_allowed_list|Cpus_allowed:' "/proc/$pid/status" 2>/dev/null
    echo "--- taskset ---"; taskset -cp "$pid" 2>/dev/null
    echo "--- per-thread (tid, last-cpu PSR, %cpu) ---"; ps -T -p "$pid" -o tid,psr,pcpu,comm 2>/dev/null
  done
done
echo "============================================================"
echo "# IRQ SMP affinity"
for irq in /proc/irq/*/smp_affinity_list; do
  [[ -r "$irq" ]] && echo "$irq -> $(cat "$irq" 2>/dev/null)"
done
BASH
    )"
    CPU_AFFINITY_SNIPPET="${CPU_AFFINITY_SNIPPET//__PERF_PROC_NAMES__/${PERF_PROC_NAMES:-}}"
    ue_capture "ue/cpu/cpu_affinity.txt" "cpu: t-cpu/core-alloc/smp-aff" "$CPU_AFFINITY_SNIPPET"

    # top -H snapshot for the first matching perf process. Guard with :- so a
    # setup.conf that omits PERF_PROC_NAMES doesn't abort the run under `set -u`.
    ue_capture "ue/cpu/top_threads.txt" "cpu: top -H per-thread" \
        'p=$(for n in '"${PERF_PROC_NAMES:-}"'; do pgrep -f "$n" 2>/dev/null | head -1; done | head -1); [[ -n "$p" ]] && top -H -b -n 2 -p "$p" 2>&1 || echo "(no perf process found)"'

    # --- net/ — NIC offload / ring settings (relevant for throughput tests) ---
    ue_capture "ue/net/ip_link.txt" "net: ip link" "ip -s link"
    ue_capture "ue/net/nic_settings.txt" "net: nic ring/offload" \
        'for dev in $(ls /sys/class/net 2>/dev/null | grep -v lo); do echo "===== $dev ====="; ethtool -g "$dev" 2>/dev/null; ethtool -k "$dev" 2>/dev/null; done'
fi

# ===========================================================================
# 2) SIMNOVATOR (containers / logs / test case)
# ===========================================================================
if [[ "$COLLECT_SIMNOVATOR" == "1" && -z "${SIMNOVATOR_HOST:-}" ]]; then
    mark SKIPPED "simnovator: SIMNOVATOR_HOST is blank — section skipped (set IP in setup.conf)"
elif [[ "$COLLECT_SIMNOVATOR" == "1" ]]; then
    log "--- Simnovator (remote ${SIMNOVATOR_HOST}) ---"
    SN="${BUNDLE}/simnovator"; mkdir -p "${SN}/container_logs"

    host_info_collect "simnovator" "$SIMNOVATOR_HOST" "${SIMNOVATOR_USER:-sysadmin}" \
        "${SIMNOVATOR_SSH_PORT:-22}" "${SIMNOVATOR_PASS:-}"

    ENGINE="$(sim_detect_engine)"
    PODMAN_BIN="$ENGINE"
    if [[ -n "$ENGINE" ]]; then
        mark COLLECTED "simnovator: container engine = ${ENGINE} (on ${SIMNOVATOR_HOST:-localhost})"
        sim_podman "simnovator/ps.txt"               "simnovator: ${ENGINE} ps -a"      ps -a
        sim_podman "simnovator/engine_version.txt"   "simnovator: ${ENGINE} version"    version
        # podman is pod-based in 4.0 (pod_simnovator)
        if [[ "$ENGINE" == "podman" ]]; then
            sim_podman "simnovator/pod_ps.txt"       "simnovator: podman pod ps"        pod ps
        fi
        # Live per-container resource snapshot (local proxy for Beszel metrics).
        sim_podman "simnovator/container_stats_snapshot.txt" "simnovator: ${ENGINE} stats snapshot (CPU/mem/net/io)" stats --no-stream

        # Container status + health. With quadlets every service gets a
        # healthcheck; podman's {{.Status}} shows "Up 5m (healthy|starting|
        # unhealthy)". This is the fastest way to spot a wedged dependency
        # (e.g. keycloak stuck "starting" blocking everything downstream).
        sim_podman "simnovator/container_health.txt" "simnovator: container status/health" \
            ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}\t{{.Image}}'

        # systemd unit states — only meaningful once engineering moved to
        # quadlets (containers run as <unit>.service). Broad grep so we don't
        # depend on exact unit names; prints a clear sentinel on pre-quadlet
        # hosts so the bundle records "this host isn't quadlet-managed yet".
        sim_run "simnovator/systemd_units.txt" "simnovator: systemd unit states (quadlet)" \
            "systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'simnovator|keycloak|observe|timescale|redis|valkey|gateway|authenticator|executor|worker|stats|frontend|test-(creator|processor)' || echo '(no matching systemd units — pre-quadlet podman-compose host)'"

        # Disk / storage usage. The product health UI shows per-container CPU/RAM
        # but no disk; the real hogs are the *volumes* (autosave/timescaledb/
        # openobserve), which never appear as containers. Capture filesystem %,
        # per-volume sizes, /var/log, cores, and the executor cleanup cap + last
        # reading so a filling disk is visible before it causes an outage. (SIM40-2418)
        sim_run "simnovator/disk_usage.txt" "simnovator: disk + volume usage" '
          echo "=== filesystem (root) ==="; df -h / | tail -1
          echo; echo "=== simnovator volumes (disk used) ==="
          VB="$HOME/.local/share/containers/storage/volumes"
          [ -d "$VB" ] || VB=/var/lib/containers/storage/volumes
          du -hs "$VB"/simnovator_* 2>/dev/null | sort -rh
          echo; echo "=== /var/log (top) ==="; du -hsx /var/log 2>/dev/null
          du -hx /var/log 2>/dev/null | sort -rh | head -6
          echo; echo "=== core dumps ==="; du -hs /var/tmp/cores /var/crash 2>/dev/null
          echo; echo "=== executor cleanup cap + last reading ==="
          podman inspect simnovator-executor --format "{{range .Config.Env}}{{println .}}{{end}}" 2>/dev/null | grep -i CLEANUP_MAX_DISK
          journalctl --user -u simnovator-executor --no-pager 2>/dev/null | grep -iE "Disk Usage -|within safe limits|deleting|Entering cleanup" | tail -4'

        # Per-container inspect JSON (point-in-time, no window needed). The
        # actual `logs` dump moves to the post-REST section so we can pass
        # --since=<test start> and capture only test-window output. Bundle
        # filename uses the logical (de-prefixed) name so it's stable across
        # host generations; the podman target uses the actual name.
        clist="${SIMNOVATOR_CONTAINERS:-}"
        [[ -z "$clist" ]] && clist="$(sim_container_names "$ENGINE")"
        log "  found $(echo "$clist" | wc -w) container(s); inspecting now, logs deferred to post-REST window"
        for c in $clist; do
            lc="$(sim_logical_name "$c")"
            sim_podman "simnovator/container_logs/${lc}.inspect.json" "simnovator: inspect ${lc}" \
                inspect "$c" >/dev/null 2>&1 || true
        done
        # Save list for the windowed log pass.
        echo "$clist" > "${BUNDLE}/.sim_containers"
    else
        mark SKIPPED "simnovator: no container engine (podman/docker) detectable on ${SIMNOVATOR_HOST:-localhost}"
    fi

    # --- Simnovator host setup log: /home/simnovus/master_setup.log ---
    # The deploy/setup flow writes a master setup log under the simnovus home
    # (root-owned, hence sudo). Whole file (it's a bounded setup/deploy log, not
    # something to window). Path overridable via SIM_MASTER_SETUP_LOG. Missing
    # => SKIPPED (not FAILED) via the sentinel.
    SIM_MASTER_SETUP_LOG="${SIM_MASTER_SETUP_LOG:-/home/simnovus/master_setup.log}"
    sim_run "simnovator/master_setup.log" "simnovator: master_setup.log" \
        "sudo -n cat '${SIM_MASTER_SETUP_LOG}' 2>/dev/null || cat '${SIM_MASTER_SETUP_LOG}' 2>/dev/null || echo '__MSL_NOT_FOUND__'"
    if [[ -f "${BUNDLE}/simnovator/master_setup.log" ]] && grep -q '__MSL_NOT_FOUND__' "${BUNDLE}/simnovator/master_setup.log" 2>/dev/null; then
        rm -f "${BUNDLE}/simnovator/master_setup.log"
        mark SKIPPED "simnovator: master_setup.log not present at ${SIM_MASTER_SETUP_LOG}"
    fi

    # --- Beszel container monitoring (historical resource time-series) ---
    # Three modes, in order of preference:
    #   (a) BESZEL_HUB_URL + BESZEL_USER/PASS + a python with playwright -> headless-Chromium screenshot
    #   (b) BESZEL_EXPORT_CMD set                                        -> run user's own export command
    #   (c) anything else                                                -> NOTE only
    beszel_helper="${BESZEL_SCREENSHOT_SCRIPT:-${SCRIPT_DIR}/beszel_screenshot.py}"
    beszel_target_host="$(echo "${SIM_API_BASE:-}" | sed -E 's#^https?://##; s#[:/].*##')"
    if [[ -n "${BESZEL_HUB_URL:-}" && -n "${BESZEL_USER:-}" && -n "${BESZEL_PASS:-}" \
          && -n "${BESZEL_PYTHON:-}" && -x "${BESZEL_PYTHON}" \
          && -f "$beszel_helper" && -n "$beszel_target_host" ]]; then
        out="${SN}/beszel_${beszel_target_host//./_}.png"
        bez_log="$(mktemp 2>/dev/null || echo "${BUNDLE}/.bez.$$")"
        if "$BESZEL_PYTHON" "$beszel_helper" \
              --hub "$BESZEL_HUB_URL" \
              --user "$BESZEL_USER" --password "$BESZEL_PASS" \
              --match-host "$beszel_target_host" \
              --range "${BESZEL_CHART_RANGE:-1h}" \
              --out "$out" > "$bez_log" 2>&1; then
            cat "$bez_log" >> "$LOG"
            sz=$(stat -c%s "$out" 2>/dev/null || echo 0)
            mark COLLECTED "simnovator: Beszel screenshot (${BESZEL_CHART_RANGE:-1h} for ${beszel_target_host}) -> simnovator/$(basename "$out") (${sz} bytes)"
        else
            cat "$bez_log" >> "$LOG"
            # "no system found" is a hub data/access gap, not a collector failure
            # — the host just isn't registered (or the viewer lacks access). NOTE,
            # not FAILED. Genuine errors (hub down, playwright crash) stay FAILED.
            if grep -qiE 'no system found|no matching|not found' "$bez_log" 2>/dev/null; then
                mark NOTE "simnovator: Beszel — no system registered for ${beszel_target_host} on the hub (add it / grant viewer access)"
            else
                mark FAILED "simnovator: Beszel screenshot for ${beszel_target_host} (see collect.log) - hub=${BESZEL_HUB_URL}"
            fi
        fi
        rm -f "$bez_log"
    elif [[ -n "${BESZEL_EXPORT_CMD:-}" ]]; then
        bash -c "$BESZEL_EXPORT_CMD" > "${SN}/beszel_export.txt" 2>&1 \
            && mark COLLECTED "simnovator: Beszel export cmd -> simnovator/beszel_export.txt" \
            || mark FAILED "simnovator: Beszel export cmd"
    elif [[ -n "${BESZEL_HUB_URL:-}" ]]; then
        mark NOTE "simnovator: Beszel hub at ${BESZEL_HUB_URL} (set BESZEL_USER/PASS + install playwright in BESZEL_PYTHON's venv to auto-screenshot)"
    else
        mark NOTE "simnovator: Beszel = container resource time-series (CPU/mem/net/disk). Set BESZEL_HUB_URL + creds for auto-screenshot"
    fi

    mark NOTE "simnovator: 'Download all logs' bundle -> export from Simnovator GUI (manual; REST exposes only the per-execution log CSV under section 5)"
fi

# ===========================================================================
# 3) CALLBOX (enb.cfg + Amarisoft monitor)
# ===========================================================================
if [[ "$COLLECT_CALLBOX" == "1" && -z "${CALLBOX_HOST:-}" ]]; then
    mark SKIPPED "callbox: CALLBOX_HOST is blank — section skipped (set IP in setup.conf)"
elif [[ "$COLLECT_CALLBOX" == "1" ]]; then
    log "--- Callbox (${CALLBOX_HOST}) ---"
    CB="${BUNDLE}/callbox"; mkdir -p "$CB"
    if [[ -n "${CALLBOX_HOST:-}" ]]; then
        host_info_collect "callbox" "$CALLBOX_HOST" "${CALLBOX_USER:-sysadmin}" \
            "${CALLBOX_SSH_PORT:-22}" "${CALLBOX_PASS:-}"
        # enb.cfg / mme.cfg / ims.cfg — all live under /root on the callbox.
        # /root/enb and /root/mme are stable symlinks to the current build, so
        # these paths automatically follow build upgrades. Try plain cat first
        # then fall back to sudo (Amarisoft boxes have NOPASSWD sudo).
        for spec in "enb:${ENB_CFG_PATH}" "mme:${MME_CFG_PATH:-/root/mme/config/mme.cfg}" "ims:${IMS_CFG_PATH:-/root/mme/config/ims.cfg}"; do
            kind="${spec%%:*}"; path="${spec#*:}"
            [[ -z "$path" ]] && continue
            CFG_CMD="cat '$path' 2>/dev/null || sudo -n cat '$path'"
            remote_or_local "$CALLBOX_HOST" "$CALLBOX_USER" "$CALLBOX_SSH_PORT" \
                "callbox/${kind}.cfg" "callbox: ${kind}.cfg" "$CFG_CMD" "${CALLBOX_PASS:-}"
        done
        # Resolve which cfg the live lteenb / ltemme / lteims process is using
        # (cwd of the process holds the absolute path of the active config dir).
        ACT_CMD='for p in $(pgrep -x "lteenb-.*|ltemme-.*|lteims-.*" 2>/dev/null); do echo "PID $p ($(cat /proc/$p/comm 2>/dev/null))"; sudo -n readlink /proc/$p/cwd 2>/dev/null; sudo -n ls -la /proc/$p/cwd/config/ 2>/dev/null | grep -E "\\.cfg" || true; echo; done; true'
        remote_or_local "$CALLBOX_HOST" "$CALLBOX_USER" "$CALLBOX_SSH_PORT" \
            "callbox/active_cfg_paths.txt" "callbox: active cfg paths (enb/mme/ims)" "$ACT_CMD" "${CALLBOX_PASS:-}"
        remote_or_local "$CALLBOX_HOST" "$CALLBOX_USER" "$CALLBOX_SSH_PORT" \
            "callbox/enb_version.txt" "callbox: version" "sudo -n cat /root/*/config/*version* 2>/dev/null; dmesg 2>/dev/null | tail -50 || sudo -n dmesg | tail -50" "${CALLBOX_PASS:-}"
        # Hardware sensors: CPU/board/NVMe temps (lm-sensors) + SDR temps from
        # /sys/class/hwmon. Useful for thermal-throttle / SDR-overheat diagnosis.
        remote_or_local "$CALLBOX_HOST" "$CALLBOX_USER" "$CALLBOX_SSH_PORT" \
            "callbox/sensors.txt" "callbox: lm-sensors + hwmon temps" \
            'echo "=== sensors ==="; sensors -A 2>/dev/null || echo "(sensors not installed)"; echo; echo "=== /sys/class/hwmon ==="; for h in /sys/class/hwmon/hwmon*; do n=$(cat "$h/name" 2>/dev/null); echo "$(basename $h) name=$n"; for f in "$h"/temp*_input; do [[ -f "$f" ]] && printf "  %s: %.1f C\n" "$(basename $f)" "$(awk -v t=$(cat $f 2>/dev/null) "BEGIN{print t/1000}")"; done; done; echo; echo "=== /sys/class/thermal ==="; for z in /sys/class/thermal/thermal_zone*; do t=$(cat "$z/type" 2>/dev/null); tmp=$(cat "$z/temp" 2>/dev/null); printf "  %s type=%s temp=%.1f C\n" "$(basename $z)" "$t" "$(awk -v x=$tmp "BEGIN{print x/1000}")"; done' \
            "${CALLBOX_PASS:-}"
    else
        copy_file "${ENB_CFG_PATH:-}" "callbox/enb.cfg" "callbox: enb.cfg"
    fi
    # Amarisoft monitor: send JSON commands over the lteenb WebSocket
    # (com_addr in enb.cfg, default 127.0.0.1:9001) via the bundled ws.js
    # client. `stats` returns SDR temp / sample-rate / etc on supported HW;
    # `config_get` dumps the live config; `cell_list`/`ue_get` give per-cell
    # and per-UE state. Each request times out after 4s so a busy monitor
    # doesn't hang. sudo because /root is root-only.
    if [[ -n "${AMARISOFT_WS_CMD:-}" ]]; then
        amari_cmd="$AMARISOFT_WS_CMD"
    else
        amari_cmd='ws=$(sudo -n find /root -maxdepth 2 -name ws.js -path "*lteenb*" 2>/dev/null | head -1); echo "ws.js: ${ws:-NOT FOUND}"; if [[ -n "$ws" ]] && command -v node >/dev/null 2>&1; then for msg in '"'"'{"message":"stats"}'"'"' '"'"'{"message":"config_get"}'"'"' '"'"'{"message":"cell_list"}'"'"' '"'"'{"message":"ue_get"}'"'"'; do label=$(echo "$msg" | sed -n '"'"'s/.*"message":"\\([^"]*\\)".*/\\1/p'"'"'); echo "=========== $label ==========="; timeout 4 sudo -n node "$ws" 127.0.0.1:9001 "$msg" 2>&1 | head -200; done; else echo "node or ws.js not available"; fi'
    fi
    if [[ -n "${CALLBOX_HOST:-}" ]]; then
        remote_or_local "$CALLBOX_HOST" "$CALLBOX_USER" "$CALLBOX_SSH_PORT" \
            "callbox/amari_monitor.txt" "callbox: amarisoft monitor (t/ue/cell)" \
            "$amari_cmd" "${CALLBOX_PASS:-}"
    fi
    mark NOTE "callbox: enable per-layer logging in enb.cfg appropriate to the test case"
fi

# ===========================================================================
# 4) APP SERVER (routing / network)
# ===========================================================================
if [[ "$COLLECT_APP_SERVER" == "1" && -z "${APP_SERVER_HOST:-}" ]]; then
    mark SKIPPED "app-server: APP_SERVER_HOST is blank — section skipped"
elif [[ "$COLLECT_APP_SERVER" == "1" ]]; then
    log "--- App server (${APP_SERVER_HOST}) ---"
    AS="${BUNDLE}/app_server"; mkdir -p "$AS"
    host_info_collect "app_server" "$APP_SERVER_HOST" "${APP_SERVER_USER:-sysadmin}" \
        "${APP_SERVER_SSH_PORT:-22}" "${APP_SERVER_PASS:-}"
    NETCMD='echo "== ip addr =="; ip addr; echo "== ip route =="; ip route; echo "== nmcli =="; nmcli -t dev 2>/dev/null; nmcli -t con 2>/dev/null; echo "== mtu/links =="; ip -d link'
    remote_or_local "${APP_SERVER_HOST:-}" "$APP_SERVER_USER" "$APP_SERVER_SSH_PORT" \
        "app_server/network.txt" "app-server: routing/network" "$NETCMD" "${APP_SERVER_PASS:-}"
    if [[ -n "${IPERF_TARGET:-}" ]]; then
        host="${IPERF_TARGET%%:*}"
        remote_or_local "${APP_SERVER_HOST:-}" "$APP_SERVER_USER" "$APP_SERVER_SSH_PORT" \
            "app_server/iperf_reach.txt" "app-server: iperf target reachability" \
            "ping -c3 ${host}; echo '---'; (command -v nc && nc -zv ${host} ${IPERF_TARGET##*:} 2>&1)" "${APP_SERVER_PASS:-}"
    fi
fi

# ===========================================================================
# 5) REST API (test-case data: KPIs / stats / logs for THIS test case)
#
# Simnovator 4.0 backend (verified against build 4.0.0_260527, May 2026):
#   - Base path is /v2 (NOT /api/v1 — that returns 404).
#   - Auth: POST /v2/login {username,password} -> JSON {access_token: <JWT>}.
#     Session cookies are NOT honored — every subsequent call needs
#     Authorization: Bearer <token>. (Keycloak-backed; ~3h JWT lifetime.)
#   - All per-run data is scoped by iterationId (per-execution UUID), not by
#     test case name. The script resolves: TEST_CASE_NAME -> testcaseId ->
#     latest iterationId + execution time window, then pulls stats/logs.
#   - If TEST_CASE_NAME is empty or "LAST_RUN", auto-discover via the
#     footer endpoint (same one the GUI's LAST RUN TEST widget uses).
# ===========================================================================
if [[ "$COLLECT_REST_API" == "1" && "${LOOKBACK_ACTIVE:-0}" == "1" ]]; then
    # LOOKBACK mode has no test case to anchor against — the REST API only
    # exposes per-iteration data (stats/logs/screenshots keyed by iterationId),
    # none of which applies to an ad-hoc time window. Skip the whole section
    # (incl. the login) so a slow/non-default API port can't redden the
    # pipeline for a mode that wouldn't use the data anyway.
    mark SKIPPED "rest-api: skipped in LOOKBACK mode (no test case; per-iteration data N/A)"
elif [[ "$COLLECT_REST_API" == "1" ]]; then
    log "--- REST API (test case) ---"
    API="${BUNDLE}/rest_api"; mkdir -p "$API"

    # Small JSON value extractor: jq if present, else python3, else a regex
    # fallback. Usage: json_get <file> <dotted.path>   (e.g. data.lastExecution.executionId)
    json_get() {
        local file="$1" path="$2"
        if have jq; then
            jq -r ".${path} // empty" "$file" 2>/dev/null
        elif have_python3; then
            python3 - "$file" "$path" <<'PYEOF' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    for k in sys.argv[2].split('.'):
        if k.endswith(']'):
            name, idx = k[:-1].split('[', 1); d = d[name][int(idx)]
        else:
            d = d[k] if isinstance(d, dict) else d
    print(d if d is not None else '')
except Exception:
    pass
PYEOF
        else
            # Crude fallback: looks up the FIRST occurrence of the leaf key
            # (ignores indexes in the dotted path). Handles both quoted strings
            # and bare numerics (e.g. startTimeUnix=1779985720).
            local key="${path##*.}"; key="${key%%\[*}"
            grep -oE "\"${key}\":(\"[^\"]*\"|[0-9.+eE-]+)" "$file" 2>/dev/null \
              | head -1 | sed "s/\"${key}\"://;s/^\"//;s/\"\$//"
        fi
    }

    if ! have curl; then
        mark SKIPPED "rest-api: curl not available"
    elif [[ -z "${SIM_API_BASE:-}" ]]; then
        mark SKIPPED "rest-api: SIM_API_BASE not set"
    else
        BASE="${SIM_API_BASE%/}"
        AUTH_HDR=()                          # curl args added after auth succeeds

        # ----- 1) Authenticate (POST /v2/login -> JWT) ------------------------
        login_path="${SIM_API_LOGIN_PATH:-/v2/login}"
        code=$(curl -sk -o "${API}/login.json" -w '%{http_code}' \
               -H 'Content-Type: application/json' \
               -X POST "${BASE}${login_path}" \
               --data "{\"username\":\"${SIM_API_USER:-}\",\"password\":\"${SIM_API_PASS:-}\"}" 2>/dev/null)
        TOKEN=""
        if [[ "$code" =~ ^2 ]]; then
            TOKEN="$(json_get "${API}/login.json" access_token)"
        fi
        if [[ -n "$TOKEN" ]]; then
            AUTH_HDR=(-H "Authorization: Bearer ${TOKEN}")
            mark COLLECTED "rest-api: auth = bearer JWT via ${login_path} (HTTP ${code})"
        else
            mark FAILED "rest-api: login to ${login_path} (HTTP ${code:-no-response}) - check SIM_API_USER/PASS"
        fi

        # ----- 2) Resolve iterationId + time window ---------------------------
        # Precedence: LOOKBACK mode > explicit ITERATION_ID > TEST_CASE_NAME lookup > footer auto-discover.
        # In LOOKBACK mode we already set START/END from now-N..now at script
        # entry, so leave them alone and skip the iter resolution entirely —
        # there's no testcase to anchor against.
        ITER="${ITERATION_ID:-}"
        TC_ID=""; TC_NAME="${TEST_CASE_NAME:-}"
        if [[ "${LOOKBACK_ACTIVE:-0}" != "1" ]]; then
            START=""; END=""
        else
            mark COLLECTED "rest-api: LOOKBACK mode active — window = last ${LOOKBACK_MINUTES} min (${START}..${END}), skipping iter resolution"
        fi

        if [[ -n "$TOKEN" && -z "$ITER" && "${LOOKBACK_ACTIVE:-0}" != "1" ]]; then
            if [[ -z "$TC_NAME" || "$TC_NAME" == "LAST_RUN" ]]; then
                # Same endpoint the GUI's footer LAST RUN TEST widget uses.
                code=$(curl -sk "${AUTH_HDR[@]}" -o "${API}/last_run.json" -w '%{http_code}' \
                       "${BASE}/v2/testcases?offset=0&limit=1&source=footer" 2>/dev/null)
                if [[ "$code" =~ ^2 ]]; then
                    TC_ID="$(json_get "${API}/last_run.json" items[0].id)"
                    TC_NAME="$(json_get "${API}/last_run.json" items[0].name)"
                    ITER="$(json_get "${API}/last_run.json" items[0].metadata.lastExecution.executionId)"
                    START="$(json_get "${API}/last_run.json" items[0].metadata.executionHistory[0].startTimeUnix)"
                    END="$(json_get "${API}/last_run.json" items[0].metadata.executionHistory[0].endTimeUnix)"
                    mark COLLECTED "rest-api: auto-discovered last run = ${TC_NAME} iter=${ITER} (HTTP ${code})"
                else
                    mark FAILED "rest-api: footer last-run lookup (HTTP ${code:-no-response})"
                fi
            else
                # Look up by name (GET /v2/testcases/list returns all + history).
                code=$(curl -sk "${AUTH_HDR[@]}" -o "${API}/testcases_list.json" -w '%{http_code}' \
                       "${BASE}/v2/testcases/list" 2>/dev/null)
                if [[ "$code" =~ ^2 ]] && have_python3; then
                    python3 - "${API}/testcases_list.json" "$TC_NAME" > "${API}/.lookup" 2>/dev/null <<'PYEOF'
import json, sys
name = sys.argv[2]
d = json.load(open(sys.argv[1]))
items = d.get("items", d) if isinstance(d, dict) else d
for tc in items if isinstance(items, list) else []:
    if tc.get("name") == name:
        h = (tc.get("metadata", {}).get("executionHistory") or [])
        latest = h[0] if h else {}
        print(tc.get("id",""))
        print(latest.get("iterationId",""))
        print(latest.get("startTimeUnix",""))
        print(latest.get("endTimeUnix",""))
        break
PYEOF
                    { read -r TC_ID; read -r ITER; read -r START; read -r END; } < "${API}/.lookup" 2>/dev/null
                    rm -f "${API}/.lookup"
                    [[ -n "$ITER" ]] \
                        && mark COLLECTED "rest-api: resolved '${TC_NAME}' -> iter=${ITER}" \
                        || mark FAILED "rest-api: '${TC_NAME}' has no execution history in /v2/testcases/list"
                else
                    mark FAILED "rest-api: testcase lookup needs HTTP 2xx + python3 (got HTTP ${code}, python3=$(have_python3 && echo yes || echo no))"
                fi
            fi
        fi

        # ----- 3) Pull per-iteration data -------------------------------------
        if [[ -n "$TOKEN" && -n "$ITER" ]]; then
            # If the run is still IN_PROGRESS the backend returns endTimeUnix=0,
            # which the stats endpoints reject with "startTime must be <= endTime".
            # Substitute "now" so we still get partial data for live runs.
            END_TAG=""
            if [[ -z "$END" || "$END" == "0" ]]; then
                END="$(date +%s)"; END_TAG=" (in-progress: end=now)"
            fi
            # Update manifest header now that we know the actual run.
            {
              echo "Resolved test case: ${TC_NAME:-?}  id=${TC_ID:-?}"
              echo "Resolved iteration: ${ITER}"
              echo "Time window: ${START:-?} - ${END:-?} (Unix seconds)${END_TAG}"
              echo "------------------------------------------------------------"
            } >> "$MANIFEST"

            # testcase definition (config / scenario / success criteria).
            # We pull this in two formats:
            #   1) GET /v2/testcases/<id>           - lightweight metadata +
            #      execution history, kept under rest_api/ for archival.
            #   2) POST /v2/testcases/export        - the full re-importable
            #      JSON the team can drop into POST /v2/testcases/import to
            #      clone or re-run the testcase elsewhere. Stored at the
            #      BUNDLE ROOT as <safe_tcname>.testcase.json so it's the
            #      first thing you see next to ANALYSIS.md and SYSTEM.md.
            if [[ -n "$TC_ID" ]]; then
                code=$(curl -sk "${AUTH_HDR[@]}" -o "${API}/testcase_definition.json" -w '%{http_code}' \
                       "${BASE}/v2/testcases/${TC_ID}" 2>/dev/null)
                [[ "$code" =~ ^2 ]] \
                    && mark COLLECTED "rest-api: testcase metadata (HTTP ${code}) -> rest_api/testcase_definition.json" \
                    || mark FAILED "rest-api: testcase metadata (HTTP ${code}) /v2/testcases/${TC_ID}"

                # Sanitize testcase name for the filename (alphanumeric / dash /
                # underscore only). Falls back to "testcase" if name is empty.
                safe_name=$(echo "${TC_NAME:-${TC_ID}}" | tr -c 'A-Za-z0-9._-' '_' | tr -s '_' | sed 's/^_//;s/_$//')
                [[ -z "$safe_name" ]] && safe_name="testcase"
                export_out="${BUNDLE}/${safe_name}.testcase.json"
                code=$(curl -sk -X POST "${AUTH_HDR[@]}" -H 'Content-Type: application/json' \
                       -d "{\"testCaseIds\":[\"${TC_ID}\"],\"output\":{\"type\":\"json\"}}" \
                       -o "${export_out}" -w '%{http_code}' \
                       "${BASE}/v2/testcases/export" 2>/dev/null)
                if [[ "$code" =~ ^2 ]]; then
                    sz=$(stat -c%s "${export_out}" 2>/dev/null || echo 0)
                    mark COLLECTED "rest-api: testcase JSON (re-importable, HTTP ${code}, ${sz} bytes) -> ${safe_name}.testcase.json"
                else
                    mark FAILED "rest-api: testcase export (HTTP ${code}) /v2/testcases/export"
                    rm -f "${export_out}"
                fi
            fi

            # global statistics (KPIs / throughput / packets / cell metrics over the run)
            q="?startTime=${START}&endTime=${END}&budget=${SIM_API_STATS_BUDGET:-1000}"
            code=$(curl -sk "${AUTH_HDR[@]}" -o "${API}/statistics_global.json" -w '%{http_code}' \
                   "${BASE}/v2/testcases/executions/${ITER}/statistics/global${q}" 2>/dev/null)
            [[ "$code" =~ ^2 ]] \
                && mark COLLECTED "rest-api: global statistics (HTTP ${code}) -> rest_api/statistics_global.json" \
                || mark FAILED "rest-api: global statistics (HTTP ${code})"

            # cells summary (per-cell aggregates over the run)
            code=$(curl -sk "${AUTH_HDR[@]}" -o "${API}/statistics_cells.json" -w '%{http_code}' \
                   "${BASE}/v2/testcases/executions/${ITER}/statistics/cells-summary?startTime=${START}&endTime=${END}" 2>/dev/null)
            [[ "$code" =~ ^2 ]] \
                && mark COLLECTED "rest-api: cells summary (HTTP ${code}) -> rest_api/statistics_cells.json" \
                || mark FAILED "rest-api: cells summary (HTTP ${code})"

            # UE summary (per-UE NAS/RRC state, category) — POST with time window
            code=$(curl -sk "${AUTH_HDR[@]}" -o "${API}/statistics_ue.json" -w '%{http_code}' \
                   -H 'Content-Type: application/json' -X POST \
                   --data "{\"startTime\":${START},\"endTime\":${END}}" \
                   "${BASE}/v2/testcases/executions/${ITER}/statistics/ue-summary" 2>/dev/null)
            [[ "$code" =~ ^2 ]] \
                && mark COLLECTED "rest-api: UE summary (HTTP ${code}) -> rest_api/statistics_ue.json" \
                || mark FAILED "rest-api: UE summary (HTTP ${code})"

            # GUI screenshots — full-page PNGs of Global / Cell / UE Statistics
            # + Logs pages, scoped to the resolved iterationId. Same Playwright
            # venv as Beszel; falls through silently if unconfigured.
            sim_shot="${SIM_SCREENSHOT_SCRIPT:-${SCRIPT_DIR}/simnovator_screenshot.py}"
            if [[ -n "${SIM_PYTHON:-${BESZEL_PYTHON:-}}" \
                  && -x "${SIM_PYTHON:-${BESZEL_PYTHON:-}}" \
                  && -f "$sim_shot" ]]; then
                shot_dir="${API}/screenshots"
                mkdir -p "$shot_dir"
                if "${SIM_PYTHON:-${BESZEL_PYTHON}}" "$sim_shot" \
                      --base "$BASE" \
                      --user "$SIM_API_USER" --password "$SIM_API_PASS" \
                      --iteration-id "$ITER" --testcase "$TC_NAME" \
                      --testcase-status "${SIM_TESTCASE_STATUS:-Completed}" \
                      --out-dir "$shot_dir" \
                      --pages "${SIM_SCREENSHOT_PAGES:-global,cell,ue,logs}" \
                      >> "$LOG" 2>&1; then
                    for png in "$shot_dir"/*.png; do
                        [[ -f "$png" ]] || continue
                        psz=$(stat -c%s "$png" 2>/dev/null || echo 0)
                        mark COLLECTED "rest-api: GUI screenshot $(basename "$png") -> rest_api/screenshots/$(basename "$png") (${psz} bytes)"
                    done
                else
                    mark FAILED "rest-api: GUI screenshots (see collect.log)"
                fi
            else
                mark NOTE "rest-api: GUI screenshots disabled (set SIM_PYTHON or BESZEL_PYTHON to a playwright venv)"
            fi

            # logs export — ZIP of the application-layer log records (RRC/NAS/...).
            # Extract the CSV inside so the bundle exposes it directly without
            # needing to unzip (same format the GUI gives via the Export button).
            code=$(curl -sk "${AUTH_HDR[@]}" -o "${API}/logs_export.zip" -w '%{http_code}' \
                   "${BASE}/v2/testcases/executions/${ITER}/logs/export" 2>/dev/null)
            if [[ "$code" =~ ^2 ]]; then
                sz=$(stat -c%s "${API}/logs_export.zip" 2>/dev/null || echo 0)
                mark COLLECTED "rest-api: logs export ZIP (HTTP ${code}, ${sz} bytes) -> rest_api/logs_export.zip"
                # Extract any CSV inside (Simnovator ships exactly one CSV per ZIP).
                if have unzip; then
                    unzip -j -o -q "${API}/logs_export.zip" '*.csv' -d "$API" 2>/dev/null
                    for csv in "${API}"/*.csv; do
                        [[ -f "$csv" ]] || continue
                        csz=$(stat -c%s "$csv" 2>/dev/null || echo 0)
                        mark COLLECTED "rest-api: logs CSV (extracted) -> rest_api/$(basename "$csv") (${csz} bytes)"
                    done
                fi
            else
                mark FAILED "rest-api: logs export (HTTP ${code})"
                rm -f "${API}/logs_export.zip"
            fi
        elif [[ -n "$TOKEN" ]]; then
            mark SKIPPED "rest-api: could not resolve iterationId (set TEST_CASE_NAME, ITERATION_ID, or leave both blank for auto)"
        fi
        # Don't ship the live JWT in the bundle — token TTL is ~3h.
        rm -f "${API}/login.json"
    fi
fi

# ===========================================================================
# 6) SIMNOVATOR CONTAINER LOGS (time-windowed). Re-runs the per-container log
#    dump using --since=<ISO START> --until=<ISO END> so we get only output
#    from the resolved test iteration. Falls back to --tail if START unknown.
# ===========================================================================
if [[ "$COLLECT_SIMNOVATOR" == "1" && -n "${SIMNOVATOR_HOST:-}" && -f "${BUNDLE}/.sim_containers" ]]; then
    clist="$(cat "${BUNDLE}/.sim_containers" 2>/dev/null)"
    rm -f "${BUNDLE}/.sim_containers"
    if [[ -n "$clist" ]]; then
        # Build the --since/--until ISO strings (UTC). If START is missing we
        # fall back to --tail-only so container logs aren't lost entirely.
        if [[ -n "${START:-}" && "$START" != "0" ]]; then
            iso_start="$(date -u -d "@$START" +%FT%TZ 2>/dev/null)"
            iso_end="$(date -u -d "@${END:-$(date +%s)}" +%FT%TZ 2>/dev/null)"
            log "--- Simnovator container logs (window ${iso_start} .. ${iso_end}) ---"
            log_args="logs --since=${iso_start} --until=${iso_end} --tail ${DOCKER_LOG_TAIL}"
        else
            log "--- Simnovator container logs (no test window resolved; --tail only) ---"
            log_args="logs --tail ${DOCKER_LOG_TAIL}"
        fi

        # Per-container app log paths inside the container — declared up front
        # so the 0-byte cleanup loop below can reference it. Section 6b reuses
        # the same array to copy each app log file out via `podman exec ... tail`.
        declare -A SIM_APP_LOGS=(
            [simnovator-api-gateway]="./go-api-gateway.log"
            [simnovator-authenticator]="./go-auth.log"
            [simnovator-executor]="./go-executor.log"
            [simnovator-worker]="./bin/worker.log"
            [simnovator-stats]="./go-stats.log"
            [simnovator-test-creator]="./simnovator-testcase-creator.log"
            [simnovator-test-processor]="./simnovator-test-processor.log"
        )

        for c in $clist; do
            lc="$(sim_logical_name "$c")"
            sim_podman "simnovator/container_logs/${lc}.log" \
                "simnovator: container log ${lc} (windowed)" $log_args "$c"
            # Most Simnovator services route their app logs to *files inside
            # the container* (captured below in container_files/), so podman
            # stdout is often empty for the test window. Drop the 0-byte
            # placeholder + replace COLLECTED with a NOTE pointing at the
            # in-container log file. Keeps the bundle visibly clean — only
            # services that actually emit stdout end up with a .log file.
            # (Quadlet hosts: the systemd journal in 6c is the fuller source.)
            f="${BUNDLE}/simnovator/container_logs/${lc}.log"
            if [[ -f "$f" && ! -s "$f" ]]; then
                rm -f "$f"
                hint=""
                [[ -n "${SIM_APP_LOGS[$lc]:-}" ]] && hint=" (see container_files/${lc}/$(basename "${SIM_APP_LOGS[$lc]}"))"
                mark NOTE "simnovator: container log ${lc} empty in window — dropped${hint}"
            fi
        done

        # ----- 6b) In-container application log files (per engineering, May 2026)
        # The `podman logs` output above is stdout/stderr only. The app processes
        # ALSO write their own log files inside the container (configured via
        # log.location + application.name in each service's config). Paths come
        # from Ritesh's table; resolved relative to the container's WORKDIR via
        # `podman exec <c> sh -c "tail -n N <path>"`. Tail-capped to keep the
        # bundle bounded (same cap as the podman log capture). Missing files
        # (container present but log not written yet) mark FAILED with cat's
        # "No such file or directory" landing in the file — informative either way.
        mkdir -p "${BUNDLE}/simnovator/container_files"
        log "--- Simnovator in-container app logs (tail -n ${DOCKER_LOG_TAIL}) ---"
        for key in "${!SIM_APP_LOGS[@]}"; do
            # Resolve the actual running container name: bare (podman-compose /
            # explicit ContainerName) or systemd-prefixed (quadlet default).
            # Bundle path stays keyed on the logical name either way.
            actual=""
            if   grep -qw "$key"          <<<"$clist"; then actual="$key"
            elif grep -qw "systemd-$key"  <<<"$clist"; then actual="systemd-$key"
            fi
            if [[ -z "$actual" ]]; then
                mark SKIPPED "simnovator: app log ${key} (container not running)"
                continue
            fi
            rel="${SIM_APP_LOGS[$key]}"
            fname="$(basename "$rel")"
            mkdir -p "${BUNDLE}/simnovator/container_files/${key}"
            # `|| true` so a missing file doesn't hard-FAIL: on the quadlet
            # release several services log only to stdout (captured in journal/)
            # and no longer write this app-log FILE. We downgrade those to a
            # NOTE after the fact instead of reddening the pipeline.
            sim_podman "simnovator/container_files/${key}/${fname}" \
                "simnovator: app log ${key}:${rel}" \
                exec "$actual" sh -c "tail -n ${DOCKER_LOG_TAIL:-20000} '${rel}' 2>&1 || true"
            af="${BUNDLE}/simnovator/container_files/${key}/${fname}"
            if [[ -f "$af" ]] && grep -qiE 'no such file or directory|cannot open' "$af" 2>/dev/null; then
                rm -f "$af"
                mark NOTE "simnovator: app log ${key} file absent on this release — stdout captured in journal/${key}.journal.log"
            fi
        done

        # ----- 6c) systemd journal per container ------------------------------
        # On the quadlet (5.x) release each service runs as a rootless podman
        # container whose stdout is routed to journald tagged CONTAINER_NAME=
        # <name>.  NOTE: `journalctl -u <unit>` is EMPTY for rootless user units
        # under a plain (system) journalctl, so we query by CONTAINER_NAME —
        # which returns the logs and needs no sudo (verified on the .91 rack).
        # The journal is the authoritative source on quadlet hosts: it survives
        # container restarts (podman logs only has the current instance) and
        # records the conmon health/restart events podman stdout never shows.
        # Windowed to the test/lookback window. Per-container files mirror the
        # container_files/ layout so the analyzer can attribute errors.
        # Pre-quadlet hosts (json-file log driver) return "-- No entries --" and
        # the file is dropped, so they cost nothing.
        if [[ -n "${START:-}" && "$START" != "0" ]]; then
            jwin="--since @${START} --until @${END:-$(date +%s)}"
        else
            jwin="-n ${DOCKER_LOG_TAIL:-20000}"
        fi
        mkdir -p "${BUNDLE}/simnovator/journal"
        log "--- Simnovator systemd journal per container (window: ${jwin}) ---"
        for c in $clist; do
            lc="$(sim_logical_name "$c")"
            # Drop the benign "Journal file ... corrupted, ignoring file" notice
            # journald emits when one rotated user-journal is unreadable.
            jcmd="journalctl CONTAINER_NAME='${c}' ${jwin} --no-pager 2>&1 | grep -v 'corrupted, ignoring file' || true"
            sim_run "simnovator/journal/${lc}.journal.log" "simnovator: journal ${lc}" "$jcmd"
            # Drop files with no real log lines (empty / "-- No entries --" /
            # "-- Journal begins" only) — same hygiene as the 0-byte podman logs.
            jf="${BUNDLE}/simnovator/journal/${lc}.journal.log"
            if [[ -f "$jf" ]] && ! grep -qvE '^[[:space:]]*$|-- No entries --|-- Journal begins|-- Boot' "$jf" 2>/dev/null; then
                rm -f "$jf"
                mark NOTE "simnovator: journal ${lc} empty in window — dropped"
            fi
        done

        # ----- 6d) native `simnovator logs` archive ---------------------------
        # The 5.x release ships a built-in log bundler. Confirmed real syntax
        # (on the .91/.95/.202 racks):
        #     sudo simnovator logs <since>
        #   where <since> is a duration (30m / 2h / 60s) or a date (YYYY-MM-DD),
        #   default 72h. It prints "Logs successfully archived to: <path>" and
        #   writes /home/simnovus/simnovator-<since>-logs.tar.gz. We:
        #     1. record CLI presence + `simnovator help` (captures live syntax),
        #     2. run it for OUR window (minutes, so never the 72h default),
        #        parse the archived path from its output, stream the .tar.gz
        #        back binary-safe, then remove it from /home/simnovus.
        # Best-effort: absent CLI / disabled => NOTE, never FAILED.
        mkdir -p "${BUNDLE}/simnovator/native_logs"
        sim_run "simnovator/native_logs/cli.txt" "simnovator: native CLI presence" \
            "command -v simnovator >/dev/null 2>&1 && echo present || echo 'absent (pre-quadlet release)'"
        sim_run "simnovator/native_logs/logs_help.txt" "simnovator: 'simnovator' help (live syntax)" \
            "sudo -n simnovator help 2>&1 || simnovator help 2>&1 || simnovator logs --help 2>&1 || echo '(no help available / CLI absent)'"

        if [[ "${SIM_NATIVE_LOGS:-auto}" == "0" ]]; then
            mark NOTE "simnovator: native-logs archive disabled (SIM_NATIVE_LOGS=0)"
        elif grep -qi 'absent' "${BUNDLE}/simnovator/native_logs/cli.txt" 2>/dev/null; then
            mark NOTE "simnovator: native 'simnovator logs' CLI not present (pre-quadlet release) — podman+journal already captured"
        else
            # Window in minutes (>=1). Prefer the explicit lookback, else derive
            # from START/END, else default 60.
            if [[ -n "${LOOKBACK_MINUTES:-}" ]]; then
                nl_mins="$LOOKBACK_MINUTES"
            elif [[ -n "${START:-}" && "$START" != "0" ]]; then
                nl_mins=$(( ( ${END:-$(date +%s)} - START + 59 ) / 60 ))
            else
                nl_mins=60
            fi
            (( nl_mins < 1 )) && nl_mins=1
            nl_dur="${nl_mins}m"
            # Remote: run `sudo simnovator logs <dur>`, parse the "archived to:"
            # path it prints (fall back to newest /home/simnovus/*logs*.tar.gz),
            # cat the archive to stdout (binary-safe via sim_pipe_best_effort),
            # then delete it so /home/simnovus doesn't accumulate our test runs.
            # NOTE: the archive lands in root-owned /home/simnovus, which the
            # SSH user can't traverse — so every existence test must go through
            # `sudo -n test -f` (a plain [ -f ] returns false even though the
            # file is there). cat/rm likewise need sudo.
            nl_cmd="out=\$(timeout 180 sudo -n simnovator logs ${nl_dur} 2>&1); p=\$(printf '%s\n' \"\$out\" | sed -n 's/.*archived to:[[:space:]]*//p' | tail -1); if [ -z \"\$p\" ] || ! sudo -n test -f \"\$p\"; then p=\$(sudo -n find /home/simnovus -maxdepth 2 -name 'simnovator-*logs*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-); fi; if [ -n \"\$p\" ] && sudo -n test -f \"\$p\"; then sudo -n cat \"\$p\"; sudo -n rm -f \"\$p\"; fi"
            nl_out="simnovator/native_logs/simnovator-${nl_dur}-logs.tar.gz"
            sim_pipe_best_effort "$nl_out" "simnovator: native logs archive (last ${nl_dur})" "$nl_cmd"
        fi
    fi
fi

# ===========================================================================
# 6f) UE-HOST SIMNOVATOR APP MANAGER JOURNAL (time-windowed)
#     The Simnovator App Manager on the UE-sim host runs as a systemd service
#     (start_app_manager.sh) and logs to journald — NOT a flat file — so the
#     UESIM log tar in section 1 never captures it. We grab it here (post-REST,
#     so START/END is resolved in test-case mode too) over the full test /
#     lookback window — i.e. the whole run, however long it ran or failed for.
#     Identifier is overridable via UE_APP_MANAGER_IDENT. Try sudo first, fall
#     back to plain journalctl (works if the user is in the systemd-journal
#     group). Empty in window => dropped (host not using journald). The analyzer
#     scans ue/logs/*.journal.log, so its error/CRITICAL hits land in ANALYSIS.md.
# ===========================================================================
if [[ "$COLLECT_UE" == "1" && -n "${UE_HOST:-}" ]]; then
    AM_IDENT="${UE_APP_MANAGER_IDENT:-start_app_manager.sh}"
    if [[ -n "${START:-}" && "$START" != "0" ]]; then
        am_win="--since @${START} --until @${END:-$(date +%s)}"
    else
        am_win="-n 50000"
    fi
    log "--- UE Simnovator App Manager journal (ident=${AM_IDENT}, window: ${am_win}) ---"
    ue_capture "ue/logs/app_manager.journal.log" "ue: app-manager journal (${AM_IDENT})" \
        "{ sudo -n journalctl -t '${AM_IDENT}' ${am_win} --no-pager 2>/dev/null || journalctl -t '${AM_IDENT}' ${am_win} --no-pager 2>&1; } | grep -v 'corrupted, ignoring file' || true"
    amf="${BUNDLE}/ue/logs/app_manager.journal.log"
    if [[ -f "$amf" ]] && ! grep -qvE '^[[:space:]]*$|-- No entries --|-- Journal begins|-- Boot' "$amf" 2>/dev/null; then
        rm -f "$amf"
        mark NOTE "ue: app-manager journal empty in window (ident=${AM_IDENT}) — dropped"
    fi
fi

# ===========================================================================
# 7) HEAT MONITOR (SDR FPGA/RFIC temps from the heat-monitor service on each
#    host that runs it: UE / Simnovator / Callbox / App-server).
#    /root/heat-monitor-logs/heat-monitor_*.csv has per-second readings with
#    STATUS=idle/active and 16 SDR temp columns. We grab only CSV files mtime
#    >= START, plus the .conf and sdrInfo.txt for context. Same script over
#    SSH to each host so the bundle structure is symmetric: <host>/heat/.
# ===========================================================================
heat_remote_script() {  # <start_unix_ts>
    cat <<HEATSH
#!/bin/bash
# Build the file list: always include .conf + sdrInfo, plus CSVs newer than
# the test-window start (or all CSVs if the service has none modified since).
files=()
[[ -e /root/heat-monitor.conf ]]             && files+=(/root/heat-monitor.conf)
[[ -e /root/heat-monitor-logs/sdrInfo.txt ]] && files+=(/root/heat-monitor-logs/sdrInfo.txt)
ts="\$(mktemp)"; touch -d "@${1:-0}" "\$ts" 2>/dev/null || touch "\$ts"
while IFS= read -r f; do files+=("\$f"); done < <(
  sudo -n find /root/heat-monitor-logs -maxdepth 1 \\
       -name 'heat-monitor*.csv' -newer "\$ts" 2>/dev/null | head -20
)
# Latest heat-monitor.log (one per service run); pick the newest mtime.
last_log="\$(sudo -n ls -1t /root/heat-monitor-*.log 2>/dev/null | head -1)"
[[ -n "\$last_log" ]] && files+=("\$last_log")
rm -f "\$ts"
if [[ \${#files[@]} -gt 0 ]]; then
    sudo -n tar czf - --ignore-failed-read "\${files[@]}" 2>/dev/null
fi
HEATSH
}

if [[ "${COLLECT_HEAT:-1}" == "1" ]]; then
    log "--- heat-monitor ---"
    heat_script="$(heat_remote_script "${START:-0}")"
    # SDRs only live on the UE and the Callbox — those are the only hosts whose
    # heat-monitor CSVs are meaningful. Skipping Simnovator + app-server.
    for spec in "ue:${UE_HOST:-}:${UE_USER:-sysadmin}:${UE_SSH_PORT:-22}:${UE_PASS:-}" \
                "callbox:${CALLBOX_HOST:-}:${CALLBOX_USER:-sysadmin}:${CALLBOX_SSH_PORT:-22}:${CALLBOX_PASS:-}"; do
        IFS=':' read -r role host user port pass <<<"$spec"
        [[ -z "$host" ]] && continue   # host not configured -> skip
        remote_script_pipe "$host" "$user" "$port" \
            "${role}/heat/heat_logs.tar.gz" "heat: ${role} (${host})" \
            "$pass" "$heat_script"
    done
fi

# ===========================================================================
# 8) iperf logs (UE-host-side; runs after REST so we have the test window).
#    The Simnovator app-manager writes per-run timestamped subdirs under
#    IPERF_LOG_DIR. We tar the subdirs whose mtime falls within (or near)
#    the resolved test window. If START isn't known, fall back to "newest".
# ===========================================================================
if [[ "${COLLECT_IPERF:-1}" == "1" && -n "${IPERF_LOG_DIR:-}" ]]; then
    log "--- iperf logs ---"
    mkdir -p "${BUNDLE}/ue"
    # Choose find criterion. START comes from REST section (Unix seconds).
    if [[ -n "${START:-}" && "$START" != "0" ]]; then
        # Grab dirs modified after START-60s (give a 1-min slack on either side)
        cutoff=$(( START - 60 ))
        find_pred="-newermt @${cutoff}"
        desc="newer than test start (${START})"
    else
        find_pred=""   # signal: take newest only
        desc="newest subdir only (no test window resolved)"
    fi
    cap="${IPERF_MAX_SUBDIRS:-10}"
    # Build the tar pipeline. sudo on every step because /root/simnovator-app-manager
    # is root-owned (sysadmin can't even cd into it). Avoid `cd` entirely; use
    # absolute paths + tar -C.
    if [[ -n "$find_pred" ]]; then
        iperf_cmd="subdirs=\$(sudo -n find '${IPERF_LOG_DIR}' -maxdepth 1 -mindepth 1 -type d $find_pred -printf '%f\\n' 2>/dev/null | sort -r | head -${cap}); if [[ -n \"\$subdirs\" ]]; then sudo -n tar czf - -C '${IPERF_LOG_DIR}' \$subdirs; else exit 2; fi"
    else
        iperf_cmd="newest=\$(sudo -n ls -1t '${IPERF_LOG_DIR}' 2>/dev/null | head -1); [[ -n \"\$newest\" ]] && sudo -n tar czf - -C '${IPERF_LOG_DIR}' \"\$newest\" || exit 2"
    fi
    mkdir -p "${BUNDLE}/ue/logs"
    # Optional: a window with no iperf run yields no subdirs (cmd exits 2) — that
    # is SKIPPED, not FAILED.
    if [[ -n "${UE_HOST:-}" ]]; then
        remote_pipe_optional "$UE_HOST" "${UE_USER:-sysadmin}" "${UE_SSH_PORT:-22}" \
            "ue/logs/iperf_logs.tar.gz" "iperf: logs ($desc)" "$iperf_cmd" "${UE_PASS:-}"
    else
        remote_pipe_optional "" "" "" "ue/logs/iperf_logs.tar.gz" "iperf: logs ($desc)" "$iperf_cmd"
    fi
fi

# ===========================================================================
# 8b) SYSTEM.md — cross-host inventory summary built from each
#     <role>/system/host_info.txt the probes wrote during sections 1-4. Runs
#     before the analyzer so the analyzer (or a human) can correlate findings
#     against the actual hardware/OS at the top of the bundle.
# ===========================================================================
sysmd_script="${SCRIPT_DIR}/build_system_md.py"
sysmd_py="${ANALYZE_PYTHON:-${BESZEL_PYTHON:-python3}}"
if [[ -f "$sysmd_script" ]] && have_python3 || [[ -x "$sysmd_py" ]]; then
    if "$sysmd_py" "$sysmd_script" --bundle "$BUNDLE" >> "$LOG" 2>&1; then
        sz=$(stat -c%s "${BUNDLE}/SYSTEM.md" 2>/dev/null || echo 0)
        mark COLLECTED "system: cross-host summary -> SYSTEM.md (${sz} bytes)"
    else
        mark FAILED "system: SYSTEM.md generation (see collect.log)"
    fi
else
    mark SKIPPED "system: build_system_md.py or python3 not available"
fi

# ===========================================================================
# 9) ANALYSIS — produce a one-page summary (ANALYSIS.md) from the collected
#    files. Cheap heuristics: SDR + CPU temps, container up/total + log error
#    grep, UESIM log error grep. Runs as the last thing before we zip so the
#    report is included inside the bundle.
# ===========================================================================
if [[ "${COLLECT_ANALYZE:-1}" == "1" ]]; then
    log "--- analysis ---"
    analyzer="${ANALYZE_SCRIPT:-${SCRIPT_DIR}/analyze_bundle.py}"
    analyze_py="${ANALYZE_PYTHON:-${BESZEL_PYTHON:-python3}}"
    if [[ -f "$analyzer" ]] && have_python3 || [[ -x "$analyze_py" ]]; then
        if "$analyze_py" "$analyzer" --bundle "$BUNDLE" >> "$LOG" 2>&1; then
            sz=$(stat -c%s "${BUNDLE}/ANALYSIS.md" 2>/dev/null || echo 0)
            mark COLLECTED "analyze: summary report -> ANALYSIS.md (${sz} bytes)"
        else
            mark FAILED "analyze: report generation (see collect.log)"
        fi
    else
        mark SKIPPED "analyze: analyze_bundle.py or python3 not available"
    fi
fi

# ===========================================================================
# Wrap up
#   Rename the placeholder bundle dir to `<testcase>_diagnostics_<TS>`. Use
#   TC_NAME if REST resolved one, else fall back to TEST_CASE_NAME, else to
#   the hostname. Sanitize so the dir/zip name is shell- and Windows-safe.
#   Output is .zip (one-click on any OS) — falls back to .tar.gz if `zip`
#   isn't installed.
# ===========================================================================
{
  echo "============================================================"
  echo "Collection finished: $(date)"
} >> "$MANIFEST"

# Decide the final bundle name.
TC_FOR_NAME="${TC_NAME:-${TEST_CASE_NAME:-${HOST}}}"
# Replace anything non-alphanumeric/-/_/. with underscore; collapse repeats.
SAFE_TC="$(echo "$TC_FOR_NAME" | tr -c 'A-Za-z0-9._-' '_' | tr -s '_' | sed 's/^_//;s/_$//')"
[[ -z "$SAFE_TC" ]] && SAFE_TC="$HOST"
FINAL_BUNDLE="${OUTPUT_DIR}/${SAFE_TC}_diagnostics_${TS}"
if [[ "$BUNDLE" != "$FINAL_BUNDLE" ]]; then
    mv "$BUNDLE" "$FINAL_BUNDLE"
    BUNDLE="$FINAL_BUNDLE"
    LOG="${BUNDLE}/collect.log"
    MANIFEST="${BUNDLE}/MANIFEST.txt"
fi

ARCHIVE_OK=0
if have zip; then
    ARCHIVE="${BUNDLE}.zip"
    rm -f "$ARCHIVE"
    if (cd "$OUTPUT_DIR" && zip -rq "$(basename "$ARCHIVE")" "$(basename "$BUNDLE")") 2>>"$LOG"; then
        ARCHIVE_OK=1
    fi
elif have tar; then
    ARCHIVE="${BUNDLE}.tar.gz"
    if tar -czf "$ARCHIVE" -C "$OUTPUT_DIR" "$(basename "$BUNDLE")" 2>>"$LOG"; then
        ARCHIVE_OK=1
    fi
else
    ARCHIVE=""
fi

if [[ "$ARCHIVE_OK" == "1" ]]; then
    log "=== Done. Bundle: $ARCHIVE ==="
    echo
    echo "Collected/skipped summary:"
    grep -E '^(COLLECTED|SKIPPED|FAILED|TRUNCATED|NOTE)' "$MANIFEST" | sort | uniq -c | sort -rn
    echo
    echo "Bundle dir : $BUNDLE"
    echo "Archive    : $ARCHIVE"
else
    log "WARNING: zip/tar failed or unavailable; raw bundle is at $BUNDLE"
fi

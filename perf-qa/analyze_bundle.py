#!/usr/bin/env python3
"""Analyze a perf-qa diagnostics bundle and emit a one-page summary report.

Reads an UNPACKED bundle directory and inspects the files we already collected
(no extra SSH calls). Produces:

  * `ANALYSIS.md` at the bundle root — human-readable status per area.
  * One status per area: OK / WARN / FAIL — based on simple thresholds. The
    raw data stays in the bundle; the report just calls attention to anything
    that crosses a line.

Areas covered:
  * Test result (rest_api/last_run.json)
  * Heat (UE + Callbox heat-monitor CSVs — SDR FPGA/RFIC + CPU temps)
  * CPU pinning (ue/cpu/cpu_affinity.txt — perf processes pinned, IRQs off)
  * Containers (simnovator/ps.txt up/total + per-container error grep)
  * UESIM log (ue/logs/ots.log error grep)
  * Callbox (callbox/amari_monitor.txt error grep)

Thresholds for SDR/CPU temps mirror the values heat-monitor itself uses to
trigger throttling (75°C FPGA / 80°C RFIC by default, see heat-monitor.conf).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import tarfile
from pathlib import Path

# --- Thresholds -----------------------------------------------------------
SDR_FPGA_WARN, SDR_FPGA_FAIL = 70.0, 75.0   # °C  (matches heat-monitor default)
SDR_RFIC_WARN, SDR_RFIC_FAIL = 75.0, 80.0   # °C  (AD9371)
CPU_WARN,      CPU_FAIL      = 75.0, 90.0   # °C

# Real-problem patterns. We split into:
#   CRITICAL_RE — almost-certain trouble (stack traces, panics, OOMs).
#   ERR_RE     — broader "ERROR / EXCEPTION / TIMEOUT" hits; need noise filter.
CRITICAL_RE = re.compile(
    r"\b(FATAL|PANIC|TRACEBACK|SEGFAULT|OOMKilled?|core\s+dumped)\b"
)
ERR_RE = re.compile(
    r"\b(ERROR|EXCEPTION|TIMEOUT|REFUSED|DENIED|DISCONNECTED|UNREACHABLE)\b",
    re.IGNORECASE,
)
# Lines that LOOK like errors but aren't:
#   * Java/keycloak lines that are WARN-level but mention *_ERROR in a `type="..."` field
#   * UE Amarisoft "Event 'error':" lines — `error` is the event NAME, not severity
#   * `error_count=0` / `errors: 0` / `no error` / `0 errors`
#   * Field references: `_error`, `errCount`, `: error_field` (snake_case names)
NOISE_RE = re.compile(
    r"^\s*\S+\s+WARN|"                 # WARN-level log lines (Java/Keycloak)
    r"Event\s+'error'|"                # Amarisoft UE event-name
    r"error_count\s*[:=]\s*0|"         # zero-count fields
    r"errors?\s*[:=]\s*0|"
    r"no\s+errors?|"
    r"zero\s+errors?|"
    r"_error\b|"                       # snake_case field names
    r"errCount\b|"
    r'"error":\s*"?(null|none|0)|'
    # Structured logs the app itself tags as non-error: a level=info/debug/trace
    # line is not an error hit even if its message/command contains an error
    # keyword. (app-manager INFO "Constructed IPerf command ... --rcv-timeout"
    # matched TIMEOUT and inflated the count by ~80k on a 72h run.)
    r"level\s*=\s*(?:info|debug|trace)\b|"
    r'"level"\s*:\s*"(?:info|debug|trace)"|'
    r"rcv-timeout",                     # iperf flag name, not a timeout error
    re.IGNORECASE,
)


# --- Per-area analyzers ---------------------------------------------------
def _temp_status(fpga: float, rfic: float, cpu: float) -> str:
    if fpga >= SDR_FPGA_FAIL or rfic >= SDR_RFIC_FAIL or cpu >= CPU_FAIL:
        return "FAIL"
    if fpga >= SDR_FPGA_WARN or rfic >= SDR_RFIC_WARN or cpu >= CPU_WARN:
        return "WARN"
    return "OK"


def analyze_heat(bundle: Path) -> list[tuple[str, str, str]]:
    """For each <host>/heat/heat_logs.tar.gz find the CSV(s) inside and
    compute peak SDR + CPU temps over rows with STATUS=active. Returns a
    list of (host, status, summary_line).

    When there are zero active samples we look at the tarball more carefully
    to distinguish "host was genuinely idle" (recent CSVs, just no test
    activity) from "heat-monitor service died" (no CSVs at all, or all CSVs
    months old) — the latter is a *collection* problem the user needs to fix
    on the host, not a benign skip.
    """
    out: list[tuple[str, str, str]] = []
    for tar_path in sorted(bundle.glob("*/heat/heat_logs.tar.gz")):
        host = tar_path.parent.parent.name
        peak_fpga = peak_rfic = peak_cpu = 0.0
        active_rows = csv_count = 0
        newest_csv_mtime = 0  # epoch seconds; 0 means none seen
        try:
            with tarfile.open(tar_path, "r:gz") as t:
                for m in t.getmembers():
                    if not m.name.endswith(".csv"):
                        continue
                    csv_count += 1
                    if m.mtime > newest_csv_mtime:
                        newest_csv_mtime = int(m.mtime)
                    f = t.extractfile(m)
                    if not f:
                        continue
                    text = f.read().decode("utf-8", errors="replace")
                    reader = csv.DictReader(io.StringIO(text))
                    for row in reader:
                        if (row.get("STATUS") or "").strip() != "active":
                            continue
                        active_rows += 1
                        for i in range(8):
                            for label, peak_var in (
                                (f"SDR{i}-FPGA(°C)", "peak_fpga"),
                                (f"SDR{i}-RFIC(°C)", "peak_rfic"),
                            ):
                                raw = (row.get(label) or "").strip()
                                if raw in ("", "-"):
                                    continue
                                try:
                                    v = float(raw)
                                except ValueError:
                                    continue
                                if peak_var == "peak_fpga" and v > peak_fpga:
                                    peak_fpga = v
                                elif peak_var == "peak_rfic" and v > peak_rfic:
                                    peak_rfic = v
                        raw = (row.get("CPU-TEMP(°C)") or "").strip()
                        if raw not in ("", "-"):
                            try:
                                v = float(raw)
                                if v > peak_cpu:
                                    peak_cpu = v
                            except ValueError:
                                pass
        except Exception as exc:  # noqa: BLE001
            out.append((host, "ERR", f"could not read tarball ({exc})"))
            continue
        if active_rows == 0:
            # Distinguish "no CSVs at all" vs "CSVs exist but all stale" vs
            # "recent CSVs but no active samples".
            if csv_count == 0:
                out.append((host, "WARN",
                            "no heat-monitor CSVs in tarball — service likely "
                            "not running on this host"))
            else:
                import datetime as _dt
                age_days = (int(_dt.datetime.now().timestamp()) - newest_csv_mtime) // 86400
                if age_days >= 1:
                    newest = _dt.datetime.fromtimestamp(newest_csv_mtime).strftime("%Y-%m-%d")
                    out.append((host, "WARN",
                                f"{csv_count} CSV(s) but newest is {age_days}d old "
                                f"({newest}) — heat-monitor likely stopped"))
                else:
                    out.append((host, "OK",
                                f"{csv_count} CSV(s), no `active` samples in window (idle host)"))
            continue
        status = _temp_status(peak_fpga, peak_rfic, peak_cpu)
        msg = (
            f"peak SDR-FPGA={peak_fpga:.0f}°C · RFIC={peak_rfic:.0f}°C · "
            f"CPU={peak_cpu:.0f}°C  ({active_rows} active samples)"
        )
        out.append((host, status, msg))
    return out


def analyze_test(bundle: Path) -> dict | None:
    f = bundle / "rest_api" / "last_run.json"
    if not f.exists():
        return None
    try:
        d = json.loads(f.read_text(errors="replace"))
        item = (d.get("items") or [{}])[0]
        meta = item.get("metadata") or {}
        last = meta.get("lastExecution") or {}
        return {
            "name":       item.get("name", "?"),
            "status":     last.get("status", "?"),
            "result":     last.get("result", "?"),
            "duration_s": int(last.get("durationSeconds") or 0),
        }
    except Exception:  # noqa: BLE001
        return None


def analyze_cpu(bundle: Path) -> tuple[str, str] | None:
    """Quick read of ue/cpu/cpu_affinity.txt — flag if a perf process has no
    taskset pinning (i.e. running on the default all-cores mask)."""
    f = bundle / "ue" / "cpu" / "cpu_affinity.txt"
    if not f.exists():
        return None
    text = f.read_text(errors="replace")
    # Same pid often shows up under multiple `pname` entries when pgrep -f
    # cross-matches (e.g. "app-manager" appears in the lteue cmdline). Keep
    # only the first PROCESS header per pid.
    raw = re.findall(r"^PROCESS:\s+(\S+)\s+PID:\s+(\d+)", text, re.MULTILINE)
    seen: set[str] = set()
    procs: list[tuple[str, str]] = []
    for proc, pid in raw:
        if pid in seen:
            continue
        seen.add(pid)
        procs.append((proc, pid))
    if not procs:
        return ("OK", "no perf processes matched (test not running on UE?)")
    unpinned = []
    for proc, pid in procs:
        # The Cpus_allowed_list line right after each PROCESS header tells us
        # what the kernel actually allowed — "0-N" means every core (= not pinned).
        block_match = re.search(
            rf"PROCESS:\s+{re.escape(proc)}\s+PID:\s+{re.escape(pid)}(.*?)(?=\nPROCESS:|\Z)",
            text, re.DOTALL,
        )
        if not block_match:
            continue
        block = block_match.group(1)
        allowed = re.search(r"Cpus_allowed_list:\s+([\d,\-]+)", block)
        if not allowed:
            continue
        spec = allowed.group(1)
        # If it spans 0-(N-1) we treat as unpinned. Cheap heuristic.
        if re.fullmatch(r"0-\d{2,}", spec):
            unpinned.append(f"{proc}({pid})")
    if unpinned:
        return ("WARN", f"unpinned perf processes: {', '.join(unpinned[:5])}")
    return ("OK", f"{len(procs)} perf process(es) pinned · IRQ map captured")


def _count_errors(text: str) -> tuple[int, int]:
    """Return (critical_hits, error_hits) skipping noise lines.

    Critical hits = FATAL/PANIC/TRACEBACK/SEGFAULT/OOM — those are real and
    rare; any non-zero count is a flag. Error hits = the broader ERROR/EXCEPTION
    bucket with the noise filter applied — used for "is there a bunch of
    noise" sentiment rather than a hard pass/fail signal."""
    crit = err = 0
    for line in text.splitlines():
        if NOISE_RE.search(line):
            continue
        if CRITICAL_RE.search(line):
            crit += 1
        elif ERR_RE.search(line):
            err += 1
    return crit, err


def _signature(line: str, max_len: int = 140) -> str:
    """Reduce a log line to a stable signature for grouping.

    Strips timestamps, ANSI colour codes, hex/UUID/numbers, file path prefixes,
    and structured log preambles (level=, file=, time=) — leaves the human
    message that's the same across repeated hits. e.g.:

      'time="..." level=error msg="FATAL: sorry, too many clients already (SQLSTATE 53300)"'
      → 'msg="FATAL: sorry, too many clients already (SQLSTATE N)"'
    """
    s = line
    s = re.sub(r"\x1b\[[0-9;]*m", "", s)                         # ANSI colour
    s = re.sub(r"\b\d{4}-\d\d-\d\dT?\d?\d?:?\d?\d?:?\d?\d?(?:\.\d+)?(?:Z|[+\-]\d\d:?\d\d)?\b", "", s)  # ISO ts
    s = re.sub(r"\b\d\d:\d\d:\d\d(?:\.\d+)?\b", "", s)           # bare HH:MM:SS
    s = re.sub(r"\[\d+\]", "", s)                                # [pid]
    s = re.sub(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", "<uuid>", s, flags=re.I)
    s = re.sub(r"\b0x[0-9a-f]+\b", "0x<hex>", s, flags=re.I)
    s = re.sub(r"\b\d+\b", "N", s)                               # any number
    s = re.sub(r"\s+", " ", s).strip()
    return s[:max_len]


def analyze_containers(bundle: Path) -> dict | None:
    """Read simnovator/ps.txt for up/total, then grep each container log.

    Scans BOTH stdout captures (simnovator/container_logs/*.log — windowed) AND
    the in-container app log files (simnovator/container_files/<c>/*.log —
    Ritesh's table). Aggregates per-container so a noisy service shows up once
    with the combined counts; the per-file breakdown is kept for the report's
    "where to look first" hint.
    """
    ps_file = bundle / "simnovator" / "ps.txt"
    logs_dir  = bundle / "simnovator" / "container_logs"
    files_dir = bundle / "simnovator" / "container_files"
    if not ps_file.exists():
        return None
    up = total = 0
    for line in ps_file.read_text(errors="replace").splitlines()[1:]:
        if not line.strip():
            continue
        total += 1
        # podman ps's STATUS column starts with "Up " when running.
        if " Up " in line or line.rstrip().endswith(" Up"):
            up += 1

    # Per-container roll-up: name → {crit, err, files: [(relpath, crit, err)]}.
    by_container: dict[str, dict] = {}

    def _scan(path: Path, container_name: str, rel_for_report: str) -> None:
        try:
            text = path.read_text(errors="replace")
        except Exception:  # noqa: BLE001
            return
        crit, err = _count_errors(text)
        d = by_container.setdefault(container_name,
                                    {"crit": 0, "err": 0, "files": [],
                                     "top_crit_msg": "", "top_crit_count": 0})
        d["crit"] += crit
        d["err"]  += err
        if crit or err:
            d["files"].append((rel_for_report, crit, err))
        # When a container is spewing CRITICAL hits, the most useful debugging
        # signal is the *unique* message, not the raw count. Group CRITICAL
        # lines by their content (with numbers/UUIDs stripped) and remember
        # the loudest signature so the report can show one line of root cause
        # instead of "844 FATAL hits".
        if crit > 0:
            from collections import Counter
            sigs: Counter[str] = Counter()
            for line in text.splitlines():
                if NOISE_RE.search(line):
                    continue
                if CRITICAL_RE.search(line):
                    sig = _signature(line)
                    if sig:
                        sigs[sig] += 1
            if sigs:
                msg, n = sigs.most_common(1)[0]
                if n > d["top_crit_count"]:
                    d["top_crit_msg"], d["top_crit_count"] = msg, n

    # 1) systemd journal per container (quadlet 5.x hosts) — authoritative
    #    stdout. Scanned FIRST so we can skip the podman-logs copy of the same
    #    stdout below: on the quadlet release journald IS podman logs' backing
    #    store, so container_logs/<c>.log would otherwise double-count the same
    #    lines. File is "<container>.journal.log".
    journal_dir = bundle / "simnovator" / "journal"
    journaled: set[str] = set()
    if journal_dir.is_dir():
        for log in sorted(journal_dir.glob("*.journal.log")):
            name = log.name[: -len(".journal.log")]
            journaled.add(name)
            _scan(log, name, f"journal/{log.name}")

    # 2) Stdout logs (windowed) — container_logs/<c>.log. Skip any container
    #    already covered by its journal (same stdout source -> no double count).
    if logs_dir.is_dir():
        for log in sorted(logs_dir.glob("*.log")):
            if log.stem in journaled:
                continue
            _scan(log, log.stem, f"container_logs/{log.name}")

    # 3) In-container app log files — container_files/<c>/<file>.log. Distinct
    #    content (the services' own log FILES, not stdout) — always scanned.
    if files_dir.is_dir():
        for sub in sorted(p for p in files_dir.iterdir() if p.is_dir()):
            for log in sorted(sub.glob("*.log")):
                _scan(log, sub.name, f"container_files/{sub.name}/{log.name}")

    # Roll up + sort hottest first. Each row is
    # (name, crit, err, files-breakdown, top_crit_msg, top_crit_count).
    rows: list[tuple[str, int, int, list, str, int]] = []
    for name, d in by_container.items():
        if d["crit"] or d["err"]:
            rows.append((name, d["crit"], d["err"],
                         sorted(d["files"], key=lambda r: (r[1], r[2]), reverse=True),
                         d.get("top_crit_msg", ""), d.get("top_crit_count", 0)))
    rows.sort(key=lambda r: (r[1], r[2]), reverse=True)
    return {"up": up, "total": total, "errs": rows}


def analyze_uesim_log(bundle: Path) -> dict | None:
    f = bundle / "ue" / "logs" / "ots.log"
    if not f.exists():
        return None
    try:
        text = f.read_text(errors="replace")
    except Exception:  # noqa: BLE001
        return None
    crit, err = _count_errors(text)
    return {"lines": text.count("\n"), "critical": crit, "errors": err}


def analyze_app_manager(bundle: Path) -> dict | None:
    """UE-host Simnovator App Manager journal (ue/logs/app_manager.journal.log).

    Captured from the UE box's systemd journal (the app-manager logs there, not
    to a flat file). Counts CRITICAL + error hits over the collected window so a
    failed / long run surfaces app-manager trouble in the summary.
    """
    f = bundle / "ue" / "logs" / "app_manager.journal.log"
    if not f.exists():
        return None
    try:
        text = f.read_text(errors="replace")
    except Exception:  # noqa: BLE001
        return None
    crit, err = _count_errors(text)
    return {"lines": text.count("\n"), "critical": crit, "errors": err}


def analyze_callbox(bundle: Path) -> dict | None:
    f = bundle / "callbox" / "amari_monitor.txt"
    if not f.exists():
        return None
    text = f.read_text(errors="replace")
    crit, err = _count_errors(text)
    return {"critical": crit, "errors": err, "reachable": "Connected to" in text}


# --- Deeper "worth checking" findings ------------------------------------
# Each check returns either None (couldn't run / not relevant) or a
# (label, status, message) tuple. analyze_deep_checks fans out across all
# hosts and aggregates the non-None findings into one flat list.

def _read_kv(path: Path) -> dict:
    """Parse host_info.txt-style KEY=value into a dict (one per line)."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    try:
        for line in path.read_text(errors="replace").splitlines():
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip()
    except Exception:
        pass
    return out


# Kernel-cmdline flags we expect on a perf rig. Each is (flag-regex, label).
# `mitigations=off` is matched as a substring; others as exact tokens.
_PERF_FLAGS = [
    (r"\bmitigations=off\b",                  "mitigations=off"),
    (r"\bcpufreq\.default_governor=performance\b", "governor=performance"),
    (r"\bprocessor\.max_cstate=[01]\b",       "max_cstate=0/1"),
    (r"\bidle=poll\b",                        "idle=poll"),
    (r"\bpcie_aspm=off\b",                    "pcie_aspm=off"),
    (r"\btransparent_hugepage=never\b",       "thp=never"),
    (r"\bnuma_balancing=disable\b",           "numa_balancing=off"),
    (r"\bnosoftlockup\b",                     "nosoftlockup"),
    (r"\bhugepages=\d+\b",                    "hugepages alloc"),
    (r"\bisolcpus=\S+",                       "isolcpus="),
    (r"\bnohz_full=\S+",                      "nohz_full="),
    (r"\brcu_nocbs=\S+",                      "rcu_nocbs="),
]


def _check_cmdline(role: str, bundle: Path) -> tuple[str, str, str] | None:
    p = bundle / role / "system" / "cmdline.txt"
    if not p.exists():
        return None
    cmdline = p.read_text(errors="replace").strip()
    present, missing = [], []
    for pat, label in _PERF_FLAGS:
        (present if re.search(pat, cmdline) else missing).append(label)
    have_iso = any("isolcpus" in p for p in present)
    have_nohz = any("nohz_full" in p for p in present)
    # If most perf flags are there, OK; only flag what's missing if it includes
    # the "matters most" set. isolcpus + nohz_full make a noticeable difference.
    if len(missing) <= 2:
        return (f"Kernel cmdline [{role}]", "OK",
                f"{len(present)}/{len(_PERF_FLAGS)} perf flags set")
    msg_bits = []
    if not have_iso:  msg_bits.append("isolcpus=")
    if not have_nohz: msg_bits.append("nohz_full=")
    if msg_bits:
        return (f"Kernel cmdline [{role}]", "WARN",
                f"missing {', '.join(msg_bits)} — kernel may schedule on isolated cores")
    return (f"Kernel cmdline [{role}]", "WARN",
            f"missing {len(missing)} perf flag(s): {', '.join(missing[:4])}")


def _check_grub_drift(role: str, bundle: Path) -> tuple[str, str, str] | None:
    """Compare /etc/default/grub's CMDLINE_LINUX_DEFAULT against the actually-
    booted /proc/cmdline. Drift = "you edited grub.default but didn't run
    update-grub + reboot" — common gotcha after tuning."""
    cmdline_f = bundle / role / "system" / "cmdline.txt"
    grub_f    = bundle / role / "system" / "grub.default"
    if not cmdline_f.exists() or not grub_f.exists():
        return None
    booted = cmdline_f.read_text(errors="replace").strip()
    grub_text = grub_f.read_text(errors="replace")
    # Pull the active GRUB_CMDLINE_LINUX_DEFAULT line (skip commented ones).
    m = re.search(r'^\s*GRUB_CMDLINE_LINUX_DEFAULT="([^"]*)"', grub_text, re.MULTILINE)
    if not m:
        return None
    desired_tokens = set(m.group(1).split())
    # Compare only over what grub.default cares about — booted has extra
    # tokens from the bootloader (BOOT_IMAGE, root=, ro, rootflags=, etc.)
    booted_tokens = set(booted.split())
    missing = sorted(desired_tokens - booted_tokens)
    if not missing:
        return (f"GRUB drift [{role}]", "OK",
                "cmdline.txt has every flag from grub.default")
    return (f"GRUB drift [{role}]", "WARN",
            f"grub.default has {len(missing)} flag(s) NOT in booted cmdline "
            f"(re-run update-grub + reboot): {', '.join(missing[:4])}")


def _check_kernel_match(infos: dict) -> tuple[str, str, str] | None:
    """Cross-host: same kernel everywhere?"""
    kernels = {role: info.get("KERNEL", "") for role, info in infos.items() if info.get("KERNEL")}
    if not kernels:
        return None
    unique = set(kernels.values())
    if len(unique) == 1:
        return ("Kernel match", "OK",
                f"all {len(kernels)} hosts on {next(iter(unique))}")
    return ("Kernel match", "WARN",
            "mismatch: " + " · ".join(f"{r}={k}" for r, k in kernels.items()))


def _check_iperf3_match(infos: dict) -> tuple[str, str, str] | None:
    """iperf3 version match between UE + App Server (the iperf endpoints)."""
    versions = {role: info.get("IPERF3_VER", "") for role, info in infos.items()
                if info.get("IPERF3_VER")}
    if not versions:
        return ("iperf3 versions", "WARN",
                "not collected — re-run with the latest probe to capture")
    unique = set(versions.values())
    if len(unique) == 1:
        return ("iperf3 versions", "OK",
                f"all {len(versions)} hosts on {next(iter(unique))}")
    return ("iperf3 versions", "WARN",
            "mismatch (iperf3 needs same major version both ends): "
            + " · ".join(f"{r}={v}" for r, v in versions.items()))


def _check_governor(infos: dict) -> list[tuple[str, str, str]]:
    """Per-host CPU governor — should be 'performance' for perf testing."""
    out = []
    for role, info in infos.items():
        gov = info.get("CPU_GOVERNOR", "")
        if not gov:
            continue
        if gov == "performance":
            out.append((f"CPU governor [{role}]", "OK", "performance"))
        else:
            out.append((f"CPU governor [{role}]", "WARN",
                        f"{gov} — set to 'performance' for predictable timing"))
    return out


def _check_swap(infos: dict) -> list[tuple[str, str, str]]:
    out = []
    for role, info in infos.items():
        raw = info.get("SWAP_USED_MB", "")
        if not raw:
            continue
        try:
            used = int(raw)
        except ValueError:
            continue
        if used == 0:
            out.append((f"Swap [{role}]", "OK", "0 MB used"))
        elif used > 100:
            out.append((f"Swap [{role}]", "WARN",
                        f"{used} MB used — memory pressure or unintended swapping"))
    return out


def _check_thp(infos: dict) -> list[tuple[str, str, str]]:
    out = []
    for role, info in infos.items():
        v = info.get("THP", "")
        if not v:
            continue
        if v == "never":
            out.append((f"THP [{role}]", "OK", "never (deterministic latency)"))
        else:
            out.append((f"THP [{role}]", "WARN",
                        f"{v} — perf rigs usually run with [never] for predictability"))
    return out


def _check_disk(infos: dict) -> list[tuple[str, str, str]]:
    out = []
    for role, info in infos.items():
        d = info.get("DISK", "")
        # DISK= "<size> <used> <avail>" from df -h. Parse to compute %used.
        toks = d.split()
        if len(toks) < 2:
            continue
        def _gb(s: str) -> float:
            s = s.strip()
            if not s: return 0.0
            m = re.match(r"([\d.]+)\s*([KMGT])?", s)
            if not m: return 0.0
            num = float(m.group(1))
            unit = (m.group(2) or "").upper()
            mul = {"K": 1/1024/1024, "M": 1/1024, "G": 1, "T": 1024}.get(unit, 1/1024/1024/1024)
            return num * mul
        total = _gb(toks[0])
        used  = _gb(toks[1])
        if total <= 0:
            continue
        pct = used / total * 100
        st = "FAIL" if pct >= 90 else ("WARN" if pct >= 80 else "OK")
        out.append((f"Disk [{role}]", st,
                    f"{used:.0f} GB used of {total:.0f} GB ({pct:.0f}%)"))
    return out


def _check_sim_volumes(bundle: Path) -> list[tuple[str, str, str]]:
    """Per-volume disk usage from simnovator/disk_usage.txt. The autosave /
    timescaledb / openobserve *volumes* are the real disk hogs (not containers,
    so they never show in the health UI). Also surfaces the executor cleanup cap
    and how close the tracked total is to it. (SIM40-2418)
    """
    p = bundle / "simnovator" / "disk_usage.txt"
    if not p.exists():
        return []
    vols: list[tuple[str, str]] = []   # (name, human-size)
    cap_mb = total_mb = None
    for line in p.read_text(errors="replace").splitlines():
        s = line.strip()
        m = re.match(r"([\d.]+[KMGT]?)\s+.*/volumes/simnovator_(\S+)", s)
        if m:
            vols.append((m.group(2), m.group(1)))
        m = re.search(r"CLEANUP_MAX_DISK_USAGE_ALLOWED_MB=(\d+)", s)
        if m:
            cap_mb = int(m.group(1))
        m = re.search(r"Total:\s*(\d+)\s*MB", s)
        if m:
            total_mb = int(m.group(1))
    if not vols and total_mb is None:
        return []
    bits = [f"{n} {sz}" for n, sz in vols[:5]] or ["(no volumes found)"]
    st = "OK"
    if cap_mb:
        frac = (total_mb or 0) / cap_mb
        tail = f" (used {(total_mb or 0)/1024:.1f} GiB, {frac*100:.0f}%)" if total_mb is not None else ""
        bits.append(f"cleanup cap {cap_mb/1024:.0f} GiB{tail}")
        st = "FAIL" if frac >= 0.9 else ("WARN" if frac >= 0.8 else "OK")
    return [("Disk [sim volumes]", st, " · ".join(bits))]


def _ring_after(label: str, lines: list[str], start: int, limit: int = 10) -> dict:
    """Find RX:/TX: values in the `limit` lines following `start` (label index)."""
    out = {}
    for line in lines[start + 1 : start + 1 + limit]:
        m = re.match(r"\s*(RX|TX):\s+(\d+)\s*$", line)
        if m:
            out.setdefault(m.group(1), int(m.group(2)))
        elif re.match(r"^[A-Z]\S", line) and ":" not in line[:30]:
            break  # next section header
    return out


def _check_nic(bundle: Path) -> list[tuple[str, str, str]]:
    """Read ue/net/nic_settings.txt and flag undersized rings + risky offloads.
    Looks at each "===== <iface> =====" block."""
    p = bundle / "ue" / "net" / "nic_settings.txt"
    if not p.exists():
        return []
    text = p.read_text(errors="replace")
    out: list[tuple[str, str, str]] = []
    parts = re.split(r"=+\s+(\S+)\s+=+", text)
    # parts = [pre, iface1, body1, iface2, body2, ...]
    for i in range(1, len(parts), 2):
        iface = parts[i]
        body = parts[i + 1] if i + 1 < len(parts) else ""
        lines = body.splitlines()
        # Find the "Pre-set maximums:" and "Current hardware settings:" anchors
        # then walk the next N lines for RX/TX rows. The ethtool output has
        # ragged whitespace (mix of tabs/spaces) so we tokenize line-by-line.
        mxn = rxn = txn = 0
        for j, line in enumerate(lines):
            if line.startswith("Pre-set maximums:"):
                vals = _ring_after("max", lines, j)
                if "RX" in vals: mxn = vals["RX"]
            elif line.startswith("Current hardware settings:"):
                vals = _ring_after("cur", lines, j)
                rxn = vals.get("RX", 0)
                txn = vals.get("TX", 0)
        if rxn or txn:
            # Undersized if both rings are <= 1024 AND well under the device max.
            if mxn and rxn and rxn < mxn // 2 and rxn <= 1024:
                out.append((f"NIC ring [{iface}]", "WARN",
                            f"RX/TX={rxn} · max={mxn} — bump toward max for high throughput"))
            else:
                tag = f"RX={rxn}/TX={txn}" if rxn != txn else f"RX/TX={rxn}"
                out.append((f"NIC ring [{iface}]", "OK",
                            tag + (f" (max={mxn})" if mxn else "")))
        # Offload sanity — GRO/LRO/TSO on routing boxes is fine, but on a
        # measurement endpoint LRO is usually off, GRO can mask packet counts.
        lro = re.search(r"^large-receive-offload:\s+(on|off)", body, re.MULTILINE)
        if lro and lro.group(1) == "on":
            out.append((f"NIC offload [{iface}]", "WARN",
                        "LRO=on — may distort per-packet measurements"))
    return out


def _check_container_restart(bundle: Path) -> tuple[str, str, str] | None:
    """ps.txt 'Up X' column: flag any container whose uptime is much less than
    its peers (recent crash + restart)."""
    p = bundle / "simnovator" / "ps.txt"
    if not p.exists():
        return None
    rows = []
    for line in p.read_text(errors="replace").splitlines()[1:]:
        m = re.search(r"\s(Up\s+\S+\s+\S+)\s", " " + line + " ")
        if not m:
            continue
        uptime = m.group(1)
        name = line.rsplit(None, 1)[-1]
        # Convert to rough hours for comparison.
        h = re.search(r"(\d+)\s*hour", uptime)
        d = re.search(r"(\d+)\s*day",  uptime)
        m_  = re.search(r"(\d+)\s*minute", uptime)
        hours = (int(d.group(1)) * 24 if d else 0) + (int(h.group(1)) if h else 0) \
              + (int(m_.group(1))/60 if m_ else 0)
        rows.append((name, uptime, hours))
    if len(rows) < 2:
        return None
    max_h = max(r[2] for r in rows)
    outliers = [r for r in rows if r[2] < max_h * 0.5 and (max_h - r[2]) > 1]
    if not outliers:
        return ("Container restarts", "OK",
                f"all {len(rows)} containers within same uptime band")
    bits = [f"{n} ({u})" for n, u, _ in outliers[:3]]
    return ("Container restarts", "WARN",
            f"{len(outliers)} container(s) restarted vs peers (~{max_h:.0f}h up): "
            + ", ".join(bits))


def _check_container_cpu(bundle: Path) -> tuple[str, str, str] | None:
    """container_stats_snapshot.txt: any container > 80% CPU at snapshot?"""
    p = bundle / "simnovator" / "container_stats_snapshot.txt"
    if not p.exists():
        return None
    hot = []
    for line in p.read_text(errors="replace").splitlines()[1:]:
        m = re.search(r"^(\S+)\s+(\S+)\s+([\d.]+)%", line)
        if not m:
            continue
        cpu = float(m.group(3))
        if cpu >= 80:
            hot.append((m.group(2), cpu))
    if not hot:
        return ("Container CPU snapshot", "OK",
                "no container > 80% CPU at snapshot")
    bits = [f"{n}={c:.0f}%" for n, c in hot[:3]]
    return ("Container CPU snapshot", "WARN",
            f"{len(hot)} container(s) ≥80% CPU: " + ", ".join(bits))


def analyze_deep_checks(bundle: Path) -> list[tuple[str, str, str]]:
    """Run every deep check and return the flat list of findings."""
    out: list[tuple[str, str, str]] = []
    # Per-host info dict for cross-host checks.
    roles = ["ue", "simnovator", "callbox", "app_server"]
    infos = {r: _read_kv(bundle / r / "system" / "host_info.txt") for r in roles}
    infos = {r: v for r, v in infos.items() if v}  # drop empties

    # Cross-host comparisons (one line each).
    for f in (_check_kernel_match, _check_iperf3_match):
        r = f(infos)
        if r: out.append(r)

    # Per-host checks driven by host_info.txt.
    out.extend(_check_governor(infos))
    out.extend(_check_swap(infos))
    out.extend(_check_thp(infos))
    out.extend(_check_disk(infos))
    out.extend(_check_sim_volumes(bundle))

    # UE-specific deep checks (config files only collected for UE).
    for role in ("ue",):
        for f in (_check_cmdline, _check_grub_drift):
            r = f(role, bundle)
            if r: out.append(r)
    out.extend(_check_nic(bundle))

    # Simnovator container checks.
    for f in (_check_container_restart, _check_container_cpu):
        r = f(bundle)
        if r: out.append(r)
    return out


# --- Report renderer ------------------------------------------------------
_STATUS_GLYPH = {"OK": "[ OK ]", "WARN": "[WARN]", "FAIL": "[FAIL]", "ERR": "[ERR ]"}


def render(test, heat, cpu, containers, uesim, callbox, deep=None, app_manager=None) -> str:
    rows: list[tuple[str, str, str]] = []   # (label, status, message)

    if test:
        dur = f"{test['duration_s']//60}m{test['duration_s']%60:02d}s" if test["duration_s"] else "n/a"
        verdict = (test["result"] or "?").upper()
        st = "OK" if verdict == "PASS" else ("WARN" if test["status"] == "COMPLETED" else "WARN")
        rows.append(("Test", st, f'{test["name"]} · {test["status"]} · verdict={verdict} · {dur}'))

    for host, st, msg in heat:
        rows.append((f"Heat [{host}]", st, msg))

    if cpu:
        st, msg = cpu
        rows.append(("CPU pinning", st, msg))

    if containers:
        c = containers
        miss = c["total"] - c["up"]
        # Rows are 4-tuples now: (name, crit, err, files). Index by position
        # so this stays backwards-compat if older bundles produce 3-tuples.
        crit_total = sum(row[1] for row in c["errs"])
        err_total  = sum(row[2] for row in c["errs"])
        if miss or crit_total:
            st = "FAIL"
        elif err_total > 100:
            st = "WARN"
        else:
            st = "OK"
        bits = [f'{c["up"]}/{c["total"]} Up']
        if crit_total: bits.append(f"{crit_total} CRITICAL")
        if err_total:  bits.append(f"{err_total} error hits across {len(c['errs'])} container(s)")
        rows.append(("Containers", st, " · ".join(bits)))

    if uesim:
        if uesim["critical"]:
            st = "FAIL"
        elif uesim["errors"] > 500:
            st = "WARN"
        else:
            st = "OK"
        bits = [f'{uesim["errors"]} error hits', f'{uesim["lines"]:,} lines']
        if uesim["critical"]:
            bits.insert(0, f'{uesim["critical"]} CRITICAL')
        rows.append(("UESIM log", st, " · ".join(bits)))

    if app_manager:
        if app_manager["critical"]:
            st = "FAIL"
        elif app_manager["errors"] > 500:
            st = "WARN"
        else:
            st = "OK"
        bits = [f'{app_manager["errors"]} error hits', f'{app_manager["lines"]:,} lines']
        if app_manager["critical"]:
            bits.insert(0, f'{app_manager["critical"]} CRITICAL')
        rows.append(("App Manager (UE)", st, " · ".join(bits)))

    if callbox:
        if not callbox["reachable"]:
            st, msg = "WARN", "monitor unreachable (was the WS port 9001 up?)"
        elif callbox["critical"]:
            st, msg = "FAIL", f'monitor responsive · {callbox["critical"]} CRITICAL · {callbox["errors"]} error hits'
        elif callbox["errors"] > 20:
            st, msg = "WARN", f'monitor responsive · {callbox["errors"]} error hits'
        else:
            st, msg = "OK", "monitor responsive · clean"
        rows.append(("Callbox monitor", st, msg))

    # Final composition
    label_w = max((len(label) for label, *_ in rows), default=0)
    out: list[str] = []
    out.append("=" * 72)
    out.append("  Analysis summary")
    out.append("=" * 72)
    for label, st, msg in rows:
        out.append(f"  {_STATUS_GLYPH.get(st, '[ ?  ]')}  {label.ljust(label_w)}   {msg}")
    out.append("")

    # Per-container error breakdown with the noisiest file per container +
    # the top unique CRITICAL message signature. Helps the on-call see "844x
    # FATAL too many clients" as one root cause instead of 844 incidents.
    if containers and containers["errs"]:
        out.append("Top error-rate containers (CRITICAL + error hits, noise filtered)")
        for entry in containers["errs"][:10]:
            # Backwards-compat: tuples may be 3, 4, or 6 elements long.
            if len(entry) == 6:
                name, crit, err, files, top_msg, top_n = entry
            elif len(entry) == 4:
                name, crit, err, files = entry; top_msg, top_n = "", 0
            else:
                name, crit, err = entry; files, top_msg, top_n = [], "", 0
            tag = f"{crit} CRIT · {err} err" if crit else f"{err} err"
            out.append(f"  · {name}: {tag}")
            for relpath, fc, fe in files[:2]:
                ftag = f"{fc} CRIT · {fe} err" if fc else f"{fe} err"
                out.append(f"      {relpath}: {ftag}")
            if top_msg and top_n >= 5:
                # Show the single recurring CRITICAL message — the root cause
                # behind the count. Truncate to 110 chars so the table stays
                # readable; full text is in the file viewer.
                snippet = top_msg if len(top_msg) <= 110 else top_msg[:107] + "…"
                out.append(f"      → top CRITICAL ({top_n}×): {snippet}")
        out.append("")

    # ---- "Worth checking" deeper findings ------------------------------
    # Each row uses the same status-glyph format as the summary so the eye
    # can scan both blocks the same way. These are config/perf-tuning hints,
    # not pass/fail of the run itself.
    if deep:
        out.append("")
        out.append("Worth checking (config + perf-tuning sanity)")
        deep_label_w = max((len(label) for label, _, _ in deep), default=0)
        for label, st, msg in deep:
            out.append(f"  {_STATUS_GLYPH.get(st, '[ ?  ]')}  "
                       f"{label.ljust(deep_label_w)}   {msg}")
        out.append("")

    out.append("Thresholds: SDR-FPGA warn>{}°C fail>{}°C · "
               "RFIC warn>{}°C fail>{}°C · CPU warn>{}°C fail>{}°C"
               .format(SDR_FPGA_WARN, SDR_FPGA_FAIL,
                       SDR_RFIC_WARN, SDR_RFIC_FAIL,
                       CPU_WARN, CPU_FAIL))
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bundle", required=True, type=Path,
                    help="Path to the UNPACKED bundle directory (the one "
                         "containing MANIFEST.txt and per-host subdirs).")
    args = ap.parse_args()
    if not args.bundle.is_dir() or not (args.bundle / "MANIFEST.txt").exists():
        print(f"ERROR: not a bundle directory: {args.bundle}", file=sys.stderr)
        return 2

    test       = analyze_test(args.bundle)
    heat       = analyze_heat(args.bundle)
    cpu        = analyze_cpu(args.bundle)
    containers = analyze_containers(args.bundle)
    uesim      = analyze_uesim_log(args.bundle)
    app_manager = analyze_app_manager(args.bundle)
    callbox    = analyze_callbox(args.bundle)
    deep       = analyze_deep_checks(args.bundle)

    report = render(test, heat, cpu, containers, uesim, callbox, deep, app_manager)
    out = args.bundle / "ANALYSIS.md"
    out.write_text(report)
    print(report)
    print(f"# wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

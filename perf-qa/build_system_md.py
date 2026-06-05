#!/usr/bin/env python3
"""Build SYSTEM.md from a perf-qa bundle's per-host inventory probes.

Reads every <role>/system/host_info.txt file the collector wrote, parses the
KEY=value lines, and produces a single cross-host markdown table at the bundle
root. Replaces the wall-of-text system-info dump engineering used to maintain
by hand with a one-page side-by-side view.

Usage:
    build_system_md.py --bundle <bundle_dir>
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

# Order matters — it's the column order in the final table.
ROLE_LABELS = [
    ("ue",          "UE Sim"),
    ("simnovator",  "Simnovator"),
    ("callbox",     "Callbox"),
    ("app_server",  "App Server"),
]

# Rows of the cross-host table. (KEY, display_label, value_formatter).
# Formatter takes the raw value string and returns the display string.
def _cpu_fmt(v: str, cores: str) -> str:
    if not v: return ""
    return f"{v} × {cores}" if cores else v

def _ram_fmt(v: str, slots: str) -> str:
    if not v: return ""
    return f"{v} GB" + (f" ({slots} slot{'s' if slots != '1' else ''})" if slots and slots != "0" else "")

def _disk_fmt(v: str) -> str:
    # Probe outputs "total used avail" — show as "Total used / total".
    parts = v.split()
    if len(parts) >= 2:
        return f"{parts[1]} used / {parts[0]} total"
    return v

# Static rows. Composite cells (CPU, RAM, Disk) are handled below via callable.
ROWS = [
    ("HOSTNAME",   "Hostname"),
    ("IP",         "IP"),
    ("MACHINE",    "Machine"),
    ("UPTIME",     "Uptime"),
    ("OS",         "OS"),
    ("KERNEL",     "Kernel"),
    # CPU + RAM + Disk are special — built from multiple KEYs (see below).
    ("__CPU__",    "CPU"),
    ("__RAM__",    "RAM"),
    ("__DISK__",   "Disk"),
    ("MOTHERBOARD","Motherboard"),
]


def _parse_kv(path: Path) -> dict[str, str]:
    """Parse a KEY=value file into a dict. Missing keys → empty string."""
    out: dict[str, str] = {}
    try:
        for line in path.read_text(errors="replace").splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip()
    except OSError:
        pass
    return out


def _cell(per_host: dict[str, dict[str, str]], role: str, key: str) -> str:
    """Resolve a cell value for one host/column."""
    h = per_host.get(role, {})
    if key == "__CPU__":  return _cpu_fmt(h.get("CPU_MODEL", ""), h.get("CPU_CORES", ""))
    if key == "__RAM__":  return _ram_fmt(h.get("RAM_GB", ""),     h.get("RAM_SLOTS", ""))
    if key == "__DISK__": return _disk_fmt(h.get("DISK", ""))
    return h.get(key, "")


def _md_table(per_host: dict[str, dict[str, str]], present: list[tuple[str, str]]) -> str:
    """Render the hosts × metrics table as GFM markdown."""
    # Header: "Metric | Role1 | Role2 | ..."
    headers = ["Metric"] + [label for _, label in present]
    sep = ["---"] * len(headers)
    rows = []
    for key, label in ROWS:
        cells = [label]
        for role, _ in present:
            cells.append(_cell(per_host, role, key) or "—")
        rows.append(cells)
    lines = ["| " + " | ".join(headers) + " |",
             "| " + " | ".join(sep)     + " |"]
    for r in rows:
        # Escape pipe chars inside cells so the table doesn't break.
        r = [c.replace("|", "\\|") for c in r]
        lines.append("| " + " | ".join(r) + " |")
    return "\n".join(lines)


def _sdr_section(per_host: dict[str, dict[str, str]], present: list[tuple[str, str]]) -> str:
    """Optional SDR breakdown for hosts that have one (UE + Callbox)."""
    chunks = []
    for role, label in present:
        h = per_host.get(role, {})
        devs = h.get("SDR_DEVICES", "").strip()
        summary = h.get("SDR_SUMMARY", "").strip()
        if not devs and not summary:
            continue
        sub = [f"### {label}"]
        if devs:
            sub.append(f"Devices: `{devs.strip()}`")
        if summary:
            # SDR_SUMMARY format: dev|bid|bt|fpga|sw|ser;dev|bid|...
            sub.append("")
            sub.append("| Device | Board ID | Type | FPGA | Software | Serial |")
            sub.append("| --- | --- | --- | --- | --- | --- |")
            for entry in summary.split(";"):
                f = (entry.split("|") + [""] * 6)[:6]
                sub.append(f"| `{f[0]}` | {f[1] or '—'} | {f[2] or '—'} | {f[3] or '—'} | {f[4] or '—'} | {f[5] or '—'} |")
        chunks.append("\n".join(sub))
    if not chunks:
        return ""
    return "## SDR boards\n\n" + "\n\n".join(chunks)


def _test_header(bundle: Path) -> str:
    """Pull the test case name + verdict from rest_api/last_run.json if present.

    Shape (v2 footer): {items: [{name, metadata: {lastExecution: {...}}}]}.
    We pick items[0] and dig into the lastExecution for status/result/executionId.
    Older flat shape is still handled as a fallback.
    """
    import json
    p = bundle / "rest_api" / "last_run.json"
    if not p.exists():
        return ""
    try:
        data = json.loads(p.read_text())
    except Exception:
        return ""
    tc = data
    if isinstance(data, dict) and "items" in data:
        items = data.get("items") or []
        if items and isinstance(items[0], dict):
            tc = items[0]
    if not isinstance(tc, dict):
        return ""
    meta = tc.get("metadata") if isinstance(tc.get("metadata"), dict) else {}
    last = meta.get("lastExecution") if isinstance(meta.get("lastExecution"), dict) else {}
    name = tc.get("name") or tc.get("testCaseName") or tc.get("testcaseName") or ""
    status  = last.get("status")  or tc.get("status")  or tc.get("executionStatus") or ""
    verdict = last.get("result")  or tc.get("verdict") or tc.get("result") or ""
    iter_id = (last.get("executionId") or tc.get("iterationId")
               or tc.get("iteration_id") or "")
    bits = [f"**{name}**" if name else "",
            status, verdict,
            f"iter `{iter_id[:8]}…`" if iter_id else ""]
    line = " · ".join(b for b in bits if b)
    return f"Test case: {line}" if line else ""


def build(bundle: Path) -> Path:
    per_host: dict[str, dict[str, str]] = {}
    for role, _ in ROLE_LABELS:
        info = bundle / role / "system" / "host_info.txt"
        if info.exists():
            per_host[role] = _parse_kv(info)
    # Only show columns for roles that actually produced a probe.
    present = [(r, l) for (r, l) in ROLE_LABELS if r in per_host]
    if not present:
        out = bundle / "SYSTEM.md"
        out.write_text("# System summary\n\n_No host inventory available._\n")
        return out

    parts = ["# System summary",
             "",
             f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
             _test_header(bundle),
             "",
             "## Hosts",
             "",
             _md_table(per_host, present),
             ""]
    sdr = _sdr_section(per_host, present)
    if sdr:
        parts += [sdr, ""]
    parts += ["---",
              "_Auto-generated by `build_system_md.py` from each host's `system/host_info.txt`._",
              ""]
    out = bundle / "SYSTEM.md"
    out.write_text("\n".join(p for p in parts if p is not None))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bundle", required=True, help="Bundle dir (unpacked)")
    args = ap.parse_args()
    bundle = Path(args.bundle)
    if not bundle.is_dir():
        print(f"not a directory: {bundle}", file=sys.stderr)
        return 2
    out = build(bundle)
    print(f"# wrote {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

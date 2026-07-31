#!/usr/bin/env python3
"""perf-qa UI — thin Flask wrapper around collect_perf_data.sh.

Single-page UI:
  - GET /                 -> form + log pane + bundle list
  - POST /run             -> kick off a collection (one at a time)
  - GET  /jobs/<id>/stream-> SSE stream of stdout
  - GET  /jobs/<id>/manifest -> MANIFEST.txt for the completed job
  - GET  /bundles         -> JSON list of recent .tar.gz bundles
  - GET  /bundles/<name>  -> download a bundle

Runs locally on the host that hosts it; the script's own SSH-out logic
handles callbox / app-server. Bundles go to /tmp/perf_collect (= the
script's OUTPUT_DIR default).
"""
import glob
import json
import os
import re
import sys
import subprocess
import threading
import time
import uuid
from collections import deque
from pathlib import Path

from flask import Flask, abort, jsonify, redirect, render_template_string, request, send_file, Response

# OneClick UI version. Bump on every push to oneclick repo so customers
# can confirm the Update button actually applied — the new number shows
# up in the topbar after the page reloads.
VERSION = "1.0.18"

SCRIPT_DIR = Path(os.environ.get("PERFQA_SCRIPT_DIR", "/opt/perf-qa"))
SCRIPT = SCRIPT_DIR / "collect_perf_data.sh"
SETUP_CONF = SCRIPT_DIR / "setup.conf"
BUNDLE_ROOT = Path(os.environ.get("PERFQA_BUNDLE_ROOT", "/var/lib/perf-qa/bundles"))
PORT = int(os.environ.get("PERFQA_PORT", "8080"))

UI_DIR = Path(__file__).resolve().parent  # for serving logo/favicon shipped next to app.py
app = Flask(__name__)


# The whole UI is one Python file that ships inline HTML+JS via
# render_template_string. When we push a new app.py, the JS lives inside the
# page response — so if Chrome serves the cached HTML the user keeps running
# the OLD JS against the NEW backend. Force-fresh on HTML responses fixes it.
@app.after_request
def _no_cache_html(resp):
    ctype = (resp.headers.get("Content-Type") or "").lower()
    if ctype.startswith("text/html"):
        resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


@app.route("/static/logo.svg")
def static_logo():
    # Use the light-fill variant for the dark topbar; fall back to dark if missing.
    p = UI_DIR / "logo_light.svg"
    if not p.exists():
        p = UI_DIR / "logo_dark.svg"
    if not p.exists():
        abort(404)
    return send_file(str(p), mimetype="image/svg+xml")


@app.route("/favicon.png")
def static_favicon():
    p = UI_DIR / "favicon.png"
    if not p.exists():
        abort(404)
    return send_file(str(p), mimetype="image/png")
JOBS: dict = {}
LOCK = threading.Lock()


def _bundle_summary(archive_path: str) -> dict:
    """Read MANIFEST.txt from the bundle dir next to the archive."""
    # Strip the .zip / .tar.gz suffix to get the bundle dir path.
    if archive_path.endswith(".tar.gz"):
        bundle_dir = archive_path[: -len(".tar.gz")]
    elif archive_path.endswith(".zip"):
        bundle_dir = archive_path[: -len(".zip")]
    else:
        bundle_dir = archive_path
    manifest = Path(bundle_dir) / "MANIFEST.txt"
    out = {"counts": {}, "manifest": ""}
    if not manifest.exists():
        return out
    text = manifest.read_text(errors="replace")
    out["manifest"] = text
    counts = {"COLLECTED": 0, "SKIPPED": 0, "FAILED": 0, "NOTE": 0, "TRUNCATED": 0}
    for line in text.splitlines():
        for k in counts:
            if line.startswith(k):
                counts[k] += 1
                break
    out["counts"] = counts
    return out


def _run_job(job_id: str, env_overrides: dict) -> None:
    job = JOBS[job_id]
    cmd = ["bash", str(SCRIPT), str(SETUP_CONF)]
    env = {**os.environ, **env_overrides}
    job["lines"].append(f"$ {' '.join(cmd)}")
    if env_overrides:
        job["lines"].append("$ env: " + " ".join(f"{k}={v}" for k, v in env_overrides.items()))
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            env=env, bufsize=1, text=True,
        )
        for line in proc.stdout:  # type: ignore[union-attr]
            job["lines"].append(line.rstrip("\n"))
        proc.wait()
        job["returncode"] = proc.returncode
    except Exception as exc:  # noqa: BLE001
        job["lines"].append(f"[error] {exc}")
        job["returncode"] = -1

    # Pick the most-recently-modified bundle that landed during this run.
    # New runs produce <tc>_diagnostics_<TS>.zip; legacy ones were
    # qa_perftest_*.tar.gz. Filter to only those that landed AFTER the job
    # started so we don't latch onto an unrelated archive sitting in the dir.
    started = job.get("started", 0)
    candidates = []
    for pat in ("*_diagnostics_*.zip", "*_diagnostics_*.tar.gz",
                "qa_perftest_*.tar.gz"):
        candidates.extend(glob.glob(f"{BUNDLE_ROOT}/{pat}"))
    fresh = [p for p in candidates if os.path.getmtime(p) >= started - 1]
    pool = fresh if fresh else candidates
    matches = sorted(pool, key=os.path.getmtime, reverse=True)
    if matches:
        job["bundle"] = Path(matches[0]).name
        summary = _bundle_summary(matches[0])
        job["counts"] = summary["counts"]
        job["manifest"] = summary["manifest"]
    job["state"] = "done"
    job["finished"] = time.time()


def _default_beszel_url() -> str:
    """Beszel hub URL for the topbar link. Pulled from the active QA profile."""
    profiles = load_profiles()
    for name in ("Lab", "QA_System", *profiles):  # prefer canonical name, then any other
        if name in profiles:
            url = profiles[name].get("defaults", {}).get("BESZEL_HUB_URL", "").strip()
            if url:
                return url
    return ""


@app.route("/")
def index():
    profiles = load_profiles()
    profile_defaults = {n: p.get("defaults", {}) for n, p in profiles.items()}
    return render_template_string(
        HTML,
        host_label=os.uname().nodename,
        profiles=profiles, profile_defaults=profile_defaults,
        host_fields=PROFILE_FORM_HOSTS,
        beszel_url=_default_beszel_url(),
        version=VERSION,
        # First-load default profile if localStorage has nothing; the page's
        # JS will override with localStorage if set.
        # Pick a sensible first-load default; the page's JS will then honour
        # localStorage if the user has already chosen a different profile.
        default_profile=("Lab" if "Lab" in profiles
                         else "QA_System" if "QA_System" in profiles
                         else (next(iter(profiles)) if profiles else "")),
    )


# --- Profile store ---------------------------------------------------------
# Profiles live in profiles.json next to app.py so users can add/edit/delete
# via the UI without touching code. On first run the file is seeded with the
# QA + Dev defaults below. Load/save go through helpers so concurrent writes
# don't corrupt the file (atomic rename).
PROFILES_JSON = UI_DIR / "profiles.json"


def _seed_profiles() -> dict:
    """Initial seed for profiles.json (returned as a dict)."""
    return {"profiles": _INITIAL_PROFILES}


def load_profiles() -> dict:
    """Return the {name: profile} dict from disk (seeding if missing).

    Backfills any BLANK fixed-key from the seed so older profiles
    (saved before we shipped sensible defaults for SIM_API_USER /
    SIMNOVATOR_USER / etc.) inherit the new values without the user
    having to recreate the profile. Non-blank values are never touched.
    """
    if not PROFILES_JSON.exists():
        save_profiles_dict(_seed_profiles()["profiles"])
    try:
        data = json.loads(PROFILES_JSON.read_text())
    except Exception:
        # Corrupt file — back it up + reseed.
        bak = PROFILES_JSON.with_suffix(".bak")
        try:
            PROFILES_JSON.replace(bak)
        except Exception:
            pass
        save_profiles_dict(_seed_profiles()["profiles"])
        data = json.loads(PROFILES_JSON.read_text())
    profiles = data.get("profiles", {})
    seed_fixed = next(iter(_INITIAL_PROFILES.values()))["fixed"]
    for prof in profiles.values():
        fixed = prof.setdefault("fixed", {})
        for k, v in seed_fixed.items():
            if not fixed.get(k):  # missing OR blank
                fixed[k] = v
    return profiles


def save_profiles_dict(profiles: dict) -> None:
    """Atomically write the {name: profile} dict to profiles.json."""
    PROFILES_JSON.parent.mkdir(parents=True, exist_ok=True)
    tmp = PROFILES_JSON.with_suffix(".tmp")
    tmp.write_text(json.dumps({"profiles": profiles}, indent=2, sort_keys=True))
    tmp.replace(PROFILES_JSON)


# Initial seed used the first time profiles.json doesn't exist. Once on disk,
# this dict isn't consulted — the JSON file is the source of truth.
#
# All host IPs and credentials are intentionally BLANK in this seed — the
# operator fills them in on first run via the Setup tab. Product paths
# (ue.cfg / enb.cfg / mme.cfg / ims.cfg / iperf log dir) are Simnovator
# stock locations and stay as defaults.
_INITIAL_PROFILES = {
    "Lab": {
        "label": "Lab (default profile)",
        "defaults": {
            "UE_HOST":          "",   # e.g. 10.0.0.34
            "SIMNOVATOR_HOST":  "",   # e.g. 10.0.0.95
            "CALLBOX_HOST":     "",   # e.g. 10.0.0.107
            "APP_SERVER_HOST":  "",   # e.g. 10.0.0.109
            "BESZEL_HUB_URL":   "",   # e.g. http://10.0.0.16:8090 (blank = skip Beszel)
        },
        # SIM_API_BASE auto-derives from SIMNOVATOR_HOST at runtime; everything
        # else listed here is written verbatim to setup.conf.
        "fixed": {
            "TEST_CASE_NAME":          "LAST_RUN",
            "ITERATION_ID":            "",
            "OUTPUT_DIR":              "/var/lib/perf-qa/bundles",
            "COLLECTION_LABEL":        "perfqa",
            "COLLECT_HEAT":            "1",
            "COLLECT_ANALYZE":         "1",

            "UE_USER":                 "sysadmin",   # almost always sysadmin in a Simnovator rig
            "UE_SSH_PORT":             "22",
            "UE_PASS":                 "",   # blank = SSH key auth
            "UE_CFG_PATH":             "/root/ue/config/ue.cfg",
            "WORKLOAD_AFFINITY_JSON":  "",   # e.g. /home/<user>/UE-simnovus/workload_affinity.json
            "UESIM_LOG_DIR":           "/var/log/lte /root/ue",
            "UESIM_LOG_MAX_MB":        "200",
            "PERF_PROC_NAMES":         "app-manager lteue iperf3",

            "IPERF_LOG_DIR":           "/root/simnovator-app-manager/web/iperf/logs",
            "IPERF_MAX_SUBDIRS":       "10",

            "SIMNOVATOR_USER":         "sysadmin",   # almost always sysadmin
            "SIMNOVATOR_SSH_PORT":     "22",
            "SIMNOVATOR_PASS":         "",   # blank = SSH key auth
            "CONTAINER_ENGINE":        "",   # blank = auto (prefers podman)
            "SIMNOVATOR_CONTAINERS":   "",   # blank = all running
            "DOCKER_LOG_TAIL":         "20000",

            "SIM_API_USER":            "admin",   # Simnovator GUI/API admin — always admin/admin on stock rigs
            "SIM_API_PASS":            "admin",
            "SIM_API_LOGIN_PATH":      "/v2/login",
            "SIM_API_STATS_BUDGET":    "1000",
            "SIM_SCREENSHOT_PAGES":    "global,cell,ue,logs,health-check",
            "SIM_TESTCASE_STATUS":     "Completed",

            "BESZEL_USER":             "",   # Beszel read-only viewer account
            "BESZEL_PASS":             "",
            "BESZEL_CHART_RANGE":      "1h",
            "BESZEL_PYTHON":           "/opt/perf-qa-ui/venv/bin/python",

            "CALLBOX_USER":            "root",   # Amarisoft callbox ships as root
            "CALLBOX_SSH_PORT":        "22",
            "CALLBOX_PASS":            "",   # callbox typically uses password auth (Amarisoft)
            "ENB_CFG_PATH":            "/root/enb/config/enb.cfg",
            "MME_CFG_PATH":            "/root/mme/config/mme.cfg",
            "IMS_CFG_PATH":            "/root/mme/config/ims.cfg",
            "AMARISOFT_WS_CMD":        "",   # blank = auto via ws.js for `t`,`ue`,`cell`

            "APP_SERVER_USER":         "sysadmin",   # almost always sysadmin
            "APP_SERVER_SSH_PORT":     "22",
            "APP_SERVER_PASS":         "",   # blank = SSH key auth
            "IPERF_TARGET":            "",   # optional host:port reachability check
        },
    },
}
# Inherit fixed values from the primary profile for any profile that doesn't
# define them (forward-compat with multi-profile setups added later).
for _p in _INITIAL_PROFILES.values():
    if _p.get("fixed") is None:
        _p["fixed"] = next(iter(_INITIAL_PROFILES.values()))["fixed"]

# Form schema: only the fields the user actually fills in (IPs + test case).
# Everything else comes from the selected profile.
PROFILE_FORM_HOSTS = [
    ("UE_HOST",          "UE host",          "blank = skip UE section"),
    ("SIMNOVATOR_HOST",  "Simnovator host",  "blank = skip Simnovator section"),
    ("CALLBOX_HOST",     "Callbox",          "blank = skip callbox section"),
    ("APP_SERVER_HOST",  "App server",       "blank = skip app-server section"),
    ("BESZEL_HUB_URL",   "Beszel hub URL",   "blank = skip Beszel screenshot"),
    # Extra per-system fields surfaced in the "Add System" modal. SIMNOVATOR_PORT
    # feeds SIM_API_BASE (80 on v4.x, 3002 on v3.9; blank = auto). DU/CCS are
    # optional extra hosts stored on the profile.
    ("SIMNOVATOR_PORT",  "Simnovator port",  "blank = auto"),
    ("DU_HOST",          "DU host",          "optional"),
    ("CCS_HOST",         "CCS host",         "optional"),
]


def _detect_profile(values: dict, profiles: dict | None = None) -> str:
    """Pick the profile whose IP defaults best match the current setup.conf."""
    profiles = profiles if profiles is not None else load_profiles()
    if not profiles:
        return ""
    best, best_score = next(iter(profiles)), -1
    for name, prof in profiles.items():
        score = sum(1 for k, v in prof["defaults"].items() if values.get(k) == v)
        if score > best_score:
            best, best_score = name, score
    return best


SETUP_SCHEMA = [  # kept for backward-compat with the textarea editor; unused otherwise
    ("Test case", [
        ("TEST_CASE_NAME",      "Test case name",           "text",     "LAST_RUN or specific testcase name"),
        ("ITERATION_ID",        "Iteration ID (pin a run)", "text",     "blank = auto-resolve from name"),
    ]),
    ("Sections (1/0)", [
        ("COLLECT_UE",          "UE",                       "checkbox", ""),
        ("COLLECT_SIMNOVATOR",  "Simnovator",               "checkbox", ""),
        ("COLLECT_CALLBOX",     "Callbox",                  "checkbox", ""),
        ("COLLECT_APP_SERVER",  "App server",               "checkbox", ""),
        ("COLLECT_REST_API",    "REST API",                 "checkbox", ""),
        ("COLLECT_IPERF",       "iperf logs",               "checkbox", ""),
    ]),
    ("Output", [
        ("OUTPUT_DIR",          "Output directory",         "text",     "/var/lib/perf-qa/bundles"),
        ("COLLECTION_LABEL",    "Bundle label",             "text",     "perfqa"),
    ]),
    ("UE host (SSH out)", [
        ("UE_HOST",             "UE host IP",               "text",     "blank = run locally"),
        ("UE_USER",             "SSH user",                 "text",     ""),
        ("UE_SSH_PORT",         "SSH port",                 "text",     "22"),
        ("UE_PASS",             "SSH password",             "password", "blank = key-based"),
        ("UE_CFG_PATH",         "ue.cfg path",              "text",     "/root/ue/config/ue.cfg"),
        ("WORKLOAD_AFFINITY_JSON","workload_affinity.json path","text", ""),
        ("UESIM_LOG_DIR",       "UESIM log dirs (space-sep)","text",    "/var/log/lte /root/ue"),
        ("UESIM_LOG_MAX_MB",    "Per-file size cap (MB)",   "text",     "200"),
        ("PERF_PROC_NAMES",     "Perf processes (space-sep)","text",    "app-manager lteue iperf3"),
    ]),
    ("iperf logs", [
        ("IPERF_LOG_DIR",       "iperf log dir on UE host", "text",     "/root/simnovator-app-manager/web/iperf/logs"),
        ("IPERF_MAX_SUBDIRS",   "Max per-run subdirs to grab", "text",  "10"),
    ]),
    ("Simnovator host (SSH out)", [
        ("SIMNOVATOR_HOST",     "Simnovator host IP",       "text",     "blank = run locally"),
        ("SIMNOVATOR_USER",     "SSH user",                 "text",     ""),
        ("SIMNOVATOR_SSH_PORT", "SSH port",                 "text",     "22"),
        ("SIMNOVATOR_PASS",     "SSH password",             "password", "blank = key-based"),
        ("CONTAINER_ENGINE",    "Container engine",         "text",     "blank = auto (prefers podman)"),
        ("SIMNOVATOR_CONTAINERS","Containers (space-sep)",  "text",     "blank = all running"),
        ("DOCKER_LOG_TAIL",     "Per-container log tail",   "text",     "20000"),
    ]),
    ("Simnovator REST API", [
        ("SIM_API_BASE",        "Simnovator GUI base URL",  "text",     "http://<simnovator-host>"),
        ("SIM_API_USER",        "API user",                 "text",     ""),
        ("SIM_API_PASS",        "API password",             "password", ""),
        ("SIM_API_LOGIN_PATH",  "Login path",               "text",     "/v2/login"),
        ("SIM_API_STATS_BUDGET","Stats sample budget",      "text",     "1000"),
        ("SIM_SCREENSHOT_PAGES","GUI screenshot pages",     "text",     "global,cell,ue,logs"),
        ("SIM_TESTCASE_STATUS", "Testcase status in URL",   "text",     "Completed"),
    ]),
    ("Beszel", [
        ("BESZEL_HUB_URL",      "Beszel hub URL",           "text",     "http://<beszel-host>:8090 (blank = skip)"),
        ("BESZEL_USER",         "Beszel user",              "text",     ""),
        ("BESZEL_PASS",         "Beszel password",          "password", ""),
        ("BESZEL_CHART_RANGE",  "Chart range",              "select:1h,12h,24h,1w,30d", ""),
        ("BESZEL_PYTHON",       "Playwright venv python",   "text",     "/opt/perf-qa-ui/venv/bin/python"),
    ]),
    ("Callbox (over SSH)", [
        ("CALLBOX_HOST",        "Callbox host IP",          "text",     "blank = skip callbox section"),
        ("CALLBOX_USER",        "SSH user",                 "text",     ""),
        ("CALLBOX_SSH_PORT",    "SSH port",                 "text",     "22"),
        ("CALLBOX_PASS",        "SSH password",             "password", ""),
        ("ENB_CFG_PATH",        "enb.cfg path",             "text",     "/root/enb/config/enb.cfg"),
        ("AMARISOFT_WS_CMD",    "Override amari ws cmd",    "text",     "blank = auto via ws.js"),
    ]),
    ("App server (over SSH)", [
        ("APP_SERVER_HOST",     "App-server host IP",       "text",     "blank = skip app-server section"),
        ("APP_SERVER_USER",     "SSH user",                 "text",     ""),
        ("APP_SERVER_SSH_PORT", "SSH port",                 "text",     "22"),
        ("APP_SERVER_PASS",     "SSH password",             "password", "blank = key-based"),
        ("IPERF_TARGET",        "iperf reachability target","text",     "host:port (optional)"),
    ]),
]
SETUP_KNOWN_KEYS = {k for _, fields in SETUP_SCHEMA for (k, *_) in fields}

# Regex to match top-level KEY="value" / KEY=value lines (no inline comments).
# Preserves comments + blank lines + ${VAR:-default} substitutions on read by
# keeping the raw line; we only PARSE for display + WRITE back specific keys.
_CONF_LINE_RE = re.compile(r'^([A-Z][A-Z0-9_]*)\s*=\s*("?)(.*?)\2\s*(#.*)?$')
_ENV_DEFAULT_RE = re.compile(r'^\$\{[A-Z][A-Z0-9_]*:-(.*)\}$')


def _parse_setup_conf(text: str) -> dict:
    """Return {key: value} for all KEY="value" lines. ${VAR:-default} unwrapped."""
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = _CONF_LINE_RE.match(line)
        if not m:
            continue
        key, _, val, _ = m.groups()
        # Unwrap ${VAR:-default} so the form shows the actual default the
        # caller will get when no env override is set.
        ed = _ENV_DEFAULT_RE.match(val)
        if ed:
            val = ed.group(1)
        out[key] = val
    return out


def _write_setup_conf(updates: dict) -> tuple[bool, str]:
    """Rewrite setup.conf, replacing KEY="value" lines for keys in `updates`
    in-place. Keys not present get appended at the end under a # === Added
    by UI === section. Preserves comments + structure. Atomic write."""
    if not SETUP_CONF.exists():
        return False, f"setup.conf not found at {SETUP_CONF}"
    original = SETUP_CONF.read_text()
    new_lines = []
    seen = set()
    for line in original.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            new_lines.append(line); continue
        m = _CONF_LINE_RE.match(stripped)
        if not m:
            new_lines.append(line); continue
        key, _, _, comment = m.groups()
        if key in updates:
            seen.add(key)
            new_val = updates[key]
            # Preserve env-override pattern for fields commonly overridden.
            indent = line[: len(line) - len(line.lstrip())]
            comment_suffix = f"  {comment}" if comment else ""
            new_lines.append(f'{indent}{key}="{new_val}"{comment_suffix}')
        else:
            new_lines.append(line)
    # Append any updates we didn't replace (new keys).
    appended = [k for k in updates if k not in seen]
    if appended:
        new_lines.append("")
        new_lines.append("# === Added by UI ===")
        for k in appended:
            new_lines.append(f'{k}="{updates[k]}"')
    # Atomic write
    tmp = SETUP_CONF.with_suffix(".tmp")
    tmp.write_text("\n".join(new_lines) + "\n")
    tmp.replace(SETUP_CONF)
    return True, f"Wrote {len(updates)} field(s); {len(appended)} appended"


@app.route("/setup", methods=["GET"])
def setup_page():
    profiles = load_profiles()
    try:
        text = SETUP_CONF.read_text()
    except FileNotFoundError:
        text = ""
    return render_template_string(
        SETUP_HTML,
        profiles=profiles,
        host_fields=PROFILE_FORM_HOSTS,
        advanced_groups=PROFILE_ADVANCED_GROUPS,
        advanced_count=len(PROFILE_ADVANCED_KEYS),
        raw=text, conf_path=str(SETUP_CONF),
        profiles_json_path=str(PROFILES_JSON),
        beszel_url=_default_beszel_url(),
        version=VERSION,
    )


def _write_setup_from_profile(profile_name: str, form: dict) -> tuple[bool, str]:
    """Compose setup.conf from a profile's fixed creds + the user's IPs."""
    profiles = load_profiles()
    if profile_name not in profiles:
        return False, f"unknown profile: {profile_name}"
    prof = profiles[profile_name]
    out = dict(prof.get("fixed", {}))  # start with fixed creds + paths

    # Apply per-host IPs from the form, plus the per-section enable flag derived
    # from whether the IP is blank.
    host_to_collect = {
        "UE_HOST":         "COLLECT_UE",
        "SIMNOVATOR_HOST": "COLLECT_SIMNOVATOR",
        "CALLBOX_HOST":    "COLLECT_CALLBOX",
        "APP_SERVER_HOST": "COLLECT_APP_SERVER",
    }
    for key, _label, _ph in PROFILE_FORM_HOSTS:
        val = (form.get(key) or "").strip()
        out[key] = val
        if key in host_to_collect:
            out[host_to_collect[key]] = "1" if val else "0"

    # REST API + iperf are tied to Simnovator + UE respectively.
    out["COLLECT_REST_API"] = "1" if out["SIMNOVATOR_HOST"] else "0"
    out["COLLECT_IPERF"]    = "1" if out["UE_HOST"]         else "0"

    # SIM_API_BASE auto-derives from the Simnovator host IP + optional port
    # (80 on v4.x, 3002 on v3.9; blank = default 80). Lets the modal target a
    # non-default API port (e.g. a rig whose GUI is on :8080) without a code fix.
    _sim_port = (out.get("SIMNOVATOR_PORT") or "").strip()
    if out["SIMNOVATOR_HOST"]:
        out["SIM_API_BASE"] = (f"http://{out['SIMNOVATOR_HOST']}:{_sim_port}"
                               if _sim_port else f"http://{out['SIMNOVATOR_HOST']}")
    else:
        out["SIM_API_BASE"] = ""

    # Test case overrides (always editable in the form).
    out["TEST_CASE_NAME"] = (form.get("TEST_CASE_NAME") or "LAST_RUN").strip() or "LAST_RUN"
    out["ITERATION_ID"]   = (form.get("ITERATION_ID") or "").strip()

    # Force OUTPUT_DIR to the dir the UI actually scans for bundles. Older
    # profiles (migrated from pre-v1.0.4 installs) carry a stale OUTPUT_DIR
    # like /tmp/perf_collect — the collection then succeeds but writes where
    # the UI can't see it, surfacing as "Report FAIL — no bundle produced".
    # The collector host has exactly one bundle root, so pin it here.
    out["OUTPUT_DIR"] = str(BUNDLE_ROOT)

    # Pin the Python used for analyze / SYSTEM.md / screenshots to the venv
    # running THIS app — guaranteed to exist, be 3.10+, and be executable by
    # the service user. Migrated profiles can carry a stale BESZEL_PYTHON path
    # (e.g. an old dev venv under /home) that the perfqa user can't execute,
    # which otherwise fails the analyze + SYSTEM.md steps. ANALYZE_PYTHON falls
    # back to BESZEL_PYTHON in the collector, so this one value covers all.
    out["BESZEL_PYTHON"] = sys.executable

    # Write a brand-new setup.conf — much smaller and more readable than the
    # giant template, with a marker at the top showing the profile.
    lines = [
        "# =============================================================================",
        "# setup.conf  —  generated by perf-qa-ui",
        f"#   profile: {profile_name} ({prof['label']})",
        "# Blank *_HOST means that section is skipped (COLLECT_X=0).",
        "# Override any field manually after save — the script just sources this file.",
        "# =============================================================================",
        "",
    ]
    groups = [
        ("Test case",       ["TEST_CASE_NAME", "ITERATION_ID"]),
        ("Output",          ["OUTPUT_DIR", "COLLECTION_LABEL"]),
        ("Sections",        ["COLLECT_UE", "COLLECT_SIMNOVATOR", "COLLECT_CALLBOX",
                             "COLLECT_APP_SERVER", "COLLECT_REST_API", "COLLECT_IPERF",
                             "COLLECT_HEAT", "COLLECT_ANALYZE"]),
        ("UE host",         ["UE_HOST", "UE_USER", "UE_SSH_PORT", "UE_PASS",
                             "UE_CFG_PATH", "WORKLOAD_AFFINITY_JSON",
                             "UESIM_LOG_DIR", "UESIM_LOG_MAX_MB",
                             "PERF_PROC_NAMES"]),
        ("iperf",           ["IPERF_LOG_DIR", "IPERF_MAX_SUBDIRS"]),
        ("Simnovator host", ["SIMNOVATOR_HOST", "SIMNOVATOR_USER", "SIMNOVATOR_SSH_PORT",
                             "SIMNOVATOR_PASS", "CONTAINER_ENGINE",
                             "SIMNOVATOR_CONTAINERS", "DOCKER_LOG_TAIL"]),
        ("Simnovator REST API", ["SIM_API_BASE", "SIM_API_USER", "SIM_API_PASS",
                                 "SIM_API_LOGIN_PATH", "SIM_API_STATS_BUDGET",
                                 "SIM_SCREENSHOT_PAGES", "SIM_TESTCASE_STATUS"]),
        ("Beszel",          ["BESZEL_HUB_URL", "BESZEL_USER", "BESZEL_PASS",
                             "BESZEL_CHART_RANGE", "BESZEL_PYTHON"]),
        ("Callbox",         ["CALLBOX_HOST", "CALLBOX_USER", "CALLBOX_SSH_PORT",
                             "CALLBOX_PASS", "ENB_CFG_PATH", "MME_CFG_PATH",
                             "IMS_CFG_PATH", "AMARISOFT_WS_CMD"]),
        ("App server",      ["APP_SERVER_HOST", "APP_SERVER_USER", "APP_SERVER_SSH_PORT",
                             "APP_SERVER_PASS", "IPERF_TARGET"]),
    ]
    for title, keys in groups:
        lines.append(f"# ---- {title} ----")
        for k in keys:
            v = out.get(k, "")
            # Quote values that contain spaces or shell-meta.
            lines.append(f'{k}="{v}"')
        lines.append("")

    # Atomic write.
    tmp = SETUP_CONF.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n")
    tmp.replace(SETUP_CONF)
    skipped = [h[0] for h in PROFILE_FORM_HOSTS if not out.get(h[0])]
    return True, f"Profile {profile_name}; {len(skipped)} section(s) skipped (blank hosts)"


@app.route("/setup", methods=["POST"])
def setup_save():
    # Fall back to the first profile if the form didn't say which to use.
    _profiles = load_profiles()
    _default_profile = "Lab" if "Lab" in _profiles else (next(iter(_profiles), "") if _profiles else "")
    profile = (request.form.get("_profile") or "").strip() or _default_profile
    ok, msg = _write_setup_from_profile(profile, request.form)
    if ok:
        return jsonify({"ok": True, "message": msg}), 200
    return jsonify({"ok": False, "message": msg}), 500


# --- Profile CRUD ----------------------------------------------------------
# JSON API over profiles.json. Used by the Setup tab's Add/Edit/Delete flow
# and by the Collector tab to render its profile dropdown.

_PROFILE_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")


@app.route("/api/testcases")
def api_testcases():
    """List Simnovator test cases for the Collector's datalist suggestion.

    Proxies the GUI's `/v2/testcases/list` after a quick JWT auth. Reads
    creds from a query param `?profile=<name>`; falls back to the canonical
    first profile so the UI's dropdown can populate from the same profile
    the user is about to run.
    """
    profiles = load_profiles()
    _fallback = "Lab" if "Lab" in profiles else (next(iter(profiles), "") if profiles else "")
    profile = request.args.get("profile") or _fallback
    if profile not in profiles:
        return jsonify({"items": [], "error": f"unknown profile: {profile}"}), 404
    fixed = profiles[profile].get("fixed", {})
    defaults = profiles[profile].get("defaults", {})
    sim_host = defaults.get("SIMNOVATOR_HOST", "")
    if not sim_host:
        return jsonify({"items": [], "error": "profile has no SIMNOVATOR_HOST"}), 400
    base = f"http://{sim_host}"
    user = fixed.get("SIM_API_USER", "admin")
    pwd  = fixed.get("SIM_API_PASS", "admin")
    login_path = fixed.get("SIM_API_LOGIN_PATH", "/v2/login")
    try:
        import urllib.request as _ur, json as _json
        req = _ur.Request(
            f"{base}{login_path}",
            data=_json.dumps({"username": user, "password": pwd}).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with _ur.urlopen(req, timeout=8) as r:
            token = _json.load(r).get("access_token", "")
        if not token:
            return jsonify({"items": [], "error": "login returned no token"}), 502
        req = _ur.Request(f"{base}/v2/testcases/list",
                          headers={"Authorization": f"Bearer {token}"})
        with _ur.urlopen(req, timeout=10) as r:
            data = _json.load(r)
        # Response shape: {status, message, testcase: [{name,id}, ...]}.
        # Earlier builds may have used `items`, fall back for safety.
        items = data.get("testcase") or data.get("items") or [] if isinstance(data, dict) else data
        names = sorted({(t.get("name") or "").strip() for t in items
                        if isinstance(t, dict) and t.get("name")})
        return jsonify({"items": names, "count": len(names)})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"items": [], "error": str(exc)}), 502


# ---------------------------------------------------------------------------
# Shared SSH key — uploaded once via the Setup tab + auto-picked by OpenSSH
# for every outbound connection from the collector. Path is the running
# service user's standard SSH default location, so we don't need any -i
# flag in the bash script. Customer install: $HOME = /var/lib/perfqa. Old
# .36 install: $HOME = /home/sysadmin. Either way Path.home() resolves it.
# ---------------------------------------------------------------------------
_SSH_DIR = Path(os.environ.get("HOME", str(Path.home()))) / ".ssh"
_SSH_KEY_PATH = _SSH_DIR / "id_ed25519"
_SSH_KEY_HEADERS = (
    b"-----BEGIN OPENSSH PRIVATE KEY-----",
    b"-----BEGIN RSA PRIVATE KEY-----",
    b"-----BEGIN EC PRIVATE KEY-----",
    b"-----BEGIN DSA PRIVATE KEY-----",
    b"-----BEGIN PRIVATE KEY-----",
)


def _ssh_key_info() -> dict:
    """Status, fingerprint, and public key for the uploaded SSH key.

    Fingerprint + public key are derived via ssh-keygen so the UI can show
    them without ever exposing the private bytes.
    """
    info: dict = {"present": False, "path": str(_SSH_KEY_PATH)}
    if not _SSH_KEY_PATH.exists():
        return info
    st = _SSH_KEY_PATH.stat()
    info.update({
        "present":     True,
        "size":        st.st_size,
        "mode":        oct(st.st_mode & 0o777),
        "mtime":       st.st_mtime,
        "fingerprint": "",
        "pubkey":      "",
    })
    try:
        fp = subprocess.run(
            ["ssh-keygen", "-l", "-f", str(_SSH_KEY_PATH)],
            capture_output=True, text=True, timeout=5,
        )
        if fp.returncode == 0:
            info["fingerprint"] = fp.stdout.strip()
    except Exception:  # noqa: BLE001
        pass
    try:
        pub = subprocess.run(
            ["ssh-keygen", "-y", "-f", str(_SSH_KEY_PATH)],
            capture_output=True, text=True, timeout=5,
        )
        if pub.returncode == 0:
            info["pubkey"] = pub.stdout.strip()
    except Exception:  # noqa: BLE001
        pass
    return info


@app.route("/api/ssh-key", methods=["GET"])
def api_ssh_key_get():
    return jsonify(_ssh_key_info())


@app.route("/api/ssh-key", methods=["POST"])
def api_ssh_key_upload():
    f = request.files.get("key")
    if f is None:
        return jsonify({"ok": False, "error": "no file uploaded (use multipart field name 'key')"}), 400
    data = f.read()
    if not any(data.startswith(h) for h in _SSH_KEY_HEADERS):
        return jsonify({"ok": False,
                        "error": "file does not start with an SSH/PEM private-key header"}), 400
    # Refuse upload if file looks encrypted — we can't decrypt at runtime and
    # the BatchMode=yes flag in the collector would silently fail.
    if b"ENCRYPTED" in data[:512]:
        return jsonify({"ok": False,
                        "error": "passphrase-protected keys aren't supported (ssh-keygen -p to remove)"}), 400
    try:
        _SSH_DIR.mkdir(parents=True, exist_ok=True)
        os.chmod(_SSH_DIR, 0o700)
        # Back up any existing key so the operator can recover if they
        # uploaded the wrong file. Only keep ONE backup (overwrite each time).
        if _SSH_KEY_PATH.exists():
            _SSH_KEY_PATH.replace(_SSH_KEY_PATH.with_suffix(".bak"))
        _SSH_KEY_PATH.write_bytes(data)
        os.chmod(_SSH_KEY_PATH, 0o600)
    except OSError as exc:
        return jsonify({"ok": False, "error": f"write failed: {exc}"}), 500
    out = _ssh_key_info()
    out["ok"] = True
    out["message"] = ("key written to " + str(_SSH_KEY_PATH) +
                      " — ssh will auto-use it for outbound connections")
    return jsonify(out)


@app.route("/api/ssh-key", methods=["DELETE"])
def api_ssh_key_delete():
    if _SSH_KEY_PATH.exists():
        _SSH_KEY_PATH.unlink()
    return jsonify({"ok": True, "path": str(_SSH_KEY_PATH)})


# ---------------------------------------------------------------------------
# Self-update from GitHub. The Update icon in the topbar hits /api/update,
# which downloads main.tar.gz from the canonical repo, lays it down at
# ${SCRIPT_DIR} + ${UI_DIR}, and re-runs scripts/install.sh as root (sudo).
# install.sh is idempotent so this safely upgrades an existing install.
# ---------------------------------------------------------------------------
UPDATE_REPO_URL = os.environ.get(
    "PERFQA_UPDATE_TARBALL",
    # Private Simnovus-Tech/oneclick — authenticated API tarball endpoint.
    # The perfqa-update wrapper supplies the Bearer token from its root-only
    # token file; this value is only a fallback the wrapper's own default
    # normally supersedes.
    "https://api.github.com/repos/Simnovus-Tech/oneclick/tarball/main",
)


@app.route("/api/update", methods=["POST"])
def api_update():
    """Run /usr/local/sbin/perfqa-update via sudo -n.

    The wrapper script (planted by install.sh, sudoers entry also planted
    by install.sh) downloads the latest tarball from the oneclick repo and
    re-runs install.sh from it. systemctl restart happens INSIDE install.sh
    so this response may cut off mid-stream — the client treats that as
    expected and reloads after a few seconds.
    """
    updater = "/usr/local/sbin/perfqa-update"
    if not Path(updater).exists():
        return jsonify({
            "ok": False,
            "log": (f"[update] {updater} missing — was this install upgraded "
                    f"to the self-update layout? Run install.sh once locally "
                    f"to plant the wrapper + sudoers entry."),
        }), 500
    try:
        rc = subprocess.run(
            ["sudo", "-n", updater],
            capture_output=True, text=True, timeout=600,
            env={**os.environ, "PERFQA_UPDATE_TARBALL": UPDATE_REPO_URL},
        )
        out = (rc.stdout or "")[-4000:]
        if rc.stderr:
            out += "\n--- stderr ---\n" + rc.stderr[-2000:]
        if rc.returncode != 0:
            return jsonify({"ok": False, "log": out + f"\n[update] exited {rc.returncode}"}), 500
        return jsonify({"ok": True, "log": out + "\n[update] done"})
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "log": "[update] timed out after 600s"}), 504
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "log": f"[update] FAILED: {exc}"}), 500


@app.route("/api/profiles", methods=["GET"])
def api_profiles_list():
    return jsonify(load_profiles())


@app.route("/api/profiles/<name>", methods=["GET"])
def api_profile_get(name):
    profiles = load_profiles()
    if name not in profiles:
        abort(404)
    return jsonify(profiles[name])


@app.route("/api/profiles/<name>", methods=["PUT"])
def api_profile_put(name):
    if not _PROFILE_ID_RE.match(name):
        return jsonify({"ok": False, "message":
            "profile id must match [A-Za-z][A-Za-z0-9_-]{0,63}"}), 400
    body = request.get_json(silent=True) or {}
    label = (body.get("label") or name).strip()
    defaults = body.get("defaults") or {}
    fixed = body.get("fixed") or {}
    # Validate the keys we know about. Anything unknown gets dropped to keep
    # profiles.json clean — the form should only post known keys.
    valid_default_keys = {k for k, _l, _p in PROFILE_FORM_HOSTS}
    defaults = {k: str(v) for k, v in defaults.items() if k in valid_default_keys}
    fixed = {k: str(v) for k, v in fixed.items()}
    profiles = load_profiles()
    profiles[name] = {"label": label, "defaults": defaults, "fixed": fixed}
    save_profiles_dict(profiles)
    return jsonify({"ok": True, "message": f"saved profile {name}"})


@app.route("/api/profiles/<name>", methods=["DELETE"])
def api_profile_delete(name):
    profiles = load_profiles()
    if name not in profiles:
        abort(404)
    if len(profiles) <= 1:
        return jsonify({"ok": False,
            "message": "can't delete the only profile"}), 400
    del profiles[name]
    save_profiles_dict(profiles)
    return jsonify({"ok": True, "message": f"deleted {name}"})


# Keys we model in the "Advanced" section of the Setup form, grouped by host
# so the form is scannable. Each tuple = (group_label, [(KEY, field_label), ...]).
# The Collector form never shows these — the profile carries them.
PROFILE_ADVANCED_GROUPS = [
    ("UE host", [
        ("UE_USER",                "SSH user"),
        ("UE_SSH_PORT",            "SSH port"),
        ("UE_PASS",                "SSH password (blank=key)"),
        ("UE_CFG_PATH",            "ue.cfg path"),
        ("WORKLOAD_AFFINITY_JSON", "workload_affinity.json path"),
        ("UESIM_LOG_DIR",          "UESIM log dirs (space-sep)"),
        ("UESIM_LOG_MAX_MB",       "Per-file size cap (MB)"),
        ("PERF_PROC_NAMES",        "Perf processes"),
    ]),
    ("iperf logs", [
        ("IPERF_LOG_DIR",          "iperf log dir"),
        ("IPERF_MAX_SUBDIRS",      "Max subdirs to grab"),
        ("IPERF_TARGET",           "Reachability target (optional)"),
    ]),
    ("Simnovator host", [
        ("SIMNOVATOR_USER",        "SSH user"),
        ("SIMNOVATOR_SSH_PORT",    "SSH port"),
        ("SIMNOVATOR_PASS",        "SSH password (blank=key)"),
        ("CONTAINER_ENGINE",       "Container engine (blank=auto)"),
        ("SIMNOVATOR_CONTAINERS",  "Containers (blank=all)"),
        ("DOCKER_LOG_TAIL",        "Per-container log tail"),
    ]),
    ("Simnovator REST API", [
        ("SIM_API_USER",           "API user"),
        ("SIM_API_PASS",           "API password"),
        ("SIM_API_LOGIN_PATH",     "Login path"),
        ("SIM_API_STATS_BUDGET",   "Stats sample budget"),
        ("SIM_SCREENSHOT_PAGES",   "GUI screenshot pages"),
        ("SIM_TESTCASE_STATUS",    "Testcase status in URL"),
    ]),
    ("Beszel", [
        ("BESZEL_USER",            "Beszel user"),
        ("BESZEL_PASS",            "Beszel password"),
        ("BESZEL_CHART_RANGE",     "Chart range"),
        ("BESZEL_PYTHON",          "Playwright venv python"),
    ]),
    ("Callbox", [
        ("CALLBOX_USER",           "SSH user"),
        ("CALLBOX_SSH_PORT",       "SSH port"),
        ("CALLBOX_PASS",           "SSH password"),
        ("ENB_CFG_PATH",           "enb.cfg path"),
        ("MME_CFG_PATH",           "mme.cfg path"),
        ("IMS_CFG_PATH",           "ims.cfg path"),
        ("AMARISOFT_WS_CMD",       "Override amari ws cmd (blank=auto)"),
    ]),
    ("App server", [
        ("APP_SERVER_USER",        "SSH user"),
        ("APP_SERVER_SSH_PORT",    "SSH port"),
        ("APP_SERVER_PASS",        "SSH password (blank=key)"),
    ]),
]
# Flat list kept for any code that iterates all keys (e.g. server-side PUT
# validation could whitelist these).
PROFILE_ADVANCED_KEYS = [(k, l) for _grp, fields in PROFILE_ADVANCED_GROUPS for (k, l) in fields]


@app.route("/run", methods=["POST"])
def run():
    with LOCK:
        for jid, j in JOBS.items():
            if j["state"] == "running":
                return jsonify({"error": f"job {jid} already running"}), 409

        # If a profile is selected, regenerate setup.conf from that profile +
        # the user's IP overrides BEFORE launching the script. This is the
        # "pick profile -> click Run -> backend rewrites setup.conf" flow.
        profile_name = (request.form.get("_profile") or "").strip()
        if profile_name:
            profiles = load_profiles()
            if profile_name not in profiles:
                return jsonify({"error": f"unknown profile: {profile_name}"}), 400
            prof_defaults = profiles[profile_name]["defaults"]
            # Build a setup_form that combines profile defaults with anything
            # the Collector form overrode (currently just test case + iteration).
            setup_form = {
                "TEST_CASE_NAME": request.form.get("test_case_name", "LAST_RUN"),
                "ITERATION_ID":   request.form.get("iteration_id", ""),
            }
            for host_key, _l, _p in PROFILE_FORM_HOSTS:
                setup_form[host_key] = prof_defaults.get(host_key, "")
            ok, msg = _write_setup_from_profile(profile_name, setup_form)
            if not ok:
                return jsonify({"error": f"setup.conf rewrite failed: {msg}"}), 500

        job_id = uuid.uuid4().hex[:8]
        env_overrides = {}
        tcn = (request.form.get("test_case_name") or "").strip()
        iter_id = (request.form.get("iteration_id") or "").strip()
        # Lookback-mode disables the testcase/iteration inputs in the UI, so
        # only one of these branches actually fires per submission.
        lookback_raw = (request.form.get("lookback_minutes") or "").strip()
        if lookback_raw:
            try:
                mins = int(lookback_raw)
                if 1 <= mins <= 1440:
                    env_overrides["LOOKBACK_MINUTES"] = str(mins)
                else:
                    return jsonify({"error": f"lookback_minutes out of range (1..1440): {mins}"}), 400
            except ValueError:
                return jsonify({"error": f"lookback_minutes not an integer: {lookback_raw!r}"}), 400
        if tcn:
            env_overrides["TEST_CASE_NAME"] = tcn
        if iter_id:
            env_overrides["ITERATION_ID"] = iter_id
        # Per-run section toggles still override what's in setup.conf via env.
        for section in ("UE", "SIMNOVATOR", "CALLBOX", "APP_SERVER",
                        "REST_API", "IPERF", "HEAT", "ANALYZE"):
            field = f"collect_{section.lower()}"
            if field in request.form:
                checked = request.form.get(field) == "on"
                env_overrides[f"COLLECT_{section}"] = "1" if checked else "0"
        # Label the running job in the topbar. Lookback mode wins over tcn
        # since LOOKBACK_MINUTES is what the script will actually use.
        if "LOOKBACK_MINUTES" in env_overrides:
            job_label = f"lookback_{env_overrides['LOOKBACK_MINUTES']}m"
        else:
            job_label = tcn or "LAST_RUN"
        JOBS[job_id] = {
            "state": "running",
            "lines": deque(maxlen=5000),
            "started": time.time(),
            "env": env_overrides,
            "profile": profile_name,
            "test_case": job_label,
        }
    threading.Thread(target=_run_job, args=(job_id, env_overrides), daemon=True).start()
    return jsonify({"job_id": job_id, "profile": profile_name})


@app.route("/jobs/<job_id>/stream")
def stream(job_id):
    if job_id not in JOBS:
        abort(404)

    def gen():
        sent = 0
        last_ping = time.time()
        while True:
            job = JOBS[job_id]
            lines = list(job["lines"])
            while sent < len(lines):
                yield f"data: {json.dumps({'line': lines[sent]})}\n\n"
                sent += 1
            if job["state"] == "done":
                payload = {
                    "done": True,
                    "bundle": job.get("bundle"),
                    "counts": job.get("counts"),
                    "returncode": job.get("returncode"),
                    "job_id": job_id,
                }
                yield f"data: {json.dumps(payload)}\n\n"
                return
            # SSE comment-only keepalive every 3s — keeps proxies + dev
            # servers from buffering / closing the stream during quiet
            # periods (e.g. while we wait for podman log dumps to land).
            if time.time() - last_ping > 3:
                yield ": ping\n\n"
                last_ping = time.time()
            time.sleep(0.2)

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/jobs/<job_id>/manifest")
def manifest(job_id):
    job = JOBS.get(job_id)
    if not job or "manifest" not in job:
        abort(404)
    return Response(job["manifest"], mimetype="text/plain")


@app.route("/bundles")
def bundles_list():
    items = []
    # Match new (.zip) and legacy (.tar.gz) bundle names.
    patterns = ["*.zip", "*.tar.gz"]
    seen = []
    for pat in patterns:
        seen.extend(glob.glob(f"{BUNDLE_ROOT}/{pat}"))
    # Skip non-perf-qa archives (e.g. user files in /tmp/perf_collect).
    seen = [p for p in seen
            if "_diagnostics_" in Path(p).name or Path(p).name.startswith("qa_perftest_")]
    for archive in sorted(set(seen), key=os.path.getmtime, reverse=True)[:20]:
        st = os.stat(archive)
        items.append({"name": Path(archive).name, "size": st.st_size, "mtime": st.st_mtime})
    return jsonify(items)


_BUNDLE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.(zip|tar\.gz)$")


def _extract_member_text(name: str, member_basename: str) -> tuple[str | None, int]:
    """Pull a top-level file out of the bundle archive. Returns (text, status).

    Tries the bundle dir on disk first (same dir is kept next to the zip after
    the run); falls back to extracting from the archive. status is 200 if
    found, 404 if missing, used by callers to set the Response status.
    """
    if not _BUNDLE_NAME_RE.fullmatch(name):
        return None, 404
    # On-disk first (fast path — no zip seek).
    bdir = _bundle_dir_for(name)
    f_disk = bdir / member_basename
    if f_disk.exists():
        try:
            return f_disk.read_text(errors="replace"), 200
        except OSError:
            pass
    # Fall back to the archive.
    path = BUNDLE_ROOT / name
    if not path.exists():
        return None, 404
    import zipfile, tarfile
    try:
        if name.endswith(".zip"):
            with zipfile.ZipFile(path) as zf:
                for m in zf.namelist():
                    if m.endswith("/" + member_basename) or m == member_basename:
                        return zf.read(m).decode("utf-8", errors="replace"), 200
        else:
            with tarfile.open(path, "r:gz") as tf:
                for m in tf.getmembers():
                    if m.name.endswith("/" + member_basename) or m.name == member_basename:
                        f = tf.extractfile(m)
                        if f:
                            return f.read().decode("utf-8", errors="replace"), 200
    except Exception:
        return None, 404
    return None, 404


@app.route("/bundles/<name>/analysis")
def bundle_analysis(name):
    """Extract and serve ANALYSIS.md from a bundle archive as text/plain."""
    text, status = _extract_member_text(name, "ANALYSIS.md")
    if status == 200:
        return Response(text, mimetype="text/plain; charset=utf-8")
    return Response("(no ANALYSIS.md in this bundle — run with Analyze enabled)",
                    status=404, mimetype="text/plain; charset=utf-8")


@app.route("/bundles/<name>/system")
def bundle_system(name):
    """Extract and serve SYSTEM.md from a bundle archive as text/plain."""
    text, status = _extract_member_text(name, "SYSTEM.md")
    if status == 200:
        return Response(text, mimetype="text/plain; charset=utf-8")
    return Response("(no SYSTEM.md in this bundle — re-run with the latest collector)",
                    status=404, mimetype="text/plain; charset=utf-8")


@app.route("/bundles/<name>/disk")
def bundle_disk(name):
    """Serve simnovator/disk_usage.txt — filesystem %, per-volume sizes
    (autosave/timescaledb/openobserve), /var/log, cores, and the cleanup cap."""
    text, status = _extract_member_text(name, "simnovator/disk_usage.txt")
    if status == 200:
        return Response(text, mimetype="text/plain; charset=utf-8")
    return Response("(no disk_usage.txt in this bundle — re-run with the latest collector)",
                    status=404, mimetype="text/plain; charset=utf-8")


# --- Bundle file browser ----------------------------------------------------
# Two endpoints feed the Browse tab: /files returns the full tree as JSON,
# /file?path=... streams one file as text (size-capped so a giant log doesn't
# blow up the browser). Both prefer the on-disk bundle dir over the .zip.

_FILE_VIEW_CAP_BYTES = 500 * 1024   # 500 KB tail cap on text /file responses
# Keeps the browser viewer responsive — anything bigger needs the zip download
# or an actual log viewer. 500 KB ≈ 5000 lines of structured-log text, plenty
# for "what happened around the test window" debugging.

# Binary types we serve as-is (no tail-cap, no text decode). Anything else
# falls through to the text path with the cap above.
_BINARY_MIME = {
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif":  "image/gif",
    ".webp": "image/webp",
    ".svg":  "image/svg+xml",
    ".pdf":  "application/pdf",
    ".zip":  "application/zip",
    ".tar":  "application/x-tar",
    ".gz":   "application/gzip",
}


def _strip_top_dir(member_name: str) -> str:
    """Trim the bundle's top-level directory off an archive member's name.

    Archive members look like '<bundle>/ue/cpu/cpu_affinity.txt'; we want the
    on-disk-relative form 'ue/cpu/cpu_affinity.txt' so both endpoints (on-disk
    and zip-fallback) return paths the UI can use uniformly.
    """
    parts = member_name.split("/", 1)
    return parts[1] if len(parts) == 2 else parts[0]


@app.route("/bundles/<name>/files")
def bundle_files(name):
    """JSON list of every file in the bundle: [{path, size}, ...]."""
    if not _BUNDLE_NAME_RE.fullmatch(name):
        abort(404)
    files: list[dict] = []
    bdir = _bundle_dir_for(name)
    if bdir.is_dir():
        for p in bdir.rglob("*"):
            if p.is_file():
                files.append({
                    "path": str(p.relative_to(bdir)).replace("\\", "/"),
                    "size": p.stat().st_size,
                })
    else:
        archive = BUNDLE_ROOT / name
        if not archive.exists():
            abort(404)
        import zipfile, tarfile
        try:
            if name.endswith(".zip"):
                with zipfile.ZipFile(archive) as zf:
                    for info in zf.infolist():
                        if not info.is_dir():
                            rel = _strip_top_dir(info.filename)
                            if rel:
                                files.append({"path": rel, "size": info.file_size})
            else:
                with tarfile.open(archive, "r:gz") as tf:
                    for m in tf.getmembers():
                        if m.isfile():
                            rel = _strip_top_dir(m.name)
                            if rel:
                                files.append({"path": rel, "size": m.size})
        except Exception:
            abort(500)
    files.sort(key=lambda x: x["path"])
    return jsonify({"name": name, "files": files, "count": len(files)})


def _serve_file_text(data: bytes, total_size: int) -> Response:
    """Return file bytes as text/plain, tailing if over the cap."""
    truncated = total_size > _FILE_VIEW_CAP_BYTES
    if truncated:
        data = data[-_FILE_VIEW_CAP_BYTES:]
        # Show units that make sense at the chosen cap (KB for ≤ ~1 MB).
        cap_label = (f"{_FILE_VIEW_CAP_BYTES // 1024} KB" if _FILE_VIEW_CAP_BYTES < 1048576
                     else f"{_FILE_VIEW_CAP_BYTES // 1024 // 1024} MB")
        total_label = (f"{total_size // 1024} KB" if total_size < 1048576
                       else f"{total_size / 1048576:.1f} MB")
        prefix = (f"# showing last {cap_label} of {total_label} — "
                  f"download the zip for the full file\n\n")
    else:
        prefix = ""
    text = prefix + data.decode("utf-8", errors="replace")
    return Response(text, mimetype="text/plain; charset=utf-8",
                    headers={"X-Total-Size": str(total_size),
                             "X-Truncated": "true" if truncated else "false"})


@app.route("/bundles/<name>/file")
def bundle_file(name):
    """Stream one bundle file. Images/PDFs go through as-is with the right
    Content-Type; text/log files get tail-capped to keep the browser happy."""
    if not _BUNDLE_NAME_RE.fullmatch(name):
        abort(404)
    rel = (request.args.get("path") or "").strip()
    # Path-safety: no parent traversal, no absolute paths, no NUL bytes.
    if (not rel or ".." in rel.split("/") or rel.startswith("/")
            or rel.startswith("\\") or "\x00" in rel):
        abort(400)
    ext = Path(rel).suffix.lower()
    binary_mime = _BINARY_MIME.get(ext)
    download = request.args.get("download", "").lower() in ("1", "true", "yes")
    fname = Path(rel).name

    def _serve(data: bytes, total_size: int):
        # Downloads always get the full file (no tail-cap) and force-attachment
        # via Content-Disposition. View-only mode keeps the existing behaviour:
        # images stream as-is, text gets tail-capped to 500 KB.
        if download:
            mt = binary_mime or "application/octet-stream"
            return Response(data, mimetype=mt, headers={
                "Content-Disposition": f'attachment; filename="{fname}"',
                "X-Total-Size": str(total_size),
                "X-Truncated": "false",
            })
        if binary_mime:
            return Response(data, mimetype=binary_mime,
                            headers={"X-Total-Size": str(total_size),
                                     "X-Truncated": "false"})
        return _serve_file_text(data, total_size)

    # On-disk fast path.
    bdir = _bundle_dir_for(name)
    f_disk = bdir / rel
    if f_disk.exists() and f_disk.is_file():
        size = f_disk.stat().st_size
        # Downloads + images always get the whole file; text views > cap get
        # the tail only.
        if download or binary_mime or size <= _FILE_VIEW_CAP_BYTES:
            data = f_disk.read_bytes()
        else:
            with open(f_disk, "rb") as fh:
                fh.seek(-_FILE_VIEW_CAP_BYTES, 2)
                data = fh.read()
        return _serve(data, size)

    # Zip-fallback.
    archive = BUNDLE_ROOT / name
    if not archive.exists():
        abort(404)
    import zipfile, tarfile
    try:
        if name.endswith(".zip"):
            with zipfile.ZipFile(archive) as zf:
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    if _strip_top_dir(info.filename) == rel:
                        with zf.open(info) as fh:
                            return _serve(fh.read(), info.file_size)
        elif name.endswith(".tar.gz"):
            with tarfile.open(archive, "r:gz") as tf:
                for m in tf.getmembers():
                    if not m.isfile():
                        continue
                    if _strip_top_dir(m.name) == rel:
                        fh = tf.extractfile(m)
                        if fh:
                            return _serve(fh.read(), m.size)
    except Exception:
        abort(500)
    abort(404)


@app.route("/bundles/<name>")
def bundle_download(name):
    # Path-safety: name must be a plain archive file under BUNDLE_ROOT,
    # matching either the new <tc>_diagnostics_<ts>.zip pattern or the
    # legacy qa_perftest_*.tar.gz one.
    if not _BUNDLE_NAME_RE.fullmatch(name):
        abort(404)
    if "_diagnostics_" not in name and not name.startswith("qa_perftest_"):
        abort(404)
    path = BUNDLE_ROOT / name
    if not path.exists():
        abort(404)
    mt = "application/zip" if name.endswith(".zip") else "application/gzip"
    return send_file(str(path), as_attachment=True, download_name=name, mimetype=mt)


# --- Logs tab --------------------------------------------------------------
# Every bundle has a collect.log next to its MANIFEST.txt (inside the bundle
# dir, which lives alongside the .zip after the run). The Logs tab lists those
# logs by date and serves the raw text on click. Active runs are also shown
# (their lines live in-memory in JOBS).

def _bundle_dir_for(archive_name: str) -> Path:
    """Map qa_x.zip / qa_x.tar.gz back to the bundle dir of the same name."""
    if archive_name.endswith(".tar.gz"):
        return BUNDLE_ROOT / archive_name[: -len(".tar.gz")]
    return BUNDLE_ROOT / archive_name[: -len(".zip")]


def _read_log_for_bundle(name: str) -> str | None:
    """Return collect.log text for an archived bundle.

    Tries the on-disk bundle dir first (kept next to the .zip by the script);
    if that's been cleaned up, falls back to extracting from the archive.
    """
    bdir = _bundle_dir_for(name)
    log_path = bdir / "collect.log"
    if log_path.exists():
        try:
            return log_path.read_text(errors="replace")
        except Exception:
            return None
    # Fallback: pull collect.log out of the archive.
    archive = BUNDLE_ROOT / name
    if not archive.exists():
        return None
    import zipfile, tarfile
    try:
        if name.endswith(".zip"):
            with zipfile.ZipFile(archive) as zf:
                for member in zf.namelist():
                    if member.endswith("/collect.log") or member == "collect.log":
                        return zf.read(member).decode("utf-8", errors="replace")
        else:
            with tarfile.open(archive, "r:gz") as tf:
                for m in tf.getmembers():
                    if m.name.endswith("/collect.log") or m.name == "collect.log":
                        f = tf.extractfile(m)
                        if f:
                            return f.read().decode("utf-8", errors="replace")
    except Exception:
        return None
    return None


@app.route("/api/logs")
def api_logs():
    """JSON list of available run logs (active jobs first, then archived bundles)."""
    items = []
    # 1) Active in-memory jobs (no bundle yet OR bundle just landed).
    for jid, j in sorted(JOBS.items(), key=lambda kv: -kv[1].get("started", 0)):
        items.append({
            "id":        jid,
            "kind":      "job",
            "state":     j["state"],
            "started":   j.get("started"),
            "finished":  j.get("finished"),
            "lines":     len(j["lines"]),
            "bundle":    j.get("bundle"),
            "profile":   j.get("profile", ""),
            "test_case": j.get("test_case", ""),
        })
    # 2) Archived bundles (deduped against any already-mapped active job).
    seen_bundles = {j.get("bundle") for j in JOBS.values() if j.get("bundle")}
    patterns = ["*.zip", "*.tar.gz"]
    archives = []
    for pat in patterns:
        archives.extend(glob.glob(f"{BUNDLE_ROOT}/{pat}"))
    archives = [p for p in archives
                if "_diagnostics_" in Path(p).name or Path(p).name.startswith("qa_perftest_")]
    for archive in sorted(set(archives), key=os.path.getmtime, reverse=True)[:50]:
        name = Path(archive).name
        if name in seen_bundles:
            continue
        st = os.stat(archive)
        bdir = _bundle_dir_for(name)
        log_path = bdir / "collect.log"
        log_size = log_path.stat().st_size if log_path.exists() else 0
        items.append({
            "id":       name,
            "kind":     "bundle",
            "state":    "archived",
            "mtime":    st.st_mtime,
            "size":     st.st_size,
            "log_size": log_size,
            "bundle":   name,
        })
    return jsonify(items)


@app.route("/logs/<name>/raw")
def log_raw(name):
    """Plain-text collect.log for an archived bundle."""
    if not _BUNDLE_NAME_RE.fullmatch(name):
        abort(404)
    text = _read_log_for_bundle(name)
    if text is None:
        return Response("(no collect.log found for this bundle)",
                        status=404, mimetype="text/plain; charset=utf-8")
    return Response(text, mimetype="text/plain; charset=utf-8")


@app.route("/jobs/<job_id>/log")
def job_log(job_id):
    """Snapshot of an in-memory job's log lines as plain text."""
    job = JOBS.get(job_id)
    if not job:
        abort(404)
    return Response("\n".join(job["lines"]), mimetype="text/plain; charset=utf-8")


@app.route("/logs")
def logs_page():
    return render_template_string(LOGS_HTML, host_label=os.uname().nodename,
                                  beszel_url=_default_beszel_url(),
                                  version=VERSION)


# /system and /browse used to be standalone pages — they're now sub-views
# inside /logs. Keep these routes alive so old bookmarks and any external
# links land on the right view (with the bundle hash preserved).
def _redirect_to_logs(view: str) -> Response:
    # Forward #<bundle> hash → /logs#<bundle>/<view>. Hash isn't sent in the
    # HTTP request (it's client-side), so we use a tiny HTML hop.
    html = (
        f"<!doctype html><meta charset='utf-8'>"
        f"<script>"
        f"var h=(location.hash||'').replace(/^#/,'');"
        f"location.replace('/logs#'+(h?h+'/{view}':''));"
        f"</script>"
    )
    return Response(html, mimetype="text/html; charset=utf-8")


@app.route("/system")
def system_page():
    return _redirect_to_logs("system")


@app.route("/browse")
def browse_page():
    return _redirect_to_logs("files")


HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OneClick — Simnovus</title>
<link rel="icon" type="image/png" href="/favicon.png">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
/* Simnovator-themed palette — same brand orange + dark navy chrome */
:root{
  --fg:#1f2937;--mut:#6b7280;--mut2:#94a3b8;
  --bd:#e5e7eb;--bg:#f8fafc;--card:#ffffff;
  --brand:#f97316;--brand-h:#ea580c;
  --nav:#1c1c2e;--nav-2:#252539;
  --ok:#16a34a;--warn:#d97706;--err:#dc2626;
  --shadow:0 1px 2px rgba(15,23,42,.04),0 1px 1px rgba(15,23,42,.06);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;color:var(--fg);background:var(--bg)}

/* Top bar — dark navy like Simnovator GUI */
.topbar{
  background:var(--nav);color:#fff;
  padding:10px 22px;display:flex;align-items:center;gap:14px;
  border-bottom:3px solid var(--brand);
}
.topbar img.logo{height:28px;display:block}
.topbar .divider{width:1px;height:24px;background:#3a3a55}
.topbar .title{font-size:15px;font-weight:700;letter-spacing:.01em}
.topbar .brand-sub{font-size:11.5px;font-weight:500;color:var(--mut2);margin-left:6px;text-transform:lowercase;letter-spacing:.04em}
.topbar .sub{color:var(--mut2);font-size:12px}
.topbar .right{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--mut2);font-size:12px}
.topnav{display:flex;gap:4px;margin-left:24px}
.topnav a{color:var(--mut2);text-decoration:none;padding:6px 14px;border-radius:6px;font-size:13px;font-weight:500;transition:background .15s,color .15s}
.topnav a:hover{background:rgba(255,255,255,.06);color:#fff}
.topnav a.active{background:var(--brand);color:#fff}
.topbar .pill{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-size:11px;background:#0f0f1a;border:1px solid #3a3a55;padding:2px 8px;border-radius:4px;color:#cbd5e1}
.version-pill{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-size:10.5px;font-weight:600;color:#cbd5e1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);padding:2px 7px;border-radius:4px;letter-spacing:.02em;line-height:1.4;margin-left:8px}
.update-btn{display:inline-flex;align-items:center;gap:5px;background:rgba(34,197,94,.18);border:1px solid rgba(34,197,94,.5);color:#dcfce7;font:500 11.5px ui-sans-serif,sans-serif;padding:4px 10px;border-radius:6px;cursor:pointer;transition:background .15s}
.update-btn:hover{background:rgba(34,197,94,.32);color:#fff}
.update-btn:disabled{cursor:wait;opacity:.7}
.update-btn .update-icon{font-size:13px;line-height:1}
.update-btn.spin .update-icon{animation:update-spin .9s linear infinite}
@keyframes update-spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
.beszel-link{color:#ffedd5;text-decoration:none;font-size:11.5px;font-weight:500;padding:4px 10px;border-radius:6px;background:rgba(249,115,22,.15);border:1px solid rgba(249,115,22,.35);transition:background .15s}
.beszel-link:hover{background:rgba(249,115,22,.3);color:#fff}
.ri-pill{display:inline-flex;align-items:center;gap:7px;color:#fff;text-decoration:none;font-size:11.5px;padding:4px 10px;border-radius:6px;background:rgba(249,115,22,.22);border:1px solid rgba(249,115,22,.5);transition:background .15s;max-width:280px;overflow:hidden}
.ri-pill:hover{background:rgba(249,115,22,.36);color:#fff}
.ri-pill .ri-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ri-pill strong{font-weight:600}
.ri-dot{width:8px;height:8px;border-radius:50%;background:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.25);flex-shrink:0;animation:ri-pulse 1.2s ease-in-out infinite}
@keyframes ri-pulse{0%,100%{opacity:.5}50%{opacity:1}}
.topbar .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px rgba(22,163,74,.18)}

main{display:grid;grid-template-columns:360px 1fr;gap:18px;padding:18px 22px;max-width:1500px;margin:0 auto}
@media (max-width:960px){main{grid-template-columns:1fr}}

.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:18px;box-shadow:var(--shadow)}
.card h2{margin:0 0 14px;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);font-weight:600}

label{display:block;font-size:12px;color:#475569;margin:12px 0 4px;font-weight:500}
input[type=text],select{width:100%;padding:9px 11px;border:1px solid var(--bd);border-radius:6px;font-family:inherit;font-size:13px;background:#fff;transition:border-color .15s,box-shadow .15s}
input[type=text]:focus,select:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.12)}
input[type=text]::placeholder{color:#94a3b8}
select{font-weight:500;cursor:pointer}
.progress{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 14px;margin-bottom:10px;padding:10px 14px;background:#f8fafc;border:1px solid var(--bd);border-radius:8px}
@media (max-width:780px){.progress{grid-template-columns:repeat(2,1fr)}}
.prog-row{display:flex;align-items:center;gap:8px;font-size:13px;color:#64748b;line-height:1.4;transition:color .2s}
.prog-row.active{color:var(--fg)}
.prog-row.done{color:var(--ok)}
.prog-row.fail{color:var(--err)}
.prog-tick{display:inline-flex;width:18px;height:18px;border-radius:50%;background:#e2e8f0;color:#94a3b8;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;transition:background .2s,color .2s}
.prog-row.active .prog-tick{background:#ffedd5;color:var(--brand);content:''}
.prog-row.active .prog-tick::before{content:'·';animation:pulse 1s ease-in-out infinite}
.prog-row.done .prog-tick{background:#dcfce7;color:var(--ok)}
.prog-row.fail .prog-tick{background:#fee2e2;color:var(--err)}
.prog-name{font-weight:500;flex:1}
.prog-count{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#94a3b8}
.prog-row.done .prog-count,.prog-row.fail .prog-count{color:inherit}
@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
.sections{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin-top:6px}
.sections label{display:flex;align-items:center;gap:7px;margin:0;font-size:13px;color:var(--fg);font-weight:400;cursor:pointer;padding:5px 4px;border-radius:4px}
.sections label:hover{background:#f1f5f9}
.sections input[type=checkbox]{accent-color:var(--brand);width:14px;height:14px}

.btn{background:var(--brand);color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:14px;font-weight:600;letter-spacing:.01em;cursor:pointer;width:100%;margin-top:18px;transition:background .15s,transform .05s}
.btn:hover{background:var(--brand-h)}
.btn:active{transform:translateY(1px)}
.btn:disabled{background:#cbd5e1;color:#fff;cursor:not-allowed}

/* Mode tabs (test-case vs time-window) */
.mode-tabs{display:flex;gap:0;margin-top:6px;margin-bottom:10px;background:#f1f5f9;padding:3px;border-radius:7px;border:1px solid var(--bd)}
.mode-tab{flex:1;background:transparent;color:var(--mut);border:0;padding:7px 10px;font-size:12.5px;font-weight:600;cursor:pointer;border-radius:5px;transition:background .12s,color .12s}
.mode-tab:hover{color:var(--fg)}
.mode-tab.active{background:#fff;color:var(--brand);box-shadow:0 1px 3px rgba(15,23,42,.08)}
.mode-panel input[type=number]{width:100%;padding:8px 11px;border:1px solid var(--bd);border-radius:5px;font-size:13.5px;background:#fff}
.mode-panel input[type=number]:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.12)}

/* Preset chips for lookback duration */
.chip-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.chip{background:#fff;color:var(--fg);border:1px solid var(--bd);border-radius:14px;padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;transition:all .12s}
.chip:hover{border-color:var(--brand);color:var(--brand)}
.chip.active{background:var(--brand);color:#fff;border-color:var(--brand)}

.notice{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:9px 12px;border-radius:6px;font-size:12.5px;margin-bottom:10px;line-height:1.45}
.notice code{background:#fff;padding:1px 5px;border-radius:3px;font-size:11.5px;border:1px solid #fed7aa}

/* Console */
.log{
  background:#0f1117;color:#e2e8f0;
  border-radius:8px;padding:14px 16px;
  font:12.5px/1.6 ui-monospace,"JetBrains Mono","Fira Code",Consolas,monospace;
  height:560px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;
  border:1px solid #1f2937;
}
.log .ts{color:#64748b}
.log .ok{color:#4ade80}
.log .skip{color:#facc15}
.log .fail{color:#f87171}
.log .note{color:#60a5fa}

.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:500}
.badge.ok{background:#dcfce7;color:#166534}
.badge.skip{background:#fef3c7;color:#92400e}
.badge.fail{background:#fee2e2;color:#991b1b}
.badge.note{background:#dbeafe;color:#1e40af}
.badge.idle{background:#f1f5f9;color:#64748b}
.badge.run{background:#ffedd5;color:#9a3412}

.dl{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:13.5px;font-weight:600;margin-top:10px;transition:background .15s}
.dl:hover{background:var(--brand-h)}
.dl-secondary{display:inline-block;color:#475569;text-decoration:none;padding:9px 12px;font-size:13px;border-radius:6px;background:#f1f5f9;margin-left:8px}
.dl-secondary:hover{background:#e2e8f0;color:#1e293b}

.bundle-list{margin-top:8px;font-size:13px;display:flex;flex-direction:column;gap:0}
.bundle-list .item{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:9px 0;border-top:1px solid var(--bd)}
.bundle-list .item:first-child{border-top:0}
.bundle-list .tc{font-weight:600;color:#1c1c2e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bundle-list .meta{color:var(--mut);font-size:11.5px;grid-column:1 / -1}
.bundle-list .acts{display:flex;gap:4px;align-self:start}
.bundle-list a{color:#1e40af;text-decoration:none;font-weight:500;font-size:12px;padding:3px 10px;border-radius:4px;background:#eff6ff;border:1px solid #dbeafe;transition:background .12s}
.bundle-list a:hover{background:#dbeafe;text-decoration:none}
.bundle-list a.analysis-link{background:#fff7ed;border-color:#fed7aa;color:#9a3412}
.bundle-list a.analysis-link:hover{background:#fed7aa}

.log-disclosure{margin-top:14px;background:#f8fafc;border:1px solid var(--bd);border-radius:8px;overflow:hidden}
.log-disclosure summary{cursor:pointer;padding:9px 14px;font-size:13px;font-weight:600;color:#1c1c2e;user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center}
.log-disclosure summary::-webkit-details-marker{display:none}
.log-disclosure summary::before{content:'▶ ';color:#9ca3af;margin-right:6px;display:inline-block;transition:transform .15s}
.log-disclosure[open] summary::before{transform:rotate(90deg)}
.log-disclosure summary:hover{background:#f1f5f9}
#log-hint{color:var(--mut);font-weight:400;font-size:12px}
.log-disclosure[open] #log-hint{display:none}
.log-disclosure .log{margin:0;border-radius:0;border:0;border-top:1px solid var(--bd);height:480px}

/* ----- Pipeline (Collect → Analyze → Report) ----- */
.pipeline{display:flex;flex-direction:column;gap:0;margin-bottom:6px}
.step{
  border:1.5px solid var(--bd);border-radius:10px;background:#fff;
  padding:14px 16px;transition:border-color .25s,background .25s,box-shadow .25s;
}
.step-head{display:flex;align-items:center;gap:10px}
.step-num{
  display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;border-radius:50%;
  background:#e2e8f0;color:#64748b;font-weight:700;font-size:13px;
  flex-shrink:0;transition:background .25s,color .25s,box-shadow .25s;
}
.step-title{font-size:14px;font-weight:600;color:#1c1c2e;flex:1}
.step-state{
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;
  padding:3px 9px;border-radius:999px;background:#f1f5f9;color:#64748b;
}
.step-body{margin-top:12px}
.step-body .step-detail{font-size:12.5px;color:var(--mut);padding:8px 12px;background:#f8fafc;border:1px dashed var(--bd);border-radius:6px}
.step-result{font-size:13px}
.step-result .dim{color:var(--mut);font-style:italic}
.step-result a.dl{margin-top:0}
.analysis{
  margin:10px 0 0;padding:14px 18px;
  font:12.5px/1.55 ui-monospace,Consolas,monospace;
  background:#0f1117;color:#e2e8f0;white-space:pre-wrap;word-break:break-word;
  border-radius:6px;max-height:520px;overflow-y:auto;
}

/* Friendly analysis rows: one tick + area + comment per finding */
.analysis-rows{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.an-row{
  display:grid;grid-template-columns:28px 160px 1fr;gap:10px;
  align-items:center;padding:9px 12px;
  border:1px solid var(--bd);border-radius:8px;background:#fff;
  font-size:13px;line-height:1.45;
}
.an-row .an-icon{
  display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;border-radius:50%;
  font-size:13px;font-weight:700;flex-shrink:0;
}
.an-row .an-area{font-weight:600;color:#1c1c2e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.an-row .an-note{color:#475569;word-break:break-word}
.an-row[data-status="ok"]   {background:#f0fdf4;border-color:#bbf7d0}
.an-row[data-status="ok"]   .an-icon{background:#dcfce7;color:var(--ok)}
.an-row[data-status="warn"] {background:#fffbeb;border-color:#fde68a}
.an-row[data-status="warn"] .an-icon{background:#fef3c7;color:#b45309}
.an-row[data-status="fail"] {background:#fef2f2;border-color:#fecaca}
.an-row[data-status="fail"] .an-icon{background:#fee2e2;color:var(--err)}
.an-row[data-status="info"] {background:#eff6ff;border-color:#dbeafe}
.an-row[data-status="info"] .an-icon{background:#dbeafe;color:#1e40af}
@media (max-width:680px){
  .an-row{grid-template-columns:28px 1fr;grid-template-rows:auto auto}
  .an-row .an-note{grid-column:2 / 3}
}

.analysis-extra{
  margin-top:10px;padding:10px 14px;background:#f8fafc;border:1px solid var(--bd);
  border-radius:6px;font:12px/1.5 ui-monospace,Consolas,monospace;color:#475569;
  white-space:pre-wrap;
}
.analysis-raw-wrap{margin-top:10px;background:#f8fafc;border:1px solid var(--bd);border-radius:6px;overflow:hidden}
.analysis-raw-wrap summary{cursor:pointer;padding:7px 12px;font-size:12px;color:#475569;font-weight:500;user-select:none;list-style:none}
.analysis-raw-wrap summary::-webkit-details-marker{display:none}
.analysis-raw-wrap summary::before{content:'▶ ';color:#9ca3af;margin-right:6px;transition:transform .15s;display:inline-block}
.analysis-raw-wrap[open] summary::before{transform:rotate(90deg)}
.analysis-raw-wrap .analysis{margin:0;border-radius:0;border:0;border-top:1px solid var(--bd);max-height:360px}

/* Down-arrow connector between steps */
.step-arrow{
  display:flex;justify-content:center;align-items:center;
  height:28px;color:#cbd5e1;transition:color .25s;
}

/* State-based styling */
.step[data-state="active"]{border-color:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.10)}
.step[data-state="active"] .step-num{background:#ffedd5;color:var(--brand);box-shadow:0 0 0 4px rgba(249,115,22,.12)}
.step[data-state="active"] .step-state{background:#ffedd5;color:#9a3412}
.step[data-state="active"] .step-state::before{content:'● ';animation:pulse 1.2s ease-in-out infinite}

.step[data-state="done"]{border-color:#bbf7d0;background:#f0fdf4}
.step[data-state="done"] .step-num{background:#dcfce7;color:var(--ok);font-size:14px}
.step[data-state="done"] .step-state{background:#dcfce7;color:#166534}

.step[data-state="fail"]{border-color:#fecaca;background:#fef2f2}
.step[data-state="fail"] .step-num{background:#fee2e2;color:var(--err)}
.step[data-state="fail"] .step-state{background:#fee2e2;color:#991b1b}

/* Arrow follows the previous step's color */
.step[data-state="done"] + .step-arrow{color:var(--ok)}
.step[data-state="active"] + .step-arrow{color:var(--brand)}
.step[data-state="fail"] + .step-arrow{color:var(--err)}

small{color:var(--mut);font-weight:400}

/* --- Setup modal: quick host-IP editor for the selected profile --- */
.modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(3px);
  display:none;align-items:center;justify-content:center;z-index:200;padding:20px}
.modal-overlay.open{display:flex}
.modal{background:#fff;border-radius:14px;box-shadow:0 24px 64px rgba(15,23,42,.35);
  width:100%;max-width:460px;max-height:90vh;overflow:auto;animation:modal-in .16s ease}
@keyframes modal-in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
.modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:20px 22px 4px}
.modal-head h3{margin:0;font-size:16.5px;font-weight:700;color:#0f172a;letter-spacing:-.01em}
.modal-head .sub{font-size:12px;color:var(--mut);font-weight:500;margin-top:3px}
.modal-x{background:none;border:0;font-size:24px;line-height:1;color:var(--mut);cursor:pointer;
  padding:0 6px;border-radius:6px;transition:.12s}
.modal-x:hover{background:#f1f5f9;color:#0f172a}
.modal-body{padding:8px 22px 4px}
.setup-list{display:flex;flex-direction:column;gap:6px;margin:6px 0 4px}
.setup-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;
  border:1px solid var(--bd);border-radius:9px;cursor:pointer;background:#fff;transition:.12s}
.setup-row:hover{border-color:var(--brand)}
.setup-row.sel{border-color:var(--brand);background:#fff7ed;box-shadow:0 0 0 2px rgba(249,115,22,.14)}
.setup-row .nm{font-weight:600;font-size:13.5px;color:#0f172a}
.setup-row .sm{font-size:11px;color:var(--mut);font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;margin-top:2px}
.setup-row .chev{color:var(--brand);font-weight:700;font-size:13px;opacity:0;transition:.12s}
.setup-row.sel .chev{opacity:1}
.setup-edit{border-top:1px solid var(--bd);margin-top:10px;padding-top:4px}
.setup-edit .eh{font-size:11px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 2px}
.mfld{margin:13px 0}
.mfld label{display:block;font-size:10.5px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
.mfld label .lh{font-weight:400;color:var(--mut);font-size:11px}
.mfld input{width:100%;padding:9px 12px;border:1px solid var(--bd);border-radius:8px;font-size:13.5px;
  font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;transition:.12s}
.mfld input:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.12)}
.mfld input::placeholder{color:#cbd5e1;font-family:ui-sans-serif,sans-serif}
.modal-foot{display:flex;align-items:center;gap:10px;padding:14px 22px 18px;margin-top:8px;border-top:1px solid var(--bd)}
.modal-foot .adv{margin-right:auto;font-size:12px;color:var(--mut);text-decoration:none;font-weight:500}
.modal-foot .adv:hover{color:var(--brand)}
.modal-toast{font-size:12.5px;font-weight:600}
.btn-ghost{background:#fff;border:1px solid var(--bd);color:#334155;border-radius:8px;padding:8px 16px;
  font-size:13.5px;font-weight:600;cursor:pointer;transition:.12s}
.btn-ghost:hover{background:#f8fafc}
.btn-primary{background:var(--brand);border:0;color:#fff;border-radius:8px;padding:8px 18px;
  font-size:13.5px;font-weight:600;cursor:pointer;transition:background .15s}
.btn-primary:hover{background:var(--brand-h)}
.btn-primary:disabled{background:#cbd5e1;cursor:not-allowed}

/* --- Systems manager (Add System) --- */
.modal.wide{max-width:620px}
.sys-toolbar{display:flex;align-items:center;gap:10px;margin:6px 0 12px}
.sys-toolbar .grow{margin-left:auto;display:flex;align-items:center;gap:8px}
.sys-toolbar label{font-size:11px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
.sys-toolbar select{font:13px ui-sans-serif,sans-serif;padding:7px 10px;border:1px solid var(--bd);border-radius:8px;background:#fff;min-width:150px}
.btn-add{display:inline-flex;align-items:center;gap:6px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;
  border-radius:9px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;transition:.12s}
.btn-add:hover{background:#dbeafe}
.sys-card{border:1px solid var(--bd);border-radius:11px;padding:12px 14px;margin-bottom:9px;background:#fff;transition:.12s}
.sys-card:hover{border-color:var(--brand);box-shadow:0 2px 10px rgba(15,23,42,.06)}
.sys-card .top{display:flex;align-items:center;gap:9px}
.sys-card .idx{width:22px;height:22px;border-radius:6px;background:#eef2f7;color:#475569;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.sys-card .nm{font-weight:700;font-size:14px;color:#0f172a}
.sys-card .acts{margin-left:auto;display:flex;gap:6px}
.sys-card .acts button{border:1px solid var(--bd);background:#fff;border-radius:7px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;color:#334155;transition:.12s}
.sys-card .acts button:hover{border-color:var(--brand);color:var(--brand)}
.sys-card .acts button.del:hover{border-color:#dc2626;color:#dc2626}
.sys-card .ips{display:flex;flex-wrap:wrap;gap:10px 18px;margin-top:9px}
.sys-card .ip{font-size:11.5px}
.sys-card .ip b{display:block;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.04em;font-size:9.5px;margin-bottom:1px}
.sys-card .ip span{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;color:#0f172a}
.sys-empty{color:var(--mut);font-size:13px;text-align:center;padding:22px 0}
/* form grid */
.mrow{display:flex;gap:14px}
.mrow .mcol{flex:1;min-width:0}
.opt-div{display:flex;align-items:center;gap:10px;margin:16px 0 4px;color:var(--mut);font-size:10.5px;font-weight:700;letter-spacing:.06em}
.opt-div::before,.opt-div::after{content:'';flex:1;height:1px;background:var(--bd)}
</style>
</head>
<body>
<div class="modal-overlay" id="setup-modal" onclick="if(event.target===this)closeSetup()">
  <div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <div class="modal-head">
      <div>
        <h3 id="setup-title">Systems</h3>
        <div class="sub" id="setup-sub">Manage your collection targets</div>
      </div>
      <button type="button" class="modal-x" onclick="closeSetup()" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body" id="setup-body"></div>
    <div class="modal-foot" id="setup-foot"></div>
  </div>
</div>
<header class="topbar">
  <img class="logo" src="/static/logo.svg" alt="Simnovus">
  <div class="divider"></div>
  <span class="title">OneClick</span>{% if version %}<span class="version-pill" title="OneClick UI version — bumps when you click Update and pick up a new build">v{{ version }}</span>{% endif %}<span class="brand-sub">collector</span>
  <nav class="topnav">
    <a href="/" class="active">Collector</a>
    <a href="/logs">Logs</a>
    <a href="#" onclick="openSetup(event)">Setup</a>
  </nav>
  <div class="right">
    <a class="ri-pill" id="run-indicator" href="/logs" style="display:none" title="A collection is in progress — click to view live log">
      <span class="ri-dot"></span>
      <span class="ri-text">Running: <strong id="ri-tc">…</strong></span>
    </a>
    <button type="button" class="update-btn" id="update-btn" onclick="runUpdate()"
            title="Fetch the latest OneClick from GitHub and re-install. Service restarts automatically.">
      <span class="update-icon" id="update-icon">⤓</span>
      <span class="update-label" id="update-label">Update</span>
    </button>
    {% if beszel_url %}<a class="beszel-link" href="{{ beszel_url }}" target="_blank" rel="noopener" title="Open Beszel hub">Beszel ↗</a>{% endif %}
    <span class="dot" title="online"></span>
    <span>{{ host_label }}</span>
    <span class="pill">collect_perf_data.sh</span>
  </div>
</header>
<main>
  <section class="card">
    <h2>Run a collection</h2>
    <form id="form" onsubmit="return false">
      <label for="_profile">System profile <small>(cached in this browser)</small></label>
      <select id="_profile" name="_profile" onchange="onProfileChange()">
        {% for name, prof in profiles.items() %}
          <option value="{{ name }}" {% if name == default_profile %}selected{% endif %}>{{ prof.label }}</option>
        {% endfor %}
      </select>

      <label>Mode <small>(what time window to collect)</small></label>
      <div class="mode-tabs" role="tablist">
        <button type="button" class="mode-tab active" data-mode="testcase" onclick="setMode('testcase')">By test case</button>
        <button type="button" class="mode-tab" data-mode="lookback" onclick="setMode('lookback')">Last N minutes</button>
      </div>

      <div id="mode-testcase" class="mode-panel">
        <label for="test_case_name">Test case name <small>(blank = LAST_RUN; type or pick from list)</small></label>
        <input type="text" id="test_case_name" name="test_case_name" placeholder="LAST_RUN" list="tc-list" autocomplete="off">
        <datalist id="tc-list"></datalist>
        <label for="iteration_id">Iteration ID <small>(optional override)</small></label>
        <input type="text" id="iteration_id" name="iteration_id" placeholder="019e6f99-...">
      </div>

      <div id="mode-lookback" class="mode-panel" style="display:none">
        <label>Window <small>(ad-hoc — no testcase, just the last N minutes)</small></label>
        <div class="chip-row">
          <button type="button" class="chip" data-mins="15" onclick="setLookback(15)">15 min</button>
          <button type="button" class="chip" data-mins="30" onclick="setLookback(30)">30 min</button>
          <button type="button" class="chip active" data-mins="60" onclick="setLookback(60)">1 hr</button>
          <button type="button" class="chip" data-mins="120" onclick="setLookback(120)">2 hr</button>
          <button type="button" class="chip" data-mins="240" onclick="setLookback(240)">4 hr</button>
        </div>
        <label for="lookback_minutes" style="margin-top:10px">Custom (minutes)</label>
        <input type="number" id="lookback_minutes" name="lookback_minutes" min="1" max="1440" value="60" oninput="onLookbackInput()">
        <small style="display:block;margin-top:4px;color:var(--mut)">REST per-iteration stats + GUI screenshots are skipped in this mode (no testcase to anchor against). Container logs, iperf, heat CSVs, and system snapshots are windowed to the selected range.</small>
      </div>
      <label>Sections <small>(auto-filled from profile; uncheck to skip ad-hoc)</small></label>
      <div class="sections">
        <label data-host="UE_HOST">          <input type="checkbox" name="collect_ue"        > UE</label>
        <label data-host="SIMNOVATOR_HOST">  <input type="checkbox" name="collect_simnovator"> Simnovator</label>
        <label data-host="CALLBOX_HOST">     <input type="checkbox" name="collect_callbox"   > Callbox</label>
        <label data-host="APP_SERVER_HOST">  <input type="checkbox" name="collect_app_server"> App server</label>
        <label data-host="SIMNOVATOR_HOST">  <input type="checkbox" name="collect_rest_api"  > REST API</label>
        <label data-host="UE_HOST">          <input type="checkbox" name="collect_iperf"     > iperf logs</label>
        <label>                              <input type="checkbox" name="collect_analyze" checked> Analyze (summary report)</label>
      </div>
      <button id="run" class="btn" type="button">Run collection</button>
    </form>
    <div id="bundles" style="margin-top:22px">
      <h2 style="margin-bottom:6px">Recent bundles</h2>
      <div class="bundle-list" id="bundle-list"><small>loading…</small></div>
    </div>
  </section>

  <section class="card">
    <h2>Pipeline</h2>
    <div id="status" class="row" style="margin-bottom:14px"><span class="badge idle">idle</span></div>

    <div class="pipeline">
      <div class="step" data-step="collect" data-state="pending">
        <div class="step-head">
          <span class="step-num">1</span>
          <span class="step-title">Collect</span>
          <span class="step-state">pending</span>
        </div>
        <div class="step-body">
          <div id="progress" class="progress">
            <div class="prog-row" data-section="ue">          <span class="prog-tick">·</span><span class="prog-name">UE</span>          <span class="prog-count"></span></div>
            <div class="prog-row" data-section="simnovator">  <span class="prog-tick">·</span><span class="prog-name">Simnovator</span>  <span class="prog-count"></span></div>
            <div class="prog-row" data-section="callbox">     <span class="prog-tick">·</span><span class="prog-name">Callbox</span>     <span class="prog-count"></span></div>
            <div class="prog-row" data-section="app-server">  <span class="prog-tick">·</span><span class="prog-name">App server</span>  <span class="prog-count"></span></div>
            <div class="prog-row" data-section="rest-api">    <span class="prog-tick">·</span><span class="prog-name">REST API</span>    <span class="prog-count"></span></div>
            <div class="prog-row" data-section="heat">        <span class="prog-tick">·</span><span class="prog-name">Heat (SDR)</span><span class="prog-count"></span></div>
            <div class="prog-row" data-section="iperf">       <span class="prog-tick">·</span><span class="prog-name">iperf</span>       <span class="prog-count"></span></div>
          </div>
        </div>
      </div>

      <div class="step-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 4v14m0 0l-5-5m5 5l5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>

      <div class="step" data-step="analyze" data-state="pending">
        <div class="step-head">
          <span class="step-num">2</span>
          <span class="step-title">Analyze</span>
          <span class="step-state">pending</span>
        </div>
        <div class="step-body">
          <div class="step-detail" id="analyze-detail">Waiting for collection to finish…</div>
        </div>
      </div>

      <div class="step-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 4v14m0 0l-5-5m5 5l5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>

      <div class="step" data-step="report" data-state="pending">
        <div class="step-head">
          <span class="step-num">3</span>
          <span class="step-title">Report</span>
          <span class="step-state">pending</span>
        </div>
        <div class="step-body">
          <div id="result" class="step-result"><em class="dim">Report appears here when analysis is done.</em></div>
          <div id="analysis-rows" class="analysis-rows" style="display:none"></div>
          <div id="analysis-extra" class="analysis-extra" style="display:none"></div>
          <details id="analysis-raw-wrap" class="analysis-raw-wrap" style="display:none">
            <summary>Raw analysis text</summary>
            <pre class="analysis" id="analysis-text">loading…</pre>
          </details>
        </div>
      </div>
    </div>

    <details class="log-disclosure" id="log-wrap">
      <summary>Live log <span id="log-hint">(click to expand)</span></summary>
      <pre class="log" id="log"><span class="ts"># waiting for a run…</span></pre>
    </details>
  </section>
</main>
<script>
const $ = s => document.querySelector(s);
const logEl = $('#log'), statusEl = $('#status'), resultEl = $('#result'), btn = $('#run');

// Profile data injected from server. Used to pre-fill the section checkboxes
// (blank IP for a host -> related sections default off).
const PROFILE_DEFAULTS = {{ profile_defaults|tojson }};
const HOST_FIELDS = {{ host_fields|tojson }};   // [ [KEY, label, placeholder], ... ]
const LS_KEY = 'perfqa.selected_profile';

// --- Systems manager: list systems (profiles) as cards; Add/Edit via an
//     Add-System form (Simnovator IP+port, UESIM/ORUSIM, Appserver, DU, CCS);
//     Jump-to dropdown; delete. Persists to profiles.json via the REST API.
//     Fixed creds/paths are preserved (edit) or seeded from an existing
//     system (add). Advanced page still holds creds/paths. ---
function _slug(s){
  return (s||'').trim().replace(/[^A-Za-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'')
           .replace(/^([^A-Za-z])/,'s$1').slice(0,64) || 'system';
}
function _labelFor(name){
  const o = $('#_profile').querySelector('option[value="'+CSS.escape(name)+'"]');
  return o ? o.textContent.trim() : name;
}
// Add-System form fields: [key, label, placeholder]
const SYS_FORM = [
  ['SIMNOVATOR_HOST','Simnovator IP','10.237.93.90'],
  ['SIMNOVATOR_PORT','Simnovator port (blank = auto)','3002 for v3.9 · 80 for v4.x'],
  ['UE_HOST','UESIM / ORUSIM IP','10.237.93.0'],
  ['APP_SERVER_HOST','Appserver IP','10.237.93.x'],
];
const SYS_FORM_OPT = [
  ['DU_HOST','DU IP','10.237.93.x'],
  ['CCS_HOST','CCS IP','10.237.93.x'],
];

function openSetup(ev){ if (ev) ev.preventDefault(); renderSystems(); $('#setup-modal').classList.add('open'); }
function closeSetup(){ $('#setup-modal').classList.remove('open'); }

function renderSystems(){
  $('#setup-title').textContent = 'Systems';
  $('#setup-sub').textContent = 'Manage your collection targets';
  const opts = [...$('#_profile').options];
  const jump = '<div class="grow"><label>Jump to</label>'
    + '<select onchange="if(this.value)editSystem(this.value)"><option value="">— Select System —</option>'
    + opts.map(o => `<option value="${o.value}">${o.textContent.trim()}</option>`).join('')
    + '</select></div>';
  const toolbar = '<div class="sys-toolbar"><button class="btn-add" onclick="addSystem()">+ Add System</button>' + jump + '</div>';
  const cards = opts.map((o, i) => {
    const name = o.value, label = o.textContent.trim(), d = PROFILE_DEFAULTS[name] || {};
    const ip = (lbl, v) => v ? `<div class="ip"><b>${lbl}</b><span>${v}</span></div>` : '';
    const sim = d.SIMNOVATOR_HOST ? (d.SIMNOVATOR_HOST + (d.SIMNOVATOR_PORT ? (':'+d.SIMNOVATOR_PORT) : '')) : '';
    const ips = [ip('Simnovator', sim), ip('UESIM / ORUSIM', d.UE_HOST), ip('Appserver', d.APP_SERVER_HOST),
                 ip('DU', d.DU_HOST), ip('CCS', d.CCS_HOST)].join('')
                 || '<div class="ip" style="color:var(--mut)">no hosts set</div>';
    const lblEsc = label.replace(/'/g, "\\'");
    return `<div class="sys-card"><div class="top"><span class="idx">${i+1}</span><span class="nm">${label}</span>`
      + `<span class="acts"><button onclick="editSystem('${name}')">Edit</button>`
      + `<button class="del" onclick="deleteSystem('${name}','${lblEsc}')">Delete</button></span></div>`
      + `<div class="ips">${ips}</div></div>`;
  }).join('') || '<div class="sys-empty">No systems yet — click <b>+ Add System</b>.</div>';
  $('#setup-body').innerHTML = toolbar + cards;
  $('#setup-foot').innerHTML = '<a class="adv" href="/setup" title="Credentials, paths, advanced fields">Advanced ↗</a>'
    + '<span class="modal-toast" id="setup-toast"></span>'
    + '<button class="btn-ghost" onclick="closeSetup()">Close</button>';
}

function _fld(k, lbl, ph, val){
  const v = (val || '').replace(/"/g, '&quot;');
  return `<div class="mfld"><label for="mf_${k}">${lbl}</label>`
    + `<input id="mf_${k}" data-key="${k}" value="${v}" placeholder="${ph}" autocomplete="off" spellcheck="false"></div>`;
}
function addSystem(){ renderFormView(null); }
function editSystem(name){ renderFormView(name); }
function renderFormView(name){
  const isNew = !name;
  const d = isNew ? {} : (PROFILE_DEFAULTS[name] || {});
  const label = isNew ? '' : _labelFor(name);
  $('#setup-title').textContent = isNew ? '+ Add System' : 'Edit System';
  $('#setup-sub').textContent = isNew ? 'New collection target' : name;
  const nameFld = `<div class="mfld"><label for="mf_name">System name</label>`
    + `<input id="mf_name" value="${label.replace(/"/g,'&quot;')}" placeholder="Lab-Node-01" ${isNew?'':'readonly'} autocomplete="off"></div>`;
  const row2 = `<div class="mrow"><div class="mcol">${_fld(...SYS_FORM[0], d.SIMNOVATOR_HOST)}</div><div class="mcol">${_fld(...SYS_FORM[1], d.SIMNOVATOR_PORT)}</div></div>`;
  const row3 = `<div class="mrow"><div class="mcol">${_fld(...SYS_FORM[2], d.UE_HOST)}</div><div class="mcol"></div></div>`;
  const row4 = _fld(...SYS_FORM[3], d.APP_SERVER_HOST);
  const opt  = `<div class="opt-div">OPTIONAL</div><div class="mrow"><div class="mcol">${_fld(...SYS_FORM_OPT[0], d.DU_HOST)}</div><div class="mcol">${_fld(...SYS_FORM_OPT[1], d.CCS_HOST)}</div></div>`;
  $('#setup-body').innerHTML = nameFld + row2 + row3 + row4 + opt;
  const delBtn = isNew ? '' : `<button class="btn-ghost" style="margin-right:auto;color:#dc2626;border-color:#fecaca" onclick="deleteSystem('${name}','${label.replace(/'/g,"\\'")}')">Delete</button>`;
  $('#setup-foot').innerHTML = delBtn
    + '<span class="modal-toast" id="setup-toast"></span>'
    + '<button class="btn-ghost" onclick="renderSystems()">Cancel</button>'
    + `<button class="btn-primary" id="setup-save" onclick="saveSystem(${isNew?'null':"'"+name+"'"})">Save System</button>`;
  const f = $('#mf_name'); if (f) f.focus();
}

async function saveSystem(existing){
  const save = $('#setup-save'), toast = $('#setup-toast');
  const nm = ($('#mf_name').value || '').trim();
  if (!nm){ toast.style.color='#dc2626'; toast.textContent='System name required'; return; }
  const id = existing || _slug(nm);
  if (!existing && PROFILE_DEFAULTS[id] !== undefined){
    toast.style.color='#dc2626'; toast.textContent='A system named "'+nm+'" already exists'; return;
  }
  save.disabled = true; toast.style.color='var(--mut)'; toast.textContent='Saving…';
  const ips = {}; document.querySelectorAll('#setup-body input[data-key]').forEach(i => ips[i.dataset.key] = i.value.trim());
  try {
    let cur = { label: nm, defaults: {}, fixed: {} };
    if (existing){
      cur = await (await fetch('/api/profiles/'+encodeURIComponent(existing))).json();
    } else {
      // New system: seed fixed creds/paths from the first existing system.
      const tmpl = ([...$('#_profile').options][0] || {}).value;
      if (tmpl){ const t = await (await fetch('/api/profiles/'+encodeURIComponent(tmpl))).json(); cur.fixed = t.fixed || {}; }
    }
    const body = { label: nm, fixed: cur.fixed || {}, defaults: { ...(cur.defaults || {}), ...ips } };
    const r = await fetch('/api/profiles/'+encodeURIComponent(id), {
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.message || 'save failed');
    PROFILE_DEFAULTS[id] = body.defaults;
    let opt = $('#_profile').querySelector('option[value="'+CSS.escape(id)+'"]');
    if (!opt){ opt = document.createElement('option'); opt.value = id; $('#_profile').appendChild(opt); }
    opt.textContent = nm;
    $('#_profile').value = id; onProfileChange();
    toast.style.color='#16a34a'; toast.textContent='Saved ✓';
    setTimeout(renderSystems, 600);
  } catch (e){ toast.style.color='#dc2626'; toast.textContent='Error: '+e.message; }
  finally { save.disabled = false; }
}

async function deleteSystem(name, label){
  if (!confirm('Delete system "'+(label||name)+'"? This removes its saved IPs.')) return;
  try {
    const r = await fetch('/api/profiles/'+encodeURIComponent(name), { method:'DELETE' });
    const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.message || 'delete failed');
    delete PROFILE_DEFAULTS[name];
    const opt = $('#_profile').querySelector('option[value="'+CSS.escape(name)+'"]'); if (opt) opt.remove();
    if ($('#_profile').value === name){ $('#_profile').selectedIndex = 0; onProfileChange(); }
    renderSystems();
  } catch (e){ alert('Delete failed: '+e.message); }
}
// Esc closes the modal
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSetup(); });

function onProfileChange(){
  const sel = $('#_profile');
  const name = sel.value;
  localStorage.setItem(LS_KEY, name);
  const defs = PROFILE_DEFAULTS[name] || {};
  // Auto-tick the section checkboxes whose host is configured under this profile.
  document.querySelectorAll('.sections label[data-host]').forEach(lab => {
    const k = lab.dataset.host;
    const cb = lab.querySelector('input[type=checkbox]');
    cb.checked = !!(defs[k] && defs[k].trim());
  });
  refreshTestcaseDatalist(name);
}

// Populate the <datalist> with testcase names from the selected profile's
// Simnovator. Async + non-blocking — if the Simnovator is unreachable the
// user can still type a name manually.
async function refreshTestcaseDatalist(profileName){
  const dl = document.getElementById('tc-list');
  if (!dl) return;
  dl.innerHTML = '<option value="LAST_RUN">';
  try {
    const r = await fetch('/api/testcases?profile=' + encodeURIComponent(profileName));
    const j = await r.json();
    for (const name of (j.items || [])) {
      const opt = document.createElement('option');
      opt.value = name;
      dl.appendChild(opt);
    }
  } catch (_) { /* ignore — datalist stays empty + free-text still works */ }
}

// On first load, restore the user's previous profile choice (defaults to QA).
(function initProfile(){
  const cached = localStorage.getItem(LS_KEY);
  const sel = $('#_profile');
  if (cached && [...sel.options].some(o => o.value === cached)) sel.value = cached;
  onProfileChange();
})();

// ----- Mode toggle (test case vs lookback window) -------------------------
// Disabled inputs are NOT included in FormData, so backend gets a clean view
// of which mode the user picked — no need for an extra "_mode" hidden field.
function setMode(mode){
  document.querySelectorAll('.mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.mode === mode));
  const tcPanel = document.getElementById('mode-testcase');
  const lbPanel = document.getElementById('mode-lookback');
  const isLookback = mode === 'lookback';
  tcPanel.style.display = isLookback ? 'none' : '';
  lbPanel.style.display = isLookback ? '' : 'none';
  // Toggle disabled so only the active mode's fields post.
  document.getElementById('test_case_name').disabled = isLookback;
  document.getElementById('iteration_id').disabled   = isLookback;
  document.getElementById('lookback_minutes').disabled = !isLookback;
  localStorage.setItem('perfqa.mode', mode);
}
function setLookback(mins){
  document.querySelectorAll('.chip').forEach(c =>
    c.classList.toggle('active', String(c.dataset.mins) === String(mins)));
  document.getElementById('lookback_minutes').value = mins;
}
function onLookbackInput(){
  // User typed a custom value — clear the active chip unless it exactly matches.
  const v = document.getElementById('lookback_minutes').value;
  document.querySelectorAll('.chip').forEach(c =>
    c.classList.toggle('active', String(c.dataset.mins) === String(v)));
}
(function initMode(){
  const cached = localStorage.getItem('perfqa.mode') || 'testcase';
  setMode(cached);
})();

// Map of label-prefix => UI section id. The script's mark() lines look like
// "COLLECTED  ue: ..." or "COLLECTED  simnovator: ..." — we match the second
// token to bucket the line into a section row in the Progress panel.
const SECTION_PREFIXES = {
  ue: 'ue', system: 'ue', config: 'ue', cpu: 'ue', net: 'ue', logs: 'ue',
  'uesim': 'ue', 'workload': 'ue',
  simnovator: 'simnovator',
  callbox: 'callbox',
  'app-server': 'app-server',
  'rest-api': 'rest-api',
  heat: 'heat',
  iperf: 'iperf',
};

function progressReset(){
  document.querySelectorAll('.prog-row').forEach(r => {
    r.classList.remove('active', 'done', 'fail');
    r.dataset.ok = '0';
    r.dataset.fail = '0';
    r.querySelector('.prog-count').textContent = '';
    r.querySelector('.prog-tick').textContent = '·';
  });
}
function progressBump(line){
  // Format: "COLLECTED  <prefix>: <rest>" / "FAILED ..." / "SKIPPED ..." / "NOTE ..."
  const m = line.match(/^(COLLECTED|SKIPPED|FAILED|NOTE)\s+([a-z-]+):/i);
  if (!m) return;
  const status = m[1].toUpperCase();
  const prefix = m[2].toLowerCase();
  const sec = SECTION_PREFIXES[prefix];
  if (!sec) return;
  const row = document.querySelector(`.prog-row[data-section="${sec}"]`);
  if (!row) return;
  const ok = (+(row.dataset.ok||0)) + (status === 'COLLECTED' ? 1 : 0);
  const fail = (+(row.dataset.fail||0)) + (status === 'FAILED' ? 1 : 0);
  row.dataset.ok = ok;
  row.dataset.fail = fail;
  row.classList.add('active');
  row.querySelector('.prog-count').textContent =
    fail ? `${ok} ok · ${fail} fail` : (ok ? `${ok} ok` : '');
}
function progressFinalize(counts){
  // Mark each row as done (or fail if any failures fell in its bucket).
  document.querySelectorAll('.prog-row').forEach(r => {
    if (!r.classList.contains('active')) return;  // section had no items
    r.classList.remove('active');
    if ((+r.dataset.fail||0) > 0) {
      r.classList.add('fail');
      r.querySelector('.prog-tick').textContent = '✕';
    } else {
      r.classList.add('done');
      r.querySelector('.prog-tick').textContent = '✓';
    }
  });
}

function appendLog(line){
  const span = document.createElement('span');
  // Colorize known markers
  if (/^COLLECTED/.test(line))      span.className = 'ok';
  else if (/^SKIPPED/.test(line))   span.className = 'skip';
  else if (/^FAILED/.test(line))    span.className = 'fail';
  else if (/^NOTE/.test(line))      span.className = 'note';
  else if (/^\[\d\d:\d\d:\d\d\]/.test(line)) span.className = 'ts';
  span.textContent = line + '\n';
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
  // Update the Progress panel as marks stream in.
  progressBump(line);
  // Drive step transitions off the collector's section banners. The bash
  // script emits "[HH:MM:SS] --- analysis ---" when it moves from data-pull
  // into the analyzer pass; that's the cue to flip step 1 → done, 2 → active.
  if (/---\s*analy(s|z)is\s*---/i.test(line)) {
    progressFinalize();
    setStepState('collect', 'done');
    setStepState('analyze', 'active', 'Analyzing bundle (heat, CPU, containers, logs)…');
  }
}

function setStatus(html){ statusEl.innerHTML = html; }

// ---- Pipeline step state machine ----
// Each .step has data-state in {pending, active, done, fail}. Helper sets the
// state, updates the visible state-chip text, and swaps the numbered badge
// for a check / cross when done/fail.
const STEP_LABELS = { collect:'1', analyze:'2', report:'3' };
function setStepState(stepName, state, detailText){
  const step = document.querySelector(`.step[data-step="${stepName}"]`);
  if (!step) return;
  step.dataset.state = state;
  const chip = step.querySelector('.step-state');
  if (chip) chip.textContent = state;
  const num = step.querySelector('.step-num');
  if (num) {
    if (state === 'done')      num.textContent = '✓';
    else if (state === 'fail') num.textContent = '✕';
    else                       num.textContent = STEP_LABELS[stepName] || '';
  }
  if (detailText !== undefined) {
    const detail = step.querySelector('.step-detail');
    if (detail) detail.textContent = detailText;
  }
}
function resetPipeline(){
  for (const name of ['collect','analyze','report']) setStepState(name, 'pending');
  const detail = document.getElementById('analyze-detail');
  if (detail) detail.textContent = 'Waiting for collection to finish…';
  resultEl.innerHTML = '<em class="dim">Report appears here when analysis is done.</em>';
  const rows = document.getElementById('analysis-rows');
  if (rows) { rows.style.display = 'none'; rows.innerHTML = ''; }
  const extra = document.getElementById('analysis-extra');
  if (extra) { extra.style.display = 'none'; extra.textContent = ''; }
  const rawWrap = document.getElementById('analysis-raw-wrap');
  if (rawWrap) { rawWrap.style.display = 'none'; rawWrap.open = false; }
  const pre = document.getElementById('analysis-text');
  if (pre) pre.textContent = 'loading…';
}

// Parse "<testcase>_diagnostics_YYYYMMDD_HHMMSS.zip" into pretty parts.
function parseBundleName(name){
  const m = name.match(/^(.+)_diagnostics_(\d{8})_(\d{6})\.(zip|tar\.gz)$/);
  if (!m) return { tc: name, when: '' };
  const tc = m[1];
  const d = m[2], t = m[3];
  const date = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${t.slice(0,2)}:${t.slice(2,4)}`;
  return { tc, when: date };
}

async function loadBundles(){
  try {
    const r = await fetch('/bundles');
    const items = await r.json();
    const el = $('#bundle-list');
    if (!items.length) { el.innerHTML = '<small>none yet</small>'; return; }
    el.innerHTML = items.map(i => {
      const mb = (i.size/1048576).toFixed(2);
      const { tc, when } = parseBundleName(i.name);
      return `<div class="item">
        <div>
          <div class="tc" title="${i.name}">${tc}</div>
          <div class="meta">${when || new Date(i.mtime*1000).toLocaleString()} · ${mb} MB</div>
        </div>
        <div class="acts">
          <a href="/bundles/${i.name}" download>↓ zip</a>
          <a href="/bundles/${i.name}/analysis" target="_blank" class="analysis-link">analysis</a>
          <a href="/logs#${encodeURIComponent(i.name)}/system" class="analysis-link" title="View SYSTEM.md">system</a>
        </div>
      </div>`;
    }).join('');
  } catch (e) { /* ignore */ }
}
loadBundles();

// ---- Analysis parsing -----------------------------------------------------
// ANALYSIS.md format (from analyze_bundle.py):
//   ============================================
//     Analysis summary
//   ============================================
//     [STATUS]  Area name        one-line comment
//     [STATUS]  Heat [callbox]   peak SDR-FPGA=50°C · RFIC=55°C · ...
//     ...
//
//   Top error-rate containers...
//     · simnovator-test-processor: 7372 err
//
//   Thresholds: ...
//
// We pull the "[STATUS]  Area  comment" rows into a friendly list and shove
// everything after the summary into a "details" pane.
const STATUS_ICON = { ok:'✓', warn:'!', fail:'✕', info:'i' };
const FINDING_RE = /^\s*\[\s*(OK|WARN|FAIL|INFO)\s*\]\s+(\S.*?)\s{2,}(.+?)\s*$/i;

function parseAnalysis(text){
  const rows = [];
  const extras = [];
  for (const raw of text.split('\n')){
    const line = raw.replace(/\r$/, '');
    if (/^\s*=+\s*$/.test(line))                   continue;   // ===== heading separators
    if (/^\s*Analysis summary\s*$/i.test(line))    continue;   // title
    const m = line.match(FINDING_RE);
    if (m) {
      rows.push({ status: m[1].toLowerCase(), area: m[2].trim(), note: m[3].trim() });
      continue;
    }
    // Anything not a finding + not a heading goes into extras (top-error
    // containers, thresholds, etc.). Drop leading blank lines so the box
    // doesn't open with whitespace.
    if (line.trim() || extras.length) extras.push(line);
  }
  while (extras.length && !extras[extras.length-1].trim()) extras.pop();
  return { rows, extras: extras.join('\n') };
}

function renderAnalysis(text){
  const rowsEl   = document.getElementById('analysis-rows');
  const extraEl  = document.getElementById('analysis-extra');
  const rawWrap  = document.getElementById('analysis-raw-wrap');
  const rawPre   = document.getElementById('analysis-text');

  rawPre.textContent = text;
  rawWrap.style.display = 'block';

  const { rows, extras } = parseAnalysis(text);
  if (!rows.length) {
    // Couldn't parse — fall back to just showing the raw text expanded.
    rowsEl.style.display = 'none';
    extraEl.style.display = 'none';
    rawWrap.open = true;
    return;
  }
  rowsEl.innerHTML = rows.map(r => {
    const icon = STATUS_ICON[r.status] || '?';
    return `<div class="an-row" data-status="${r.status}">
      <span class="an-icon" title="${r.status.toUpperCase()}">${icon}</span>
      <span class="an-area" title="${r.area}">${r.area}</span>
      <span class="an-note">${r.note}</span>
    </div>`;
  }).join('');
  rowsEl.style.display = 'flex';
  if (extras) {
    extraEl.textContent = extras;
    extraEl.style.display = 'block';
  } else {
    extraEl.style.display = 'none';
  }
}

// Fetch ANALYSIS.md for the bundle and render it inline in step 3.
async function showAnalysis(bundleName){
  const rowsEl = document.getElementById('analysis-rows');
  if (!rowsEl) return;
  // Visual loading hint while the fetch is in flight.
  rowsEl.innerHTML = '<div class="an-row" data-status="info"><span class="an-icon">…</span><span class="an-area">Loading</span><span class="an-note">Fetching ANALYSIS.md…</span></div>';
  rowsEl.style.display = 'flex';
  try {
    const r = await fetch('/bundles/' + encodeURIComponent(bundleName) + '/analysis');
    const text = await r.text();
    renderAnalysis(text);
  } catch (e) {
    rowsEl.innerHTML = '<div class="an-row" data-status="fail"><span class="an-icon">✕</span><span class="an-area">Error</span><span class="an-note">(failed to load analysis)</span></div>';
  }
}

async function runHandler(e){
  e?.preventDefault?.();
  if (btn.disabled) return;          // already running
  btn.disabled = true;
  logEl.innerHTML = '';
  progressReset();
  resetPipeline();
  setStepState('collect', 'active', '');
  // Open the log disclosure while a run is in flight so the user sees stream.
  document.getElementById('log-wrap').open = true;
  setStatus('<span class="badge run">starting…</span>');

  const fd = new FormData($('#form'));
  const r = await fetch('/run', { method: 'POST', body: fd });
  if (!r.ok) {
    const err = await r.json().catch(() => ({error:'unknown'}));
    setStatus(`<span class="badge fail">error: ${err.error}</span>`);
    setStepState('collect', 'fail');
    btn.disabled = false; return;
  }
  const { job_id } = await r.json();
  setStatus(`<span class="badge run">running</span> <span class="pill">${job_id}</span>`);

  const es = new EventSource(`/jobs/${job_id}/stream`);
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.line !== undefined) { appendLog(m.line); return; }
    if (m.done) {
      es.close();
      const c = m.counts || {};
      const badges = [
        c.COLLECTED ? `<span class="badge ok">${c.COLLECTED} COLLECTED</span>` : '',
        c.SKIPPED   ? `<span class="badge skip">${c.SKIPPED} SKIPPED</span>` : '',
        c.FAILED    ? `<span class="badge fail">${c.FAILED} FAILED</span>` : '',
        c.NOTE      ? `<span class="badge note">${c.NOTE} NOTE</span>` : '',
      ].filter(Boolean).join(' ');
      const code = m.returncode === 0 ? 'ok' : 'fail';
      setStatus(`<span class="badge ${code}">${code === 'ok' ? 'done' : 'exit '+m.returncode}</span> ${badges}`);
      progressFinalize(c);

      // Step transitions on completion. We DON'T just trust the script's
      // exit code — collect_perf_data.sh marks individual failures with
      // `mark FAILED ...` and continues, so it can finish with exit 0 even
      // when every host was unreachable. Reflect the actual mix:
      //   - any FAILED rows in the counts → step is 'fail' (red)
      //   - script exited non-zero → step is 'fail' (red)
      //   - clean → step is 'done' (green)
      const anyFail = (c.FAILED || 0) > 0;
      const collectVerdict = (code === 'ok' && !anyFail) ? 'done' : 'fail';
      const collectStep = document.querySelector('.step[data-step="collect"]');
      const analyzeStep = document.querySelector('.step[data-step="analyze"]');
      if (collectStep.dataset.state === 'active') {
        setStepState('collect', collectVerdict);
      }
      if (analyzeStep.dataset.state === 'active') {
        setStepState('analyze', code === 'ok' ? 'done' : 'fail',
          code === 'ok' ? 'Analysis complete — see report below.' : 'Analyzer did not complete.');
      }

      if (m.bundle) {
        setStepState('report', 'active');
        resultEl.innerHTML =
          `<a class="dl" href="/bundles/${m.bundle}" download>↓ Download zip</a> ` +
          `<a class="dl-secondary" href="/jobs/${job_id}/manifest" target="_blank">MANIFEST.txt</a>`;
        // Inline-show the analysis pane straight away so the user sees the
        // verdict without clicking — saves a step for the common case.
        showAnalysis(m.bundle).then(() => setStepState('report', 'done'));
        // Collapse the log now that the run's done; user can still click to peek.
        document.getElementById('log-wrap').open = false;
      } else {
        setStepState('report', 'fail');
        resultEl.innerHTML = '<em class="dim">No bundle produced.</em>';
      }
      btn.disabled = false;
      loadBundles();
    }
  };
  // EventSource auto-reconnects on transport errors. We only treat it as
  // a real failure if the connection is closed for good (readyState === 2).
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      setStatus('<span class="badge fail">stream closed</span>');
      btn.disabled = false;
    }
    // Otherwise it's a transient hiccup — browser will reconnect.
  };
}
$('#form').addEventListener('submit', runHandler);
$('#run').addEventListener('click', runHandler);

// ---- Cross-tab running-job indicator ----
// Polls /api/logs every 3s; shows the topbar pill while a collection is in
// flight so switching tabs doesn't lose the signal. Clicking jumps to /logs.
(function(){
  const ind  = document.getElementById('run-indicator');
  const tcEl = document.getElementById('ri-tc');
  if (!ind || !tcEl) return;
  async function poll(){
    try {
      const r = await fetch('/api/logs', {cache:'no-store'});
      const items = await r.json();
      const running = items.find(i => i.kind === 'job' && i.state === 'running');
      if (running) {
        tcEl.textContent = running.test_case || running.id;
        ind.style.display = 'inline-flex';
      } else {
        ind.style.display = 'none';
      }
    } catch (_) { /* ignore — page just doesn't update this tick */ }
  }
  poll();
  setInterval(poll, 3000);
})();
</script>
</body>
</html>
"""


SETUP_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OneClick setup — Simnovus</title>
<link rel="icon" type="image/png" href="/favicon.png">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{
  --fg:#1f2937;--mut:#6b7280;--mut2:#94a3b8;
  --bd:#e5e7eb;--bg:#f8fafc;--card:#ffffff;
  --brand:#f97316;--brand-h:#ea580c;
  --nav:#1c1c2e;--nav-2:#252539;
  --ok:#16a34a;--err:#dc2626;
  --shadow:0 1px 2px rgba(15,23,42,.04),0 1px 1px rgba(15,23,42,.06);
}
.profile-bar{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid var(--bd);border-radius:10px;padding:14px 18px;margin-bottom:14px;box-shadow:var(--shadow)}
.profile-bar label{font-size:13px;font-weight:600;color:#1c1c2e;margin:0}
.profile-bar select{font:13.5px ui-sans-serif,sans-serif;padding:7px 12px;border:1px solid var(--bd);border-radius:6px;background:#fff;font-weight:500;min-width:240px}
.profile-bar select:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.12)}
.profile-bar .hint{color:var(--mut);font-size:12.5px;margin-left:8px}
.skip-tag{font-size:11px;color:#dc2626;background:#fee2e2;padding:2px 7px;border-radius:999px;margin-left:6px;font-weight:500}
.coll-tag{font-size:11px;color:#166534;background:#dcfce7;padding:2px 7px;border-radius:999px;margin-left:6px;font-weight:500}
.ssh-status{font-size:12.5px;padding:10px 12px;border-radius:6px;font-family:ui-monospace,Consolas,monospace;line-height:1.5}
.ssh-status.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}
.ssh-status.missing{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412}
.ssh-status .fp{color:#1c1c2e;font-weight:600}
.ssh-status .path{color:#94a3b8;font-size:11.5px}
#ssh-pub-details pre{background:#0f1117;color:#e2e8f0;padding:10px 12px;border-radius:6px;font:11.5px ui-monospace,Consolas,monospace;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;color:var(--fg);background:var(--bg)}
.topbar{background:var(--nav);color:#fff;padding:10px 22px;display:flex;align-items:center;gap:14px;border-bottom:3px solid var(--brand)}
.topbar img.logo{height:28px;display:block}
.topbar .divider{width:1px;height:24px;background:#3a3a55}
.topbar .title{font-size:15px;font-weight:600}
.topbar .right{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--mut2);font-size:12px}
.topnav{display:flex;gap:4px;margin-left:24px}
.topnav a{color:var(--mut2);text-decoration:none;padding:6px 14px;border-radius:6px;font-size:13px;font-weight:500;transition:background .15s,color .15s}
.topnav a:hover{background:rgba(255,255,255,.06);color:#fff}
.topnav a.active{background:var(--brand);color:#fff}
.topbar .pill{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-size:11px;background:#0f0f1a;border:1px solid #3a3a55;padding:2px 8px;border-radius:4px;color:#cbd5e1}
.version-pill{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-size:10.5px;font-weight:600;color:#cbd5e1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);padding:2px 7px;border-radius:4px;letter-spacing:.02em;line-height:1.4;margin-left:8px}
.update-btn{display:inline-flex;align-items:center;gap:5px;background:rgba(34,197,94,.18);border:1px solid rgba(34,197,94,.5);color:#dcfce7;font:500 11.5px ui-sans-serif,sans-serif;padding:4px 10px;border-radius:6px;cursor:pointer;transition:background .15s}
.update-btn:hover{background:rgba(34,197,94,.32);color:#fff}
.update-btn:disabled{cursor:wait;opacity:.7}
.update-btn .update-icon{font-size:13px;line-height:1}
.update-btn.spin .update-icon{animation:update-spin .9s linear infinite}
@keyframes update-spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
.beszel-link{color:#ffedd5;text-decoration:none;font-size:11.5px;font-weight:500;padding:4px 10px;border-radius:6px;background:rgba(249,115,22,.15);border:1px solid rgba(249,115,22,.35);transition:background .15s}
.beszel-link:hover{background:rgba(249,115,22,.3);color:#fff}
.ri-pill{display:inline-flex;align-items:center;gap:7px;color:#fff;text-decoration:none;font-size:11.5px;padding:4px 10px;border-radius:6px;background:rgba(249,115,22,.22);border:1px solid rgba(249,115,22,.5);transition:background .15s;max-width:280px;overflow:hidden}
.ri-pill:hover{background:rgba(249,115,22,.36);color:#fff}
.ri-pill .ri-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ri-pill strong{font-weight:600}
.ri-dot{width:8px;height:8px;border-radius:50%;background:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.25);flex-shrink:0;animation:ri-pulse 1.2s ease-in-out infinite}
@keyframes ri-pulse{0%,100%{opacity:.5}50%{opacity:1}}

main{padding:18px 22px;max-width:1300px;margin:0 auto}
.toolbar{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.toolbar .conf-path{color:var(--mut);font-size:12.5px;font-family:ui-monospace,Consolas,monospace}
.toolbar .btn{margin-left:auto}

.section{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:18px;margin-bottom:14px;box-shadow:var(--shadow)}
.section h2{margin:0 0 14px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#1c1c2e;font-weight:600;display:flex;align-items:center;gap:8px}
.section h2::before{content:'';display:block;width:4px;height:14px;background:var(--brand);border-radius:2px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px 18px}
@media (max-width:760px){.grid{grid-template-columns:1fr}}
.field{display:flex;flex-direction:column;gap:4px}
.field label{font-size:12px;color:#475569;font-weight:500}
.field label .ph{color:var(--mut2);font-weight:400;margin-left:6px;font-size:11px}
.field input,.field select{padding:7px 10px;border:1px solid var(--bd);border-radius:6px;font:13px ui-sans-serif,system-ui,sans-serif;background:#fff}
.field input:focus,.field select:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.12)}
.field.check{flex-direction:row;align-items:center;gap:8px}
.field.check input{width:14px;height:14px;margin:0;accent-color:var(--brand)}
.field.check label{margin:0;font-weight:400}

.btn{background:var(--brand);color:#fff;border:0;border-radius:6px;padding:9px 22px;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
.btn:hover{background:var(--brand-h)}
.btn:disabled{background:#cbd5e1;cursor:not-allowed}
.btn-secondary{background:#f1f5f9;color:#475569}
.btn-secondary:hover{background:#e2e8f0;color:#1e293b}
.btn-secondary.danger{color:#dc2626}
.btn-secondary.danger:hover{background:#fee2e2;color:#991b1b}

#flash{position:fixed;top:80px;right:30px;padding:12px 18px;border-radius:8px;color:#fff;font-weight:500;font-size:13.5px;z-index:100;display:none;box-shadow:0 4px 14px rgba(0,0,0,.15)}
#flash.ok{background:var(--ok);display:block}
#flash.err{background:var(--err);display:block}

details{background:#f8fafc;border:1px solid var(--bd);border-radius:8px;padding:8px 12px;margin-top:8px}
details summary{cursor:pointer;font-size:13px;color:#475569;font-weight:500}
details pre{margin:10px 0 0;padding:12px;background:#0f1117;color:#e2e8f0;border-radius:6px;font:12px ui-monospace,Consolas,monospace;overflow-x:auto;max-height:400px}

/* Advanced section subgroup styling */
.adv-details{padding:0;background:#fff;border:1px solid var(--bd)}
.adv-details > summary{padding:12px 16px;background:#f8fafc;border-bottom:1px solid var(--bd);font-size:13px;font-weight:600;color:#1c1c2e;list-style:none;display:flex;align-items:center;gap:8px}
.adv-details > summary::-webkit-details-marker{display:none}
.adv-details > summary::before{content:'▶';color:#9ca3af;font-size:10px;display:inline-block;transition:transform .15s}
.adv-details[open] > summary::before{transform:rotate(90deg)}
.adv-details > summary:hover{background:#f1f5f9}
.adv-body{padding:14px 16px;display:flex;flex-direction:column;gap:18px}
.adv-group{padding:0}
.adv-group-title{
  margin:0 0 10px;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;
  color:#1c1c2e;font-weight:700;
  padding:6px 10px;background:linear-gradient(90deg,rgba(249,115,22,.08),rgba(249,115,22,0));
  border-left:3px solid var(--brand);border-radius:3px;
}
.extras{background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:9px 12px;border-radius:6px;font-size:12.5px;margin-bottom:12px}
.extras code{background:#fff;border:1px solid #fde68a;padding:1px 5px;border-radius:3px;font-size:11.5px}
</style>
</head>
<body>
<header class="topbar">
  <img class="logo" src="/static/logo.svg" alt="Simnovus">
  <div class="divider"></div>
  <span class="title">OneClick</span>{% if version %}<span class="version-pill" title="OneClick UI version — bumps when you click Update and pick up a new build">v{{ version }}</span>{% endif %}<span class="brand-sub">setup</span>
  <nav class="topnav">
    <a href="/">Collector</a>
    <a href="/logs">Logs</a>
    <a href="/setup" class="active">Setup</a>
  </nav>
  <div class="right">
    <a class="ri-pill" id="run-indicator" href="/logs" style="display:none" title="A collection is in progress — click to view live log">
      <span class="ri-dot"></span>
      <span class="ri-text">Running: <strong id="ri-tc">…</strong></span>
    </a>
    <button type="button" class="update-btn" id="update-btn" onclick="runUpdate()"
            title="Fetch the latest OneClick from GitHub and re-install. Service restarts automatically.">
      <span class="update-icon" id="update-icon">⤓</span>
      <span class="update-label" id="update-label">Update</span>
    </button>
    {% if beszel_url %}<a class="beszel-link" href="{{ beszel_url }}" target="_blank" rel="noopener" title="Open Beszel hub">Beszel ↗</a>{% endif %}
    <span class="pill">setup.conf</span>
  </div>
</header>
<main>
  <div class="toolbar">
    <span class="conf-path">profiles: {{ profiles_json_path }}</span>
    <button class="btn btn-secondary" type="button" onclick="newProfile()">+ New profile</button>
    <button class="btn btn-secondary" type="button" onclick="duplicateProfile()">Duplicate</button>
    <button class="btn btn-secondary danger" type="button" onclick="deleteProfile()">Delete</button>
    <button class="btn" type="button" onclick="saveProfile()">Save profile</button>
  </div>

  <div class="profile-bar">
    <label for="_profile">Profile</label>
    <select id="_profile" onchange="loadProfileIntoForm()">
      {% for name, prof in profiles.items() %}
        <option value="{{ name }}">{{ prof.label }} <span style="color:#94a3b8">— {{ name }}</span></option>
      {% endfor %}
    </select>
    <span class="hint">Edits here only update profiles.json. <code>setup.conf</code> is rewritten on the next Collector Run.</span>
  </div>

  <form id="form" onsubmit="return false">
    <section class="section">
      <h2>Identity</h2>
      <div class="grid">
        <div class="field">
          <label for="_id">Profile ID<span class="ph">letters/digits/underscore; used in URLs + dropdown value</span></label>
          <input id="_id" type="text" autocomplete="off">
        </div>
        <div class="field">
          <label for="_label">Display label<span class="ph">shown in dropdowns</span></label>
          <input id="_label" type="text" autocomplete="off">
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Hosts (blank = skip section on collection)</h2>
      <div class="grid">
        {% for key, label, ph in host_fields %}
        <div class="field">
          <label for="{{ key }}">
            {{ label }}
            <span class="coll-tag" data-tag="{{ key }}">collected</span>
            <span class="ph">{{ ph }}</span>
          </label>
          <input id="{{ key }}" data-default="{{ key }}" type="text" autocomplete="off" oninput="updateTag(this)">
        </div>
        {% endfor %}
      </div>
    </section>

    <details class="adv-details">
      <summary>Advanced — credentials + paths ({{ advanced_count }} fields, grouped by host)</summary>
      <div class="adv-body">
        {% for group_name, fields in advanced_groups %}
        <section class="adv-group">
          <h3 class="adv-group-title">{{ group_name }}</h3>
          <div class="grid">
            {% for key, label in fields %}
            <div class="field">
              <label for="{{ key }}">{{ label }}<span class="ph">{{ key }}</span></label>
              <input id="{{ key }}" data-fixed="{{ key }}" type="{{ 'password' if 'PASS' in key else 'text' }}" autocomplete="off">
            </div>
            {% endfor %}
          </div>
        </section>
        {% endfor %}
      </div>
    </details>
  </form>

  <details>
    <summary>Current setup.conf (read-only — rewritten by Collector Run)</summary>
    <pre>{{ raw }}</pre>
  </details>
</main>
<div id="flash"></div>
<script>
function flash(kind, msg){
  const el = document.getElementById('flash');
  el.className = kind;
  el.textContent = msg;
  setTimeout(() => { el.style.display = 'none'; el.className = ''; }, 4000);
}
function updateTag(input){
  const label = input.previousElementSibling;
  if (!label) return;
  const tag = label.querySelector('.skip-tag, .coll-tag');
  if (!tag) return;
  const v = input.value.trim();
  tag.className = v ? 'coll-tag' : 'skip-tag';
  tag.textContent = v ? 'collected' : 'skipped';
}

// Load the selected profile from the API and populate the form fields.
async function loadProfileIntoForm(){
  const sel = document.getElementById('_profile');
  const name = sel.value;
  if (!name) return;
  const r = await fetch('/api/profiles/' + encodeURIComponent(name));
  if (!r.ok) { flash('err', 'Failed to load ' + name); return; }
  const prof = await r.json();
  document.getElementById('_id').value = name;
  document.getElementById('_label').value = prof.label || '';
  const defs = prof.defaults || {};
  document.querySelectorAll('[data-default]').forEach(el => {
    el.value = defs[el.dataset.default] || '';
    updateTag(el);
  });
  const fixed = prof.fixed || {};
  document.querySelectorAll('[data-fixed]').forEach(el => {
    el.value = fixed[el.dataset.fixed] || '';
  });
}

// Save the profile currently in the form (using its _id as the URL).
async function saveProfile(){
  const id = document.getElementById('_id').value.trim();
  const label = document.getElementById('_label').value.trim() || id;
  if (!id) { flash('err', 'Profile ID is required'); return; }
  const defaults = {};
  document.querySelectorAll('[data-default]').forEach(el => {
    defaults[el.dataset.default] = el.value.trim();
  });
  const fixed = {};
  document.querySelectorAll('[data-fixed]').forEach(el => {
    fixed[el.dataset.fixed] = el.value;  // preserve trailing spaces in paths if any
  });
  const r = await fetch('/api/profiles/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({label, defaults, fixed}),
  });
  const j = await r.json();
  if (j.ok) {
    flash('ok', 'Saved · ' + j.message);
    // Re-fetch the dropdown so a new profile appears.
    setTimeout(() => location.reload(), 800);
  } else {
    flash('err', 'Failed: ' + j.message);
  }
}

// New profile: prompt for an ID, blank the IPs, and SEED the advanced creds
// from QA_System (or the first profile we can find) so the new profile is
// usable out of the box. Without seeding, callbox/Simnovator SSH would fail
// on the first run because passwords would all be blank.
async function newProfile(){
  const id = prompt('New profile ID (letters/digits/underscore):', '');
  if (!id) return;
  // Pick a template profile. QA_System is the canonical one; fall back to
  // whatever's first in the dropdown.
  const sel = document.getElementById('_profile');
  const tmplId = [...sel.options].some(o => o.value === 'QA_System')
    ? 'QA_System'
    : (sel.options[0] && sel.options[0].value) || '';
  let tmpl = null;
  if (tmplId) {
    try {
      const r = await fetch('/api/profiles/' + encodeURIComponent(tmplId));
      if (r.ok) tmpl = await r.json();
    } catch (_) { /* ignore — user just gets blank creds */ }
  }
  document.getElementById('_id').value = id;
  document.getElementById('_label').value = id;
  // Blank only the per-host IPs.
  document.querySelectorAll('[data-default]').forEach(el => { el.value = ''; updateTag(el); });
  // Seed advanced creds + paths from the template profile.
  const fixed = (tmpl && tmpl.fixed) || {};
  document.querySelectorAll('[data-fixed]').forEach(el => {
    el.value = fixed[el.dataset.fixed] || '';
  });
  flash('ok', tmpl
    ? `Seeded creds from ${tmplId} · fill in IPs + click Save`
    : 'Blank profile · fill in fields + click Save');
}

// Duplicate: copy current form into a new profile id.
function duplicateProfile(){
  const cur = document.getElementById('_id').value;
  const newId = prompt('New profile ID (copy of ' + cur + '):', cur + '_copy');
  if (!newId) return;
  document.getElementById('_id').value = newId;
  document.getElementById('_label').value = (document.getElementById('_label').value || cur) + ' (copy)';
  flash('ok', 'Duplicated · click Save to create ' + newId);
}

// Delete the currently selected profile.
async function deleteProfile(){
  const sel = document.getElementById('_profile');
  const name = sel.value;
  if (!name) return;
  if (!confirm('Delete profile ' + name + '? This cannot be undone.')) return;
  const r = await fetch('/api/profiles/' + encodeURIComponent(name), { method: 'DELETE' });
  const j = await r.json();
  if (j.ok) {
    flash('ok', j.message);
    setTimeout(() => location.reload(), 800);
  } else {
    flash('err', 'Failed: ' + j.message);
  }
}

// Initial population from the first profile in the dropdown.
loadProfileIntoForm();

// ---- SSH key panel ----
// Status box at the top of Setup. On load, fetches /api/ssh-key to show
// fingerprint + path. Upload writes to $HOME/.ssh/id_ed25519 on the
// collector host (perfqa user); OpenSSH auto-uses it for outbound.
async function refreshSshKey(){
  const status = document.getElementById('ssh-key-status');
  const del    = document.getElementById('ssh-key-del');
  const copy   = document.getElementById('ssh-pub-copy');
  const det    = document.getElementById('ssh-pub-details');
  const pubEl  = document.getElementById('ssh-pub-text');
  try {
    const r = await fetch('/api/ssh-key', {cache:'no-store'});
    const d = await r.json();
    if (d.present) {
      const when = d.mtime ? new Date(d.mtime*1000).toLocaleString() : '';
      status.className = 'ssh-status ok';
      status.innerHTML =
        `<div class="fp">✓ ${d.fingerprint || 'key uploaded'}</div>` +
        `<div class="path">${d.path} · mode ${d.mode || ''} · ${d.size} bytes · ${when}</div>`;
      del.style.display  = 'inline-block';
      copy.style.display = d.pubkey ? 'inline-block' : 'none';
      if (d.pubkey) { pubEl.textContent = d.pubkey; det.style.display = 'block'; }
    } else {
      status.className = 'ssh-status missing';
      status.innerHTML = `No SSH key uploaded yet. Path on the collector host: <code>${d.path}</code>`;
      del.style.display = 'none';
      copy.style.display = 'none';
      det.style.display = 'none';
    }
  } catch (e) {
    status.className = 'ssh-status missing';
    status.textContent = 'failed to load /api/ssh-key';
  }
}

async function uploadSshKey(){
  // Prefer pasted text if both are filled — common case is "I copied it
  // from my password manager so the file picker doesn't help".
  const pasted = document.getElementById('ssh-key-text').value.trim();
  const f      = document.getElementById('ssh-key-file').files[0];
  if (!pasted && !f) {
    flash('err', 'Paste the key text or pick a file first');
    return;
  }
  const fd = new FormData();
  if (pasted) {
    // Quick client-side sanity check so the user gets immediate feedback
    // instead of a round-trip rejection.
    if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(pasted)) {
      flash('err', 'Pasted text does not look like a PEM private key');
      return;
    }
    // Ship as a Blob so the backend's request.files.get('key') works the
    // same as the file-upload path — single endpoint, no special case.
    const blob = new Blob([pasted + (pasted.endsWith('\n') ? '' : '\n')],
                          {type:'application/x-pem-file'});
    fd.append('key', blob, 'pasted-key.pem');
  } else {
    if (f.size > 32*1024) {
      flash('err', 'File looks too large for an SSH key (' + f.size + ' bytes)');
      return;
    }
    fd.append('key', f);
  }
  try {
    const r = await fetch('/api/ssh-key', {method:'POST', body:fd});
    const d = await r.json();
    if (d.ok) {
      flash('ok', d.message || 'key saved');
      document.getElementById('ssh-key-file').value = '';
      document.getElementById('ssh-key-text').value = '';
      await refreshSshKey();
    } else {
      flash('err', d.error || 'save failed');
    }
  } catch (e) {
    flash('err', 'save failed: ' + e.message);
  }
}

async function deleteSshKey(){
  if (!confirm('Delete the uploaded SSH key from the collector host?')) return;
  const r = await fetch('/api/ssh-key', {method:'DELETE'});
  const d = await r.json();
  if (d.ok) { flash('ok', 'key deleted'); await refreshSshKey(); }
  else      { flash('err', d.error || 'delete failed'); }
}

async function copySshPubkey(){
  const pub = document.getElementById('ssh-pub-text').textContent.trim();
  if (!pub) return;
  try {
    await navigator.clipboard.writeText(pub);
    flash('ok', 'public key copied to clipboard');
  } catch (e) {
    flash('err', 'clipboard write failed: ' + e.message);
  }
}

// (SSH-key panel removed from the UI — the shared key is provisioned out-of-band.
//  The /api/ssh-key endpoints remain for backward-compat but aren't shown here.)

// ---- Self-update from GitHub ----
// Hits /api/update which downloads main.tar.gz from the oneclick repo,
// extracts it, runs sudo bash scripts/install.sh, restarts the service.
// The systemd restart kills our own process before the response returns,
// so we treat "fetch failed mid-stream" as expected and reload after a
// few seconds to pick up the new code.
async function runUpdate(){
  const btn  = document.getElementById('update-btn');
  const lbl  = document.getElementById('update-label');
  if (!btn) return;
  if (!confirm('Fetch the latest perf-qa from GitHub and re-install?\n\nThe service will restart. This usually takes 10–30 seconds.')) return;
  btn.disabled = true;
  btn.classList.add('spin');
  lbl.textContent = 'Updating…';
  let stillUp = true;
  try {
    const r = await fetch('/api/update', {method: 'POST', cache: 'no-store'});
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) {
      lbl.textContent = 'Updated — reloading';
    } else {
      stillUp = false;
      const tail = (j && j.log) ? '\n\nLast log lines:\n' + j.log.split('\n').slice(-15).join('\n') : '';
      lbl.textContent = 'Update failed';
      alert('Update failed.' + tail);
    }
  } catch (e) {
    // Most common case — the service restarted before our response came back.
    // That's actually success; reload to pick up the new code.
    lbl.textContent = 'Restarting — reloading';
  }
  if (stillUp) {
    setTimeout(() => { location.reload(); }, 4000);
  } else {
    btn.disabled = false;
    btn.classList.remove('spin');
  }
}

// ---- Cross-tab running-job indicator ----
(function(){
  const ind  = document.getElementById('run-indicator');
  const tcEl = document.getElementById('ri-tc');
  if (!ind || !tcEl) return;
  async function poll(){
    try {
      const r = await fetch('/api/logs', {cache:'no-store'});
      const items = await r.json();
      const running = items.find(i => i.kind === 'job' && i.state === 'running');
      if (running) {
        tcEl.textContent = running.test_case || running.id;
        ind.style.display = 'inline-flex';
      } else {
        ind.style.display = 'none';
      }
    } catch (_) { /* ignore */ }
  }
  poll();
  setInterval(poll, 3000);
})();
</script>
</body>
</html>
"""


LOGS_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OneClick logs — Simnovus</title>
<link rel="icon" type="image/png" href="/favicon.png">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{
  --fg:#1f2937;--mut:#6b7280;--mut2:#94a3b8;
  --bd:#e5e7eb;--bg:#f8fafc;--card:#ffffff;
  --brand:#f97316;--brand-h:#ea580c;
  --nav:#1c1c2e;--nav-2:#252539;
  --ok:#16a34a;--err:#dc2626;
  --shadow:0 1px 2px rgba(15,23,42,.04),0 1px 1px rgba(15,23,42,.06);
}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;color:var(--fg);background:var(--bg)}
.topbar{background:var(--nav);color:#fff;padding:10px 22px;display:flex;align-items:center;gap:14px;border-bottom:3px solid var(--brand)}
.topbar img.logo{height:28px;display:block}
.topbar .divider{width:1px;height:24px;background:#3a3a55}
.topbar .title{font-size:15px;font-weight:600}
.topbar .right{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--mut2);font-size:12px}
.topnav{display:flex;gap:4px;margin-left:24px}
.topnav a{color:var(--mut2);text-decoration:none;padding:6px 14px;border-radius:6px;font-size:13px;font-weight:500;transition:background .15s,color .15s}
.topnav a:hover{background:rgba(255,255,255,.06);color:#fff}
.topnav a.active{background:var(--brand);color:#fff}
.topbar .pill{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-size:11px;background:#0f0f1a;border:1px solid #3a3a55;padding:2px 8px;border-radius:4px;color:#cbd5e1}
.version-pill{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-size:10.5px;font-weight:600;color:#cbd5e1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);padding:2px 7px;border-radius:4px;letter-spacing:.02em;line-height:1.4;margin-left:8px}
.update-btn{display:inline-flex;align-items:center;gap:5px;background:rgba(34,197,94,.18);border:1px solid rgba(34,197,94,.5);color:#dcfce7;font:500 11.5px ui-sans-serif,sans-serif;padding:4px 10px;border-radius:6px;cursor:pointer;transition:background .15s}
.update-btn:hover{background:rgba(34,197,94,.32);color:#fff}
.update-btn:disabled{cursor:wait;opacity:.7}
.update-btn .update-icon{font-size:13px;line-height:1}
.update-btn.spin .update-icon{animation:update-spin .9s linear infinite}
@keyframes update-spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
.beszel-link{color:#ffedd5;text-decoration:none;font-size:11.5px;font-weight:500;padding:4px 10px;border-radius:6px;background:rgba(249,115,22,.15);border:1px solid rgba(249,115,22,.35);transition:background .15s}
.beszel-link:hover{background:rgba(249,115,22,.3);color:#fff}
.ri-pill{display:inline-flex;align-items:center;gap:7px;color:#fff;text-decoration:none;font-size:11.5px;padding:4px 10px;border-radius:6px;background:rgba(249,115,22,.22);border:1px solid rgba(249,115,22,.5);transition:background .15s;max-width:280px;overflow:hidden}
.ri-pill:hover{background:rgba(249,115,22,.36);color:#fff}
.ri-pill .ri-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ri-pill strong{font-weight:600}
.ri-dot{width:8px;height:8px;border-radius:50%;background:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.25);flex-shrink:0;animation:ri-pulse 1.2s ease-in-out infinite}
@keyframes ri-pulse{0%,100%{opacity:.5}50%{opacity:1}}

main{display:grid;grid-template-columns:340px 1fr;gap:14px;padding:14px 18px;max-width:1700px;margin:0 auto}
@media (max-width:1000px){main{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px;box-shadow:var(--shadow);min-height:0;display:flex;flex-direction:column}
.card h2{margin:0 0 10px;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);font-weight:600}

/* Bundle list (left column) */
.log-list{display:flex;flex-direction:column;gap:0;max-height:84vh;overflow-y:auto;margin:-4px -4px 0;padding:4px}
.log-entry{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:8px;border:1px solid transparent;cursor:pointer;transition:background .12s,border-color .12s}
.log-entry:hover{background:#f1f5f9}
.log-entry.selected{background:#fff7ed;border-color:#fed7aa}
.log-entry .dot{width:8px;height:8px;border-radius:50%;background:#cbd5e1;flex-shrink:0}
.log-entry.running .dot{background:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.18);animation:pulse 1.2s ease-in-out infinite}
.log-entry.archived .dot{background:var(--ok)}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
.log-entry .body{flex:1;min-width:0}
.log-entry .tc{font-weight:600;font-size:12.5px;color:#1c1c2e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.log-entry .meta{font-size:11px;color:var(--mut);margin-top:2px}
.log-entry .size{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--mut2);flex-shrink:0}

/* Inspector (right column) — header, sub-tabs, content pane */
.insp{display:flex;flex-direction:column;gap:10px;height:84vh}
.insp-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px solid var(--bd)}
.insp-title{font-size:14px;font-weight:600;color:#1c1c2e;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.insp-actions{display:flex;gap:6px}
.btn-link{color:#475569;text-decoration:none;font-size:12px;padding:5px 10px;border-radius:6px;background:#f1f5f9;border:1px solid transparent;transition:background .12s;cursor:pointer}
.btn-link:hover{background:#e2e8f0;color:#1e293b}

.subtabs{display:flex;gap:4px;border-bottom:1px solid var(--bd)}
.subtab{padding:7px 14px;border:0;background:transparent;cursor:pointer;font:13px ui-sans-serif,sans-serif;color:var(--mut);font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .12s,border-color .12s}
.subtab:hover{color:#1c1c2e}
.subtab.active{color:var(--brand);border-bottom-color:var(--brand);font-weight:600}

.pane{flex:1;min-height:0;overflow:hidden;display:none;flex-direction:column}
.pane.active{display:flex}

/* Common dark text viewer (Log / Analysis raw / file viewer) */
pre.dark{flex:1;min-height:0;margin:0;background:#0f1117;color:#e2e8f0;border:1px solid #1f2937;border-radius:8px;padding:12px 14px;font:12px/1.55 ui-monospace,"JetBrains Mono",Consolas,monospace;white-space:pre-wrap;word-break:break-word;overflow-y:auto}
pre.dark .ts{color:#64748b}
pre.dark .ok{color:#4ade80}
pre.dark .skip{color:#facc15}
pre.dark .fail{color:#f87171}
pre.dark .warn{color:#facc15}
pre.dark .err{color:#f87171}
pre.dark .note{color:#60a5fa}
pre.dark .info{color:#60a5fa}

.placeholder{color:var(--mut);font-style:italic;padding:30px;text-align:center;flex:1;display:flex;align-items:center;justify-content:center;background:#f8fafc;border:1px dashed var(--bd);border-radius:8px}

.banner{font-size:11.5px;color:#9a3412;background:#fff7ed;border:1px solid #fed7aa;padding:6px 10px;border-radius:6px}

/* Analysis pane — friendly rows */
.an-rows{display:flex;flex-direction:column;gap:6px;overflow-y:auto;padding:2px}
.an-row{display:flex;align-items:center;gap:12px;padding:9px 12px;border:1px solid var(--bd);border-radius:8px;background:#fff}
.an-row[data-status="ok"]   {background:#f0fdf4;border-color:#bbf7d0}
.an-row[data-status="warn"] {background:#fff7ed;border-color:#fed7aa}
.an-row[data-status="fail"] {background:#fef2f2;border-color:#fecaca}
.an-icon{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;font-size:12px;background:#e2e8f0;color:#64748b}
.an-row[data-status="ok"] .an-icon{background:#dcfce7;color:var(--ok)}
.an-row[data-status="warn"] .an-icon{background:#ffedd5;color:#9a3412}
.an-row[data-status="fail"] .an-icon{background:#fee2e2;color:var(--err)}
.an-area{font-weight:600;color:#1c1c2e;min-width:140px;font-size:12.5px}
.an-note{color:#475569;font-size:12px;flex:1}
.an-extra{margin-top:10px;font:11.5px/1.55 ui-monospace,Consolas,monospace;color:#475569;background:#f8fafc;border:1px solid var(--bd);border-radius:8px;padding:10px 12px;white-space:pre-wrap}

/* System pane — rendered markdown */
.md{font-size:13px;color:var(--fg);overflow-y:auto;padding:4px}
.md h1{font-size:17px;font-weight:700;color:#1c1c2e;margin:0 0 10px}
.md h2{font-size:13px;font-weight:600;color:#1c1c2e;margin:18px 0 8px;padding-bottom:5px;border-bottom:2px solid var(--brand);display:inline-block}
.md h3{font-size:12.5px;font-weight:600;color:#1c1c2e;margin:12px 0 6px}
.md p{margin:5px 0}
.md hr{border:0;border-top:1px solid var(--bd);margin:18px 0}
.md em{color:var(--mut);font-style:italic;font-size:11.5px}
.md strong{color:#1c1c2e;font-weight:600}
.md code{background:#f1f5f9;border:1px solid var(--bd);padding:1px 5px;border-radius:4px;font:11.5px ui-monospace,Consolas,monospace;color:#9a3412}
.md table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:12px;background:#fff;border:1px solid var(--bd);border-radius:6px;overflow:hidden}
.md th{background:#f8fafc;text-align:left;padding:7px 11px;font-weight:600;color:#1c1c2e;font-size:11px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--bd)}
.md td{padding:7px 11px;border-bottom:1px solid #f1f5f9;vertical-align:top;color:#374151}
.md tr:last-child td{border-bottom:0}
.md td:first-child{font-weight:600;color:#1c1c2e;background:#fafbfc;width:150px}

/* Files pane — 2-col internal: tree | viewer */
.files-grid{flex:1;min-height:0;display:grid;grid-template-columns:300px 1fr;gap:10px}
@media (max-width:1100px){.files-grid{grid-template-columns:1fr}}
.tree-pane{display:flex;flex-direction:column;min-height:0;border:1px solid var(--bd);border-radius:8px;padding:10px;background:#fff}
.tree-search{width:100%;padding:6px 10px;border:1px solid var(--bd);border-radius:6px;font:12px ui-sans-serif,sans-serif;margin-bottom:8px}
.tree-search:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.12)}
.tree{font:12px ui-sans-serif,sans-serif;color:var(--fg);overflow-y:auto;flex:1;min-height:0}
.tree-folder{display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;font-weight:600;color:#1c1c2e;border-radius:5px;user-select:none;font-size:12px}
.tree-folder:hover{background:#f1f5f9}
.tree-folder::before{content:'▶';color:#9ca3af;font-size:9px;transition:transform .12s;display:inline-block;flex-shrink:0}
.tree-folder.open::before{transform:rotate(90deg)}
.tree-folder .count{margin-left:auto;color:var(--mut);font-weight:400;font-size:10.5px}
.tree-children{display:none;margin-left:12px;padding-left:5px;border-left:1px dashed #e2e8f0}
.tree-folder.open + .tree-children{display:block}
.tree-file{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:4px;cursor:pointer;color:#475569;border:1px solid transparent}
.tree-file:hover{background:#f1f5f9;color:#1c1c2e}
.tree-file.selected{background:#fff7ed;border-color:#fed7aa;color:#1c1c2e}
.tree-file .fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tree-file .size{color:var(--mut2);font-family:ui-monospace,Consolas,monospace;font-size:10px;flex-shrink:0}
.fview-wrap{display:flex;flex-direction:column;gap:8px;min-height:0}
.fview-head{display:flex;align-items:center;gap:10px}
.fview-title{font-family:ui-monospace,Consolas,monospace;font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1c1c2e}
.fview-img{max-width:100%;max-height:75vh;border:1px solid var(--bd);border-radius:6px;background:#fff;align-self:flex-start;cursor:zoom-in;transition:filter .12s}
.fview-img:hover{filter:brightness(1.02)}

/* Lightbox: click an image to view at native resolution, scrollable + zoom */
.lightbox{position:fixed;inset:0;background:rgba(15,17,23,.92);z-index:100;display:none;flex-direction:column;padding:14px}
.lightbox.open{display:flex}
.lightbox-bar{display:flex;align-items:center;gap:10px;color:#cbd5e1;font-size:12px;padding-bottom:10px}
.lightbox-bar .name{font-family:ui-monospace,Consolas,monospace;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lightbox-bar button,.lightbox-bar a{background:#1f2937;color:#fff;border:0;border-radius:6px;padding:5px 12px;font:12px ui-sans-serif,sans-serif;cursor:pointer;text-decoration:none}
.lightbox-bar button:hover,.lightbox-bar a:hover{background:#374151}
.lightbox-scroll{flex:1;overflow:auto;background:#fff;border-radius:6px;display:flex;align-items:flex-start;justify-content:flex-start;padding:8px}
.lightbox-img{display:block;cursor:zoom-out;transform-origin:top left;transition:none}
/* Two zoom modes via data-mode: fit (shrink to viewport) and native (1:1) */
.lightbox-img[data-mode="fit"]{max-width:100%;max-height:calc(95vh - 60px);width:auto;height:auto;cursor:zoom-in}
.lightbox-img[data-mode="native"]{max-width:none;max-height:none}

.empty{padding:30px 12px;text-align:center;color:var(--mut);font-style:italic;font-size:13px}
.search{width:100%;padding:7px 11px;border:1px solid var(--bd);border-radius:6px;font:13px ui-sans-serif,sans-serif;margin-bottom:10px}
.search:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(249,115,22,.12)}
</style>
</head>
<body>
<header class="topbar">
  <img class="logo" src="/static/logo.svg" alt="Simnovus">
  <div class="divider"></div>
  <span class="title">OneClick</span>{% if version %}<span class="version-pill" title="OneClick UI version — bumps when you click Update and pick up a new build">v{{ version }}</span>{% endif %}
  <nav class="topnav">
    <a href="/">Collector</a>
    <a href="/logs" class="active">Logs</a>
    <a href="/setup">Setup</a>
  </nav>
  <div class="right">
    <a class="ri-pill" id="run-indicator" href="/logs" style="display:none" title="A collection is in progress — click to view live log">
      <span class="ri-dot"></span>
      <span class="ri-text">Running: <strong id="ri-tc">…</strong></span>
    </a>
    <button type="button" class="update-btn" id="update-btn" onclick="runUpdate()"
            title="Fetch the latest OneClick from GitHub and re-install. Service restarts automatically.">
      <span class="update-icon" id="update-icon">⤓</span>
      <span class="update-label" id="update-label">Update</span>
    </button>
    {% if beszel_url %}<a class="beszel-link" href="{{ beszel_url }}" target="_blank" rel="noopener" title="Open Beszel hub">Beszel ↗</a>{% endif %}
    <span>{{ host_label }}</span>
    <span class="pill">bundle inspector</span>
  </div>
</header>
<main>
  <section class="card">
    <h2>Runs</h2>
    <input class="search" id="search" type="text" placeholder="Filter by testcase…" autocomplete="off">
    <div class="log-list" id="log-list"><div class="empty">loading…</div></div>
  </section>
  <section class="card">
    <div class="insp">
      <div class="insp-head">
        <div class="insp-title" id="insp-title">Select a run on the left</div>
        <div class="insp-actions" id="insp-actions"></div>
      </div>
      <nav class="subtabs" id="subtabs">
        <button class="subtab active" data-view="log">Log</button>
        <button class="subtab" data-view="analysis">Analysis</button>
        <button class="subtab" data-view="system">System</button>
        <button class="subtab" data-view="files">Files</button>
      </nav>

      <!-- Pane: Log -->
      <div class="pane active" data-pane="log">
        <div class="placeholder" id="ph-log">No bundle selected.</div>
        <pre class="dark" id="log-text" style="display:none"></pre>
      </div>

      <!-- Pane: Analysis -->
      <div class="pane" data-pane="analysis">
        <div class="placeholder" id="ph-analysis">Pick a bundle.</div>
        <div id="analysis-content" style="display:none;flex:1;overflow-y:auto;min-height:0">
          <div class="an-rows" id="an-rows"></div>
          <div class="an-extra" id="an-extra" style="display:none"></div>
        </div>
      </div>

      <!-- Pane: System -->
      <div class="pane" data-pane="system">
        <div class="placeholder" id="ph-system">Pick a bundle.</div>
        <div class="md" id="md-out" style="display:none"></div>
      </div>

      <!-- Pane: Files -->
      <div class="pane" data-pane="files">
        <div class="files-grid">
          <div class="tree-pane">
            <input class="tree-search" id="tree-search" type="text" placeholder="Filter files…" autocomplete="off">
            <div class="tree" id="file-tree"><div class="empty">pick a bundle</div></div>
          </div>
          <div class="fview-wrap">
            <div class="fview-head">
              <div class="fview-title" id="fview-title">No file selected</div>
              <div id="fview-actions"></div>
            </div>
            <div id="fview-banner" class="banner" style="display:none"></div>
            <div class="placeholder" id="ph-file">Click a file on the left.</div>
            <pre class="dark" id="file-view" style="display:none"></pre>
            <img class="fview-img" id="file-image" style="display:none" alt="" title="Click to zoom">
          </div>
        </div>
      </div>
    </div>
  </section>
</main>

<!-- Image lightbox: opens when an image in the Files pane is clicked. -->
<div class="lightbox" id="lightbox" role="dialog" aria-modal="true" aria-hidden="true">
  <div class="lightbox-bar">
    <span class="name" id="lb-name"></span>
    <button id="lb-toggle" title="Toggle fit / 100% (or click image)">Fit</button>
    <a id="lb-dl" href="#" download title="Download original">↓ Download</a>
    <button id="lb-close" title="Close (Esc)">✕</button>
  </div>
  <div class="lightbox-scroll" id="lb-scroll">
    <img class="lightbox-img" id="lb-img" data-mode="fit" alt="">
  </div>
</div>
<script>
const $ = s => document.querySelector(s);
let entries = [];
let selectedId = null;        // entry id (could be job_id OR bundle name)
let assetId = null;           // ALWAYS the bundle name — what /bundles/<name>/... endpoints expect
let currentView = 'log';      // log | analysis | system | files
let activeEs = null;          // EventSource for live stream
let viewLoaded = {};          // { 'system': true } — caches per-view fetch state for current bundle
let bundleFiles = [];         // for Files pane
let selectedFile = null;

function fmtBytes(n){
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(2) + ' MB';
}
function fmtDate(ts){ return new Date(ts*1000).toLocaleString(); }
function parseBundleName(name){
  const m = name && name.match(/^(.+)_diagnostics_(\d{8})_(\d{6})\.(zip|tar\.gz)$/);
  if (!m) return { tc: name || '(unknown)', when: '' };
  const tc = m[1]; const d = m[2], t = m[3];
  return { tc, when: `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}` };
}
function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ---- Bundle list ----
async function loadList(){
  try {
    const r = await fetch('/api/logs', {cache:'no-store'});
    entries = await r.json();
  } catch (e) { entries = []; }
  renderList();
  if (!selectedId && entries.length) selectEntry(entries[0]);
}
function renderList(){
  const q = ($('#search').value || '').toLowerCase().trim();
  const el = $('#log-list');
  const filtered = entries.filter(e => {
    if (!q) return true;
    const { tc } = parseBundleName(e.bundle || e.id);
    return (tc || '').toLowerCase().includes(q) || (e.id || '').toLowerCase().includes(q);
  });
  if (!filtered.length) { el.innerHTML = '<div class="empty">no runs yet</div>'; return; }
  el.innerHTML = filtered.map(e => {
    const isJob = e.kind === 'job';
    const running = isJob && e.state === 'running';
    const klass = running ? 'running' : 'archived';
    const ts = running ? e.started : (isJob ? e.finished : e.mtime);
    const { tc, when } = parseBundleName(e.bundle || e.id);
    const meta = running
      ? `● running · ${e.lines} lines · started ${ts ? fmtDate(ts) : '—'}`
      : (when || (ts ? fmtDate(ts) : ''));
    const sz = e.log_size ? fmtBytes(e.log_size) : (e.size ? fmtBytes(e.size) : '');
    const sel = e.id === selectedId ? ' selected' : '';
    return `<div class="log-entry ${klass}${sel}" data-id="${e.id}">
      <div class="dot"></div>
      <div class="body">
        <div class="tc" title="${e.id}">${tc}</div>
        <div class="meta">${meta}</div>
      </div>
      <div class="size">${sz}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.log-entry').forEach(n => {
    n.addEventListener('click', () => {
      const id = n.dataset.id;
      const e = entries.find(x => x.id === id);
      if (e) selectEntry(e);
    });
  });
}

// ---- Sub-tab switching ----
function setView(view){
  currentView = view;
  document.querySelectorAll('.subtab').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.pane').forEach(p =>
    p.classList.toggle('active', p.dataset.pane === view));
  // Update hash so deep-links survive reloads.
  if (selectedId) location.hash = `${encodeURIComponent(selectedId)}/${view}`;
  // Lazy-load the view's content if we haven't yet for this bundle.
  if (!selectedId) return;
  if (viewLoaded[view]) return;
  if (view === 'analysis') loadAnalysis();
  else if (view === 'system') loadSystem();
  else if (view === 'files')  loadFiles();
}
document.querySelectorAll('.subtab').forEach(b => {
  b.addEventListener('click', () => setView(b.dataset.view));
});

// ---- Entry select: reset all panes, load the default view ----
function selectEntry(entry){
  if (activeEs) { activeEs.close(); activeEs = null; }
  selectedId = entry.id;
  // For running jobs there's no bundle yet; for finished/archived ones the
  // bundle name is the asset key the /bundles/<name>/... endpoints use.
  assetId = entry.bundle || entry.id;
  viewLoaded = {};
  selectedFile = null; bundleFiles = [];
  document.querySelectorAll('.log-entry').forEach(n =>
    n.classList.toggle('selected', n.dataset.id === entry.id));
  const { tc, when } = parseBundleName(entry.bundle || entry.id);
  $('#insp-title').textContent = tc + (when ? ` · ${when}` : '');
  $('#insp-actions').innerHTML = entry.kind === 'job'
    ? `<a class="btn-link" href="/jobs/${entry.id}/log" target="_blank">Raw log</a>`
    : `<a class="btn-link" href="/bundles/${encodeURIComponent(entry.id)}" download>↓ zip</a>`;
  // Reset every pane to placeholder, then load current view.
  ['analysis','system','files'].forEach(v => { viewLoaded[v] = false; });
  $('#ph-log').style.display = 'flex';     $('#log-text').style.display = 'none'; $('#log-text').innerHTML = '';
  $('#ph-analysis').style.display = 'flex';$('#analysis-content').style.display = 'none';
  $('#ph-system').style.display = 'flex';  $('#md-out').style.display = 'none';   $('#md-out').innerHTML = '';
  $('#file-tree').innerHTML = '<div class="empty">loading…</div>';
  $('#ph-file').style.display = 'flex';    $('#file-view').style.display = 'none'; $('#file-image').style.display = 'none';
  $('#fview-banner').style.display = 'none';
  $('#fview-title').textContent = 'No file selected';
  $('#fview-actions').innerHTML = '';
  // Always load Log immediately (it's the default view).
  loadLog(entry);
  // If a different view is active (URL hash), load that too.
  if (currentView !== 'log') {
    if (currentView === 'analysis') loadAnalysis();
    else if (currentView === 'system') loadSystem();
    else if (currentView === 'files') loadFiles();
  }
}

// ---- Log pane ----
function colorizeLog(line){
  if (/^COLLECTED/.test(line))      return 'ok';
  if (/^SKIPPED/.test(line))        return 'skip';
  if (/^FAILED/.test(line))         return 'fail';
  if (/^NOTE/.test(line))           return 'note';
  if (/^\[\d\d:\d\d:\d\d\]/.test(line)) return 'ts';
  return '';
}
function appendLogLine(line){
  const pre = $('#log-text');
  const span = document.createElement('span');
  const cls = colorizeLog(line);
  if (cls) span.className = cls;
  span.textContent = line + '\n';
  pre.appendChild(span);
  pre.scrollTop = pre.scrollHeight;
}
async function loadLog(entry){
  $('#ph-log').textContent = 'Loading…';
  if (entry.kind === 'job' && entry.state === 'running') {
    // Live SSE stream
    activeEs = new EventSource(`/jobs/${entry.id}/stream`);
    let started = false;
    activeEs.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.line !== undefined) {
        if (!started) {
          $('#log-text').style.display = 'block';
          $('#ph-log').style.display = 'none';
          started = true;
        }
        appendLogLine(m.line);
      }
      if (m.done) { activeEs.close(); activeEs = null; loadList(); }
    };
    activeEs.onerror = () => {
      if (activeEs && activeEs.readyState === EventSource.CLOSED) {
        activeEs = null; $('#ph-log').textContent = 'Stream closed.';
      }
    };
    return;
  }
  try {
    const r = await fetch('/logs/' + encodeURIComponent(entry.id) + '/raw', {cache:'no-store'});
    const text = await r.text();
    const pre = $('#log-text');
    pre.innerHTML = '';
    for (const line of text.split('\n')) {
      const span = document.createElement('span');
      const cls = colorizeLog(line);
      if (cls) span.className = cls;
      span.textContent = line + '\n';
      pre.appendChild(span);
    }
    pre.style.display = 'block';
    $('#ph-log').style.display = 'none';
  } catch (e) {
    $('#ph-log').textContent = '(failed to load log)';
  }
}

// ---- Analysis pane (friendly rows) ----
function parseAnalysis(text){
  const FINDING = /^\s*\[\s*(OK|WARN|FAIL|INFO)\s*\]\s+(\S.*?)\s{2,}(.+?)\s*$/i;
  const rows = []; const extras = [];
  let inFindings = false;
  for (const line of text.split('\n')) {
    const m = line.match(FINDING);
    if (m) { rows.push({status: m[1].toLowerCase(), area: m[2].trim(), note: m[3].trim()}); inFindings = true; continue; }
    if (inFindings && line.trim() && !/^=+$/.test(line) && !/Analysis summary/i.test(line)) {
      extras.push(line);
    }
  }
  return { rows, extras: extras.join('\n').trim() };
}
const STATUS_ICON = {ok:'✓', warn:'!', fail:'✕', info:'i'};
async function loadAnalysis(){
  if (!selectedId) return;
  viewLoaded.analysis = true;
  try {
    const r = await fetch('/bundles/' + encodeURIComponent(assetId) + '/analysis', {cache:'no-store'});
    const text = await r.text();
    if (!r.ok) { $('#ph-analysis').textContent = text || '(no ANALYSIS.md)'; return; }
    const { rows, extras } = parseAnalysis(text);
    if (!rows.length) {
      $('#ph-analysis').textContent = '(could not parse ANALYSIS.md — open raw via Files tab)'; return;
    }
    $('#an-rows').innerHTML = rows.map(r =>
      `<div class="an-row" data-status="${r.status}">
         <span class="an-icon">${STATUS_ICON[r.status]||'·'}</span>
         <span class="an-area">${escapeHtml(r.area)}</span>
         <span class="an-note">${escapeHtml(r.note)}</span>
       </div>`).join('');
    if (extras) {
      $('#an-extra').textContent = extras;
      $('#an-extra').style.display = 'block';
    } else { $('#an-extra').style.display = 'none'; }
    $('#analysis-content').style.display = 'block';
    $('#ph-analysis').style.display = 'none';
  } catch (e) { $('#ph-analysis').textContent = '(failed to load)'; }
}

// ---- System pane (markdown) ----
function renderInline(s){
  return s
    .replace(/`([^`]+?)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`)
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*_a-zA-Z0-9])\*([^*\n]+?)\*(?![*_a-zA-Z0-9])/g, '<em>$1</em>')
    .replace(/(?<![*_a-zA-Z0-9])_([^_\n]+?)_(?![*_a-zA-Z0-9])/g, '<em>$1</em>');
}
function renderMarkdown(src){
  const lines = src.split('\n'); const out = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i]; let m;
    if ((m = line.match(/^###\s+(.+)$/))) { out.push(`<h3>${renderInline(escapeHtml(m[1]))}</h3>`); i++; continue; }
    if ((m = line.match(/^##\s+(.+)$/)))  { out.push(`<h2>${renderInline(escapeHtml(m[1]))}</h2>`); i++; continue; }
    if ((m = line.match(/^#\s+(.+)$/)))   { out.push(`<h1>${renderInline(escapeHtml(m[1]))}</h1>`); i++; continue; }
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$/.test(lines[i+1])) {
      const splitRow = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const headers = splitRow(line); i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|')) { body.push(splitRow(lines[i])); i++; }
      const th = headers.map(h => `<th>${renderInline(escapeHtml(h))}</th>`).join('');
      const trs = body.map(row => '<tr>' + row.map(c => `<td>${renderInline(escapeHtml(c))}</td>`).join('') + '</tr>').join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|---)/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push(`<p>${renderInline(escapeHtml(para.join(' ')))}</p>`);
  }
  return out.join('\n');
}
async function loadSystem(){
  if (!selectedId) return;
  viewLoaded.system = true;
  try {
    const r = await fetch('/bundles/' + encodeURIComponent(assetId) + '/system', {cache:'no-store'});
    const text = await r.text();
    if (!r.ok) { $('#ph-system').textContent = text || '(no SYSTEM.md)'; return; }
    $('#md-out').innerHTML = renderMarkdown(text);
    $('#md-out').style.display = 'block';
    $('#ph-system').style.display = 'none';
  } catch (e) { $('#ph-system').textContent = '(failed to load)'; }
}

// ---- Files pane ----
async function loadFiles(){
  if (!selectedId) return;
  viewLoaded.files = true;
  try {
    const r = await fetch('/bundles/' + encodeURIComponent(assetId) + '/files', {cache:'no-store'});
    const data = await r.json();
    bundleFiles = data.files || [];
  } catch (e) { bundleFiles = []; }
  renderTree();
}
function groupFiles(arr){
  const groups = new Map();
  for (const f of arr) {
    const ix = f.path.indexOf('/');
    const head = ix < 0 ? '(root)' : f.path.slice(0, ix);
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(f);
  }
  for (const a of groups.values()) a.sort((x, y) => x.path.localeCompare(y.path));
  // Root-level files first (ANALYSIS.md / SYSTEM.md / <tc>.testcase.json),
  // then host folders alphabetically.
  return [...groups.entries()].sort(([a],[b]) =>
    a === '(root)' ? -1 : b === '(root)' ? 1 : a.localeCompare(b));
}
function renderTree(){
  const q = ($('#tree-search').value || '').toLowerCase().trim();
  const filtered = q ? bundleFiles.filter(f => f.path.toLowerCase().includes(q)) : bundleFiles;
  if (!filtered.length) { $('#file-tree').innerHTML = '<div class="empty">no files</div>'; return; }
  const groups = groupFiles(filtered);
  $('#file-tree').innerHTML = groups.map(([head, items]) => {
    // Always-open: root group + any group that contains the selected file +
    // any small group. Larger folders stay collapsed so the tree is scannable.
    const isRoot = head === '(root)';
    const open = (isRoot || items.length <= 8 || items.some(f => f.path === selectedFile)) ? 'open' : '';
    const label = isRoot ? 'bundle root' : `${head}/`;
    return `<div class="tree-group">
      <div class="tree-folder ${open}"><span>${label}</span><span class="count">${items.length}</span></div>
      <div class="tree-children">
        ${items.map(f => {
          const name = isRoot ? f.path : f.path.slice(head.length + 1);
          const sel = f.path === selectedFile ? ' selected' : '';
          // Star root .testcase.json so it visually pops — that's the
          // "download me, re-import elsewhere" file the team needs.
          const pin = (isRoot && /\.testcase\.json$/i.test(f.path)) ? ' ★ ' : '';
          return `<div class="tree-file${sel}" data-path="${f.path}" title="${f.path}">
            <span class="fname">${pin}${escapeHtml(name)}</span>
            <span class="size">${fmtBytes(f.size)}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
  $('#file-tree').querySelectorAll('.tree-folder').forEach(el =>
    el.addEventListener('click', () => el.classList.toggle('open')));
  $('#file-tree').querySelectorAll('.tree-file').forEach(el =>
    el.addEventListener('click', () => openFile(el.dataset.path)));
}
function colorizeFile(line){
  if (/\blevel=?\s*"?error"?|\bERROR\b|\bFAIL/i.test(line)) return 'err';
  if (/\blevel=?\s*"?warn"?|\bWARN/i.test(line)) return 'warn';
  if (/\blevel=?\s*"?info"?/i.test(line)) return 'info';
  if (/^\[?\d{4}-\d\d-\d\d|^\[\d\d:\d\d:\d\d\]/.test(line)) return 'ts';
  return '';
}
async function openFile(path){
  selectedFile = path;
  document.querySelectorAll('.tree-file').forEach(n =>
    n.classList.toggle('selected', n.dataset.path === path));
  $('#fview-title').textContent = path;
  $('#ph-file').style.display = 'flex'; $('#ph-file').textContent = 'Loading…';
  $('#file-view').style.display = 'none'; $('#file-image').style.display = 'none';
  $('#fview-banner').style.display = 'none';
  const url    = `/bundles/${encodeURIComponent(assetId)}/file?path=${encodeURIComponent(path)}`;
  const dlUrl  = `${url}&download=1`;
  // Two buttons: "Raw" opens inline (browser decides), "↓" forces a download
  // with the original filename (Content-Disposition: attachment).
  $('#fview-actions').innerHTML =
    `<a class="btn-link" href="${url}" target="_blank">Raw</a> ` +
    `<a class="btn-link" href="${dlUrl}" download>↓ Download</a>`;
  // Images: just point an <img> at the endpoint — browser handles decoding.
  // Click the thumbnail to open in the lightbox at native size + zoom.
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) {
    const img = $('#file-image');
    img.onload = () => { $('#ph-file').style.display = 'none'; img.style.display = 'block'; };
    img.onerror = () => { $('#ph-file').textContent = '(failed to load image)'; };
    img.src = url;
    img.onclick = () => openLightbox(path, url, dlUrl);
    return;
  }
  // Text: fetch and render.
  try {
    const r = await fetch(url, {cache:'no-store'});
    const text = await r.text();
    if (!r.ok) { $('#ph-file').textContent = text || 'failed'; return; }
    if (r.headers.get('X-Truncated') === 'true') {
      const total = +(r.headers.get('X-Total-Size') || 0);
      $('#fview-banner').textContent = `Showing last 500 KB · full file is ${fmtBytes(total)} (click ↓ Download for the rest)`;
      $('#fview-banner').style.display = 'block';
    }
    // JSON files often arrive as one long line (especially REST API dumps
    // like last_run.json). Try to pretty-print so it's actually readable;
    // fall back to the original text if parse fails.
    let body = text;
    if (/\.json$/i.test(path)) {
      try { body = JSON.stringify(JSON.parse(text), null, 2); }
      catch (_) { /* malformed JSON — show raw */ }
    }
    const lines = body.split('\n');
    const pre = $('#file-view');
    pre.innerHTML = '';
    const CAP = 3000;
    if (/\.(log|txt|md|conf|cfg|json|yaml|yml|csv)$/i.test(path) && lines.length <= CAP) {
      for (const line of lines) {
        const cls = colorizeFile(line);
        const span = document.createElement('span');
        if (cls) span.className = cls;
        span.textContent = line + '\n';
        pre.appendChild(span);
      }
    } else {
      pre.textContent = body;
      if (lines.length > CAP) {
        const prev = $('#fview-banner').textContent;
        const note = `${lines.length.toLocaleString()} lines — colorize off`;
        $('#fview-banner').textContent = prev ? `${prev} · ${note}` : note;
        $('#fview-banner').style.display = 'block';
      }
    }
    pre.style.display = 'block';
    $('#ph-file').style.display = 'none';
  } catch (e) {
    $('#ph-file').textContent = '(failed to load file)';
  }
}

// ---- Init: read hash, wire searches, kick off ----
function applyHash(){
  // Hash forms: #<bundle>, #<bundle>/<view>, #<bundle>/files?path=foo
  const raw = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  if (!raw) return;
  const [bundleAndView, queryPart] = raw.split('?');
  const slashAt = bundleAndView.indexOf('/');
  const bundleId = slashAt < 0 ? bundleAndView : bundleAndView.slice(0, slashAt);
  const view     = slashAt < 0 ? 'log' : bundleAndView.slice(slashAt + 1);
  currentView = ['log','analysis','system','files'].includes(view) ? view : 'log';
  // Update tab UI to match.
  document.querySelectorAll('.subtab').forEach(b =>
    b.classList.toggle('active', b.dataset.view === currentView));
  document.querySelectorAll('.pane').forEach(p =>
    p.classList.toggle('active', p.dataset.pane === currentView));
  // Stash bundleId + queryPart so loadList can act on them post-fetch.
  window.__hash_bundle = bundleId;
  window.__hash_query  = queryPart || '';
}
applyHash();

$('#search').addEventListener('input', renderList);
$('#tree-search').addEventListener('input', renderTree);

function findEntryByIdOrBundle(target){
  // Match either by the entry's own id OR by its bundle field — the bundle
  // is a stable name that survives across the job→archive transition.
  return entries.find(e => e.id === target || e.bundle === target);
}

(async function init(){
  await loadList();
  // Honour hash bundle if present.
  if (window.__hash_bundle) {
    const e = findEntryByIdOrBundle(window.__hash_bundle);
    if (e) selectEntry(e);
  }
  // Optional ?path=... for files view
  if (window.__hash_query) {
    const qp = new URLSearchParams(window.__hash_query);
    const p = qp.get('path');
    if (p && currentView === 'files') {
      // Wait for files to load then open it.
      setTimeout(() => openFile(p), 800);
    }
  }
})();

setInterval(loadList, 5000);

// ---- Image lightbox ----
function openLightbox(name, src, dlUrl){
  const lb  = $('#lightbox');
  const img = $('#lb-img');
  $('#lb-name').textContent = name;
  $('#lb-dl').href = dlUrl;
  img.dataset.mode = 'fit';
  $('#lb-toggle').textContent = '100%';
  img.src = src;
  lb.classList.add('open');
  lb.setAttribute('aria-hidden', 'false');
}
function closeLightbox(){
  const lb = $('#lightbox');
  lb.classList.remove('open');
  lb.setAttribute('aria-hidden', 'true');
  // Clear src so a stale image doesn't flash on next open
  $('#lb-img').removeAttribute('src');
}
function toggleLightboxZoom(){
  const img = $('#lb-img');
  const next = img.dataset.mode === 'fit' ? 'native' : 'fit';
  img.dataset.mode = next;
  $('#lb-toggle').textContent = next === 'fit' ? '100%' : 'Fit';
  // Reset scroll to top-left when switching to native — most useful starting point
  if (next === 'native') $('#lb-scroll').scrollTo(0, 0);
}
$('#lb-close').addEventListener('click', closeLightbox);
$('#lb-toggle').addEventListener('click', toggleLightboxZoom);
$('#lb-img').addEventListener('click', toggleLightboxZoom);
$('#lb-scroll').addEventListener('click', (e) => {
  // Clicking the gray padding (not the image itself) closes the box.
  if (e.target.id === 'lb-scroll') closeLightbox();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#lightbox').classList.contains('open')) closeLightbox();
});

// Hash navigation: react to deep-link changes without a full reload. Lets
// the "system" / "files" links from other places switch sub-tabs (and even
// swap the selected bundle) in-place.
window.addEventListener('hashchange', () => {
  applyHash();
  const targetBundle = window.__hash_bundle;
  if (targetBundle) {
    const e = findEntryByIdOrBundle(targetBundle);
    if (e && e.id !== selectedId) { selectEntry(e); return; }
  }
  // Same bundle, different view: just switch the view.
  if (currentView && currentView !== document.querySelector('.pane.active')?.dataset.pane) {
    setView(currentView);
  }
});

// ---- Self-update from GitHub ----
// Hits /api/update which downloads main.tar.gz from the oneclick repo,
// extracts it, runs sudo bash scripts/install.sh, restarts the service.
// The systemd restart kills our own process before the response returns,
// so we treat "fetch failed mid-stream" as expected and reload after a
// few seconds to pick up the new code.
async function runUpdate(){
  const btn  = document.getElementById('update-btn');
  const lbl  = document.getElementById('update-label');
  if (!btn) return;
  if (!confirm('Fetch the latest perf-qa from GitHub and re-install?\n\nThe service will restart. This usually takes 10–30 seconds.')) return;
  btn.disabled = true;
  btn.classList.add('spin');
  lbl.textContent = 'Updating…';
  let stillUp = true;
  try {
    const r = await fetch('/api/update', {method: 'POST', cache: 'no-store'});
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) {
      lbl.textContent = 'Updated — reloading';
    } else {
      stillUp = false;
      const tail = (j && j.log) ? '\n\nLast log lines:\n' + j.log.split('\n').slice(-15).join('\n') : '';
      lbl.textContent = 'Update failed';
      alert('Update failed.' + tail);
    }
  } catch (e) {
    // Most common case — the service restarted before our response came back.
    // That's actually success; reload to pick up the new code.
    lbl.textContent = 'Restarting — reloading';
  }
  if (stillUp) {
    setTimeout(() => { location.reload(); }, 4000);
  } else {
    btn.disabled = false;
    btn.classList.remove('spin');
  }
}

// ---- Cross-tab running-job indicator ----
(function(){
  const ind  = document.getElementById('run-indicator');
  const tcEl = document.getElementById('ri-tc');
  if (!ind || !tcEl) return;
  async function poll(){
    try {
      const r = await fetch('/api/logs', {cache:'no-store'});
      const items = await r.json();
      const running = items.find(i => i.kind === 'job' && i.state === 'running');
      if (running) {
        tcEl.textContent = running.test_case || running.id;
        ind.style.display = 'inline-flex';
      } else { ind.style.display = 'none'; }
    } catch (_) {}
  }
  poll(); setInterval(poll, 3000);
})();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, threaded=True, debug=False)

# perf-qa

One-click diagnostics collector for a Simnovator perf-test run. SSHes to the rack hosts (UE / Simnovator / Callbox / app-server), time-windows everything to the resolved test iteration, and packages a `<testcase>_diagnostics_<TS>.zip`. Auto-generates `ANALYSIS.md` (per-area status + deep checks) and `SYSTEM.md` (cross-host inventory).

Ships a Flask UI on port **8080** with a Collector / Logs / System / Files inspector + the importable testcase JSON pulled via the Simnovator REST API.

## Layout

```
perf-qa/
├── INSTALL.md                  full install guide (start here for a new site)
├── README.md                   this file
├── collect_perf_data.sh        bash collector — main entry point
├── analyze_bundle.py           post-collection heuristics → ANALYSIS.md
├── build_system_md.py          cross-host inventory → SYSTEM.md
├── beszel_screenshot.py        Playwright capture for the Beszel dashboard (optional)
├── simnovator_screenshot.py    Playwright capture for the Simnovator GUI tabs (optional)
├── setup.conf.example          copy to setup.conf and fill in IPs + creds
└── ui/
    ├── app.py                  Flask UI (Collector + Logs / System / Files / Setup tabs)
    ├── perf-qa-ui.service      systemd unit (PERFQA_PORT=8080 by default)
    ├── favicon.png
    ├── logo_light.svg
    └── logo_dark.svg
```

## Install at a customer site

See **`INSTALL.md`** for the full step-by-step. Short version:

```bash
tar xzf perf-qa-customer.tar.gz
cd perf-qa
# 1. Lay down files at /opt/perf-qa{,-ui} + bundle dir at /var/lib/perf-qa/bundles
# 2. Make a Python venv for the UI + install Flask + Playwright
# 3. Copy setup.conf.example → /opt/perf-qa/setup.conf, fill in IPs/creds
# 4. sudo systemctl enable --now perf-qa-ui
# 5. open http://<collector-host>:8080/
```

## What's in a bundle

```
<testcase>_diagnostics_<YYYYMMDD_HHMMSS>.zip   (~2-5 MB)
├── ANALYSIS.md            per-area status + cross-host + perf-tuning checks
├── SYSTEM.md              cross-host inventory (CPU / RAM / kernel / SDR / iperf3 ver)
├── <testcase>.testcase.json   re-importable via POST /v2/testcases/import
├── MANIFEST.txt + collect.log
├── ue/        system + cpu + net + UESIM logs + iperf logs + heat CSVs
├── simnovator/  container ps + stats + per-container logs (stdout + app log files) + Beszel screenshot
├── callbox/   enb/mme/ims.cfg + sensors + amari monitor + heat CSVs
├── app_server/ network info
└── rest_api/  test definition + statistics + logs export + GUI screenshots
```

## CLI use

The UI is the easy path, but the collector can be invoked directly:

```bash
/opt/perf-qa/collect_perf_data.sh /opt/perf-qa/setup.conf
# → /var/lib/perf-qa/bundles/<testcase>_diagnostics_<TS>.zip
```

# perf-qa

One-click diagnostics collector for a Simnovator perf-test run. SSHes to UE / Simnovator / Callbox / app-server, time-windows everything to the resolved test iteration, and packages the bundle as `<testcase>_diagnostics_<TS>.zip`. Auto-generates `ANALYSIS.md` (per-area status + deep checks) and `SYSTEM.md` (cross-host inventory).

Reachable from the simqa UI as the **Perf QA** tab → embeds the live Flask UI running on the QA collector host.

## Layout

```
perf-qa/
├── collect_perf_data.sh        bash collector — main entry point
├── analyze_bundle.py           post-collection heuristics → ANALYSIS.md
├── build_system_md.py          cross-host inventory → SYSTEM.md
├── beszel_screenshot.py        Playwright capture for the Beszel dashboard
├── simnovator_screenshot.py    Playwright capture for the Simnovator GUI tabs
├── setup.conf.example          copy to setup.conf and fill in creds
└── ui/
    ├── app.py                  Flask UI (Collector + Logs/System/Files tabs)
    ├── perf-qa-ui.service      systemd unit
    ├── profiles.json.example   copy to profiles.json (host IPs + creds)
    ├── favicon.png
    ├── logo_light.svg
    └── logo_dark.svg
```

## Local setup

```bash
# 1. Configure
cp setup.conf.example         setup.conf
cp ui/profiles.json.example   ui/profiles.json
# fill in CALLBOX_PASS, SIM_API_PASS, BESZEL_PASS in both files

# 2. Run the collector directly (CLI)
bash collect_perf_data.sh

# 3. Or run the Flask UI locally
python3 -m venv venv && source venv/bin/activate
pip install flask playwright
python ui/app.py    # listens on :4000
```

## Deploy (QA collector host — currently 192.168.1.36)

```bash
# Files live under /home/sysadmin/perf-qa/ + /home/sysadmin/perf-qa-ui/
scp collect_perf_data.sh analyze_bundle.py build_system_md.py \
    beszel_screenshot.py simnovator_screenshot.py setup.conf \
    sysadmin@192.168.1.36:/home/sysadmin/perf-qa/
scp ui/app.py ui/profiles.json sysadmin@192.168.1.36:/home/sysadmin/perf-qa-ui/
ssh sysadmin@192.168.1.36 'sudo systemctl restart perf-qa-ui'
```

Open <http://192.168.1.36:4000> — or use the **Perf QA** tab inside simqa, which iframes the same URL.

## What's in a bundle

```
<testcase>_diagnostics_<YYYYMMDD_HHMMSS>.zip   (~2-5 MB)
├── ANALYSIS.md            per-area status + cross-host + perf-tuning checks
├── SYSTEM.md              cross-host inventory (CPU/RAM/kernel/SDR/iperf3 ver)
├── <testcase>.testcase.json   re-importable via POST /v2/testcases/import
├── MANIFEST.txt + collect.log
├── ue/        system + cpu + net + UESIM logs + iperf logs + heat CSVs
├── simnovator/  container ps + stats + per-container logs (stdout + app log files) + Beszel screenshot
├── callbox/   enb/mme/ims.cfg + sensors + amari monitor + heat CSVs
├── app_server/ network info
└── rest_api/  test definition + statistics + logs export + GUI screenshots
```

## Reference

Confluence runbook: [Collecting performance data](https://simnovus.atlassian.net/wiki/x/AgCeU)

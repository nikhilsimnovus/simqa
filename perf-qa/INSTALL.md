# perf-qa — install at a customer site

One-click diagnostics collector for a Simnovator perf-test run. SSHes to the rack hosts (UE / Simnovator / Callbox / app-server), time-windows everything to the resolved test iteration, packages a `<testcase>_diagnostics_<TS>.zip`, and auto-generates `ANALYSIS.md` + `SYSTEM.md`. Ships a Flask UI on port **8080**.

This collector runs on a Linux box at the customer site. The box only needs SSH reachability to the lab hosts — perf-qa itself doesn't live on any of those.

## Quick install (one-shot)

After extracting the tarball:

```bash
tar xzf perf-qa-deploy-*.tar.gz
cd perf-qa
sudo bash scripts/install.sh
```

The installer:

1. **Detects** Ubuntu/Debian (apt) or RHEL/CentOS (dnf/yum).
2. **Installs prereqs**: bash, python3, ssh, sshpass, curl, jq, zip, tar, unzip.
3. **Creates** the `perfqa` system user + dirs under `/opt/` and `/var/lib/`.
4. **Copies** all scripts + Flask UI into the FHS layout below.
5. **Builds** the Python venv with Flask + Playwright (downloads headless Chromium, ~150 MB, one-shot).
6. **Generates** the systemd unit pointing at port 8080.
7. **Starts** the service.

Idempotent — safe to re-run (preserves existing `setup.conf` + Playwright cache).

Override the listen port (default 8080) by exporting `PERFQA_PORT` before running, e.g. `sudo PERFQA_PORT=9090 bash scripts/install.sh`.

## Install layout

```
/opt/perf-qa            ← bash collector + python analyzers + setup.conf
/opt/perf-qa-ui         ← Flask UI app + its venv (Flask + Playwright Chromium)
/var/lib/perf-qa/bundles ← collected bundles get written here
/var/lib/perfqa         ← home dir of the perfqa service user
/etc/systemd/system/perf-qa-ui.service
```

## After install — configure the rack

Either:

1. **Use the Setup tab in the web UI** (recommended) — drives `profiles.json` automatically.
2. **Edit `/opt/perf-qa/setup.conf`** directly.

Fill in:

* Host IPs: `UE_HOST`, `SIMNOVATOR_HOST`, `CALLBOX_HOST`, `APP_SERVER_HOST`, `BESZEL_HUB_URL` (any can be blank to skip that section).
* SSH user per host (`UE_USER`, `SIMNOVATOR_USER`, etc.) — leave password blank if the collector host has key-based SSH set up (recommended; only the Amarisoft callbox usually needs `CALLBOX_PASS`).
* Simnovator API admin credentials (`SIM_API_USER` / `SIM_API_PASS`).
* Optional Beszel read-only viewer (`BESZEL_USER` / `BESZEL_PASS`) — only needed if `BESZEL_HUB_URL` is set.

If the collector host uses key-based SSH, generate + push its key:

```bash
sudo -u perfqa ssh-keygen -t ed25519 -N "" -f /var/lib/perfqa/.ssh/id_ed25519
sudo -u perfqa ssh-copy-id -i /var/lib/perfqa/.ssh/id_ed25519.pub <user>@<ue-host>
# repeat for simnovator + app-server hosts
```

## Use

Open `http://<collector-host>:8080/` in a browser.

* **Collector** tab → pick a profile, hit Run, watch the live progress.
* **Logs** tab → list of past runs; click one to inspect `collect.log`, `ANALYSIS.md`, `SYSTEM.md`, or browse the bundle files (with image preview + JSON pretty-print).
* **Setup** tab → manage profiles (host IPs + creds).

## Run from CLI

The UI is the easy path, but the bash collector can be invoked directly:

```bash
sudo -u perfqa /opt/perf-qa/collect_perf_data.sh /opt/perf-qa/setup.conf
# → /var/lib/perf-qa/bundles/<testcase>_diagnostics_<TS>.zip
```

## What's in a bundle

```
<testcase>_diagnostics_<YYYYMMDD_HHMMSS>.zip   (~2-5 MB)
├── ANALYSIS.md            per-area status + cross-host + perf-tuning checks
├── SYSTEM.md              cross-host inventory (CPU / RAM / kernel / SDR / iperf3 ver)
├── <testcase>.testcase.json   re-importable via POST /v2/testcases/import
├── MANIFEST.txt + collect.log
├── ue/        system + cpu + net + UESIM logs + iperf logs + heat CSVs
├── simnovator/ container ps + stats + per-container logs (stdout + app log files) + Beszel screenshot
├── callbox/   enb/mme/ims.cfg + sensors + amari monitor + heat CSVs
├── app_server/ network info
└── rest_api/  test definition + statistics + logs export + GUI screenshots
```

## Tuning + thresholds

Analyzer thresholds live at the top of `/opt/perf-qa/analyze_bundle.py`:

```python
SDR_FPGA_WARN, SDR_FPGA_FAIL = 70.0, 75.0   # °C
SDR_RFIC_WARN, SDR_RFIC_FAIL = 75.0, 80.0   # °C
CPU_WARN,      CPU_FAIL      = 75.0, 90.0   # °C
```

Edit + restart the service to pick up changes:

```bash
sudo systemctl restart perf-qa-ui
```

## Uninstall

```bash
sudo systemctl disable --now perf-qa-ui
sudo rm -f /etc/systemd/system/perf-qa-ui.service
sudo rm -rf /opt/perf-qa /opt/perf-qa-ui /var/lib/perf-qa /var/lib/perfqa
sudo userdel perfqa
sudo systemctl daemon-reload
```

## Troubleshooting

### Corporate SSL-inspecting proxy (Zscaler / Palo Alto / Fortinet / etc.)

If you see `SSL: CERTIFICATE_VERIFY_FAILED` from `pip` or `playwright install` during the installer, the customer network has a TLS-inspecting proxy that injects a self-signed certificate. The installer **auto-falls-back** to `--trusted-host` for pip (so the install completes), but for a permanent + secure fix point both tools at the customer's enterprise CA bundle and re-run:

```bash
# Find the customer's CA bundle — typical locations:
ls /etc/pki/ca-trust/source/anchors/        # RHEL/CentOS
ls /usr/local/share/ca-certificates/        # Debian/Ubuntu
ls /etc/ssl/certs/ca-certificates.crt       # combined Debian/Ubuntu bundle
ls /etc/pki/tls/certs/ca-bundle.crt         # combined RHEL/CentOS bundle

# Export before re-running install.sh:
sudo PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
     NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
     bash scripts/install.sh
```

Other env vars the installer respects (set any/all before running):

* `PIP_INDEX_URL=https://pypi.internal.customer.com/simple/` — use an internal PyPI mirror.
* `PIP_TRUSTED_HOST=pypi.internal.customer.com` — skip TLS verify for that host.
* `HTTP_PROXY=http://proxy.customer.com:8080` + `HTTPS_PROXY=...` — for outbound HTTPS via corporate proxy.
* `SKIP_PLAYWRIGHT=1` — skip the headless-Chromium download entirely (Beszel + Simnovator GUI screenshots will be disabled; everything else works).

### Other issues

| Symptom | Check |
|---|---|
| Service won't start | `journalctl -u perf-qa-ui -n 50` |
| Port 8080 in use | `sudo PERFQA_PORT=9090 bash scripts/install.sh` (or edit `/etc/systemd/system/perf-qa-ui.service`) |
| `Connectivity: unreachable` from the UI | `ssh perfqa@<host>` confirm key auth; check `setup.conf` IPs |
| Beszel screenshot fails | `BESZEL_HUB_URL` set + viewer creds correct; check `/var/lib/perfqa/.cache/ms-playwright/` is populated |
| Heat CSVs empty | heat-monitor service running on the rack host: `ssh ... systemctl is-active heat-monitor` |
| `playwright install chromium FAILED` | Re-run with `NODE_EXTRA_CA_CERTS=<bundle>` (see SSL section above) — or `SKIP_PLAYWRIGHT=1` to skip browsers entirely |

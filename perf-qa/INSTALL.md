# perf-qa — install at a customer site

One-click diagnostics collector for a Simnovator perf-test run. SSHes to UE / Simnovator / Callbox / app-server, time-windows everything to the resolved test iteration, packages a `<testcase>_diagnostics_<TS>.zip`, and auto-generates `ANALYSIS.md` + `SYSTEM.md`. Ships a Flask UI on port **8080**.

This guide installs perf-qa on a Linux box at the customer site. The box only needs SSH reachability to the lab hosts (UE / Simnovator / Callbox / app-server) — perf-qa itself doesn't live on any of those.

## 1. Prerequisites

On the collector host:

```bash
sudo apt-get install -y \
  bash python3 python3-venv \
  ssh sshpass curl jq zip tar unzip \
  ca-certificates
```

Optional (only if you want Playwright-based GUI screenshots — Simnovator UI tabs + Beszel dashboard):

```bash
# The Flask UI installs Playwright into its venv; the browser binaries
# need to be downloaded once after the venv is created (step 4 below).
```

On the **callbox**, since Amarisoft typically uses password SSH:

```bash
# install sshpass on the collector host (already above) — nothing on the callbox.
```

## 2. Lay down the install

Suggested FHS-aligned layout (matches the shipped `perf-qa-ui.service`):

```
/opt/perf-qa            ← bash collector + python analyzers + setup.conf
/opt/perf-qa-ui         ← Flask UI app + its venv
/var/lib/perf-qa/bundles ← collected bundles get written here
```

Create the user + dirs:

```bash
sudo useradd --system --create-home --home /var/lib/perfqa --shell /bin/bash perfqa
sudo mkdir -p /opt/perf-qa /opt/perf-qa-ui /var/lib/perf-qa/bundles
sudo chown -R perfqa:perfqa /opt/perf-qa /opt/perf-qa-ui /var/lib/perf-qa
```

## 3. Drop the files

Extract the tarball you received (`perf-qa-customer.tar.gz`) and install:

```bash
tar xzf perf-qa-customer.tar.gz
cd perf-qa

# Collector + analyzers go under /opt/perf-qa
sudo install -m 0755 -o perfqa -g perfqa \
  collect_perf_data.sh analyze_bundle.py build_system_md.py \
  beszel_screenshot.py simnovator_screenshot.py \
  /opt/perf-qa/

# Seed setup.conf from the example
sudo install -m 0640 -o perfqa -g perfqa setup.conf.example /opt/perf-qa/setup.conf

# UI app + assets go under /opt/perf-qa-ui
sudo install -m 0644 -o perfqa -g perfqa ui/app.py ui/favicon.png ui/logo_light.svg ui/logo_dark.svg /opt/perf-qa-ui/

# systemd unit
sudo install -m 0644 ui/perf-qa-ui.service /etc/systemd/system/
sudo systemctl daemon-reload
```

## 4. Create the Python venv (for the Flask UI + Playwright)

```bash
sudo -u perfqa python3 -m venv /opt/perf-qa-ui/venv
sudo -u perfqa /opt/perf-qa-ui/venv/bin/pip install --upgrade pip
sudo -u perfqa /opt/perf-qa-ui/venv/bin/pip install flask playwright
# Download the headless Chromium that Playwright drives:
sudo -u perfqa /opt/perf-qa-ui/venv/bin/playwright install chromium
sudo /opt/perf-qa-ui/venv/bin/playwright install-deps chromium   # one-shot apt install of headless-Chromium libs
```

## 5. Configure the rack

Two places hold per-rack configuration, in this order of preference:

1. **Setup tab in the web UI** (the easy way) — drives `profiles.json` automatically.
2. **`/opt/perf-qa/setup.conf`** — the bash collector reads this directly when invoked from the CLI.

Fill in:

* Host IPs: `UE_HOST`, `SIMNOVATOR_HOST`, `CALLBOX_HOST`, `APP_SERVER_HOST`, `BESZEL_HUB_URL` (any can be blank to skip that section).
* SSH user per host (`UE_USER`, `SIMNOVATOR_USER`, etc.) — leave password blank if the collector host can SSH using a key (recommended; only the Amarisoft callbox usually needs `CALLBOX_PASS`).
* Simnovator API admin credentials (`SIM_API_USER` / `SIM_API_PASS`).
* Optional Beszel read-only viewer (`BESZEL_USER` / `BESZEL_PASS`) — only needed if `BESZEL_HUB_URL` is set.

If the collector host uses key-based SSH, copy its public key onto each rack host:

```bash
sudo -u perfqa ssh-keygen -t ed25519 -N "" -f /var/lib/perfqa/.ssh/id_ed25519
sudo -u perfqa ssh-copy-id -i /var/lib/perfqa/.ssh/id_ed25519.pub <user>@<ue-host>
# repeat for simnovator + app-server hosts
```

## 6. Start the UI

```bash
sudo systemctl enable --now perf-qa-ui
sudo systemctl status perf-qa-ui --no-pager
```

Open `http://<collector-host>:8080/` in a browser. Walk through Setup → Collector → Run.

## 7. Run a collection from the CLI (optional)

The UI is the easy path, but `collect_perf_data.sh` can be invoked directly:

```bash
sudo -u perfqa /opt/perf-qa/collect_perf_data.sh /opt/perf-qa/setup.conf
# Output: /var/lib/perf-qa/bundles/<testcase>_diagnostics_<TS>.zip
```

## Verify a bundle

After a run, the bundle structure looks like:

```
<testcase>_diagnostics_<YYYYMMDD_HHMMSS>.zip   (~2-5 MB)
├── ANALYSIS.md            per-area status + cross-host + perf-tuning checks
├── SYSTEM.md              cross-host inventory (CPU / RAM / kernel / SDR / iperf3 ver)
├── <testcase>.testcase.json  re-importable via POST /v2/testcases/import
├── MANIFEST.txt + collect.log
├── ue/        system + cpu + net + UESIM logs + iperf logs + heat CSVs
├── simnovator/ container ps + stats + per-container logs (stdout + app log files) + Beszel screenshot
├── callbox/   enb/mme/ims.cfg + sensors + amari monitor + heat CSVs
├── app_server/ network info
└── rest_api/  test definition + statistics + logs export + GUI screenshots
```

## Tuning + thresholds

Analyzer thresholds live at the top of `analyze_bundle.py`:

```python
SDR_FPGA_WARN, SDR_FPGA_FAIL = 70.0, 75.0   # °C
SDR_RFIC_WARN, SDR_RFIC_FAIL = 75.0, 80.0   # °C
CPU_WARN,      CPU_FAIL      = 75.0, 90.0   # °C
```

Edit + restart `perf-qa-ui` to pick up changes (the bash collector picks them up immediately on next run).

## Uninstall

```bash
sudo systemctl disable --now perf-qa-ui
sudo rm -f /etc/systemd/system/perf-qa-ui.service
sudo rm -rf /opt/perf-qa /opt/perf-qa-ui /var/lib/perf-qa
sudo userdel perfqa
sudo systemctl daemon-reload
```

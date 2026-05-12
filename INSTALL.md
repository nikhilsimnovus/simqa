# Installing QA Ka BAAP

Works on **Windows 10/11, Linux, and macOS**. Only prerequisite is **Node 18 or newer**.

## TL;DR

```bash
tar -zxvf qakabaap-<version>.tar.gz
cd qakabaap-<version>
node install.cjs
```

Then edit `inventory.yaml` and run `npm run dev` — open http://localhost:4000.

**At a customer site behind a firewall?** Use the minimal install:

```bash
node install.cjs --skip-playwright --port 8080
```

That skips the ~150 MB Chromium download (uses system Chrome / Edge at runtime if available) and runs on port 8080 instead of 4000.

## Step by step

### 1. Prerequisites

| OS | How to get Node 18+ |
|----|---------------------|
| **Windows** | Download the LTS installer from <https://nodejs.org/> |
| **Ubuntu / Debian** | `curl -fsSL https://deb.nodesource.com/setup_lts.x \| sudo -E bash -` then `sudo apt install -y nodejs` |
| **RHEL / CentOS** | `curl -fsSL https://rpm.nodesource.com/setup_lts.x \| sudo -E bash -` then `sudo yum install -y nodejs` |
| **macOS** | `brew install node` |

Verify:
```bash
node --version    # need v18.0.0 or higher
```

### 2. Extract the release tarball

```bash
tar -zxvf qakabaap-<version>.tar.gz
cd qakabaap-<version>
```

> On Windows you can use the built-in `tar` from PowerShell or Command Prompt — same `tar -zxvf` works since Windows 10 1803.

### 3. Run the installer

```bash
node install.cjs
```

Flags you might need:

| Flag | When to use |
|------|-------------|
| `--skip-playwright` | Chromium download is blocked at your site. App falls back to system Chrome/Edge at runtime — see [Features without Chromium](#features-without-chromium) below. |
| `--port <n>` | Default port 4000 is firewalled or busy. Writes `.env.local` so subsequent `npm run dev` / `start` use the new port. |
| `--no-prompt` | Non-interactive install (CI / scripted). |

What it does:

1. Verify Node 18+
2. `npm install` (~200 MB of npm packages)
3. `npx playwright install chromium` (~150 MB) — **skippable**
4. Set the default port (writes `.env.local` if `--port` given)
5. Copy `inventory.example.yaml` → `inventory.yaml` if you don't have one

### 4. Edit `inventory.yaml`

Open `inventory.yaml` and add at least one Simnovator system:

```yaml
systems:
  - id: simnovator-vm
    type: SIMNOVATOR
    name: Lab Simnovator VM
    host: 192.168.10.128         # your VM's IP
    cockpitUser: simnovus        # defaults to simnovus
    cockpitPassword: admin@123   # defaults to admin@123
    cockpitPort: 9090
```

Add Callbox, UESIM, App Server entries the same way — see `inventory.example.yaml` for the full schema, including the SSH credential fields a UESIM needs for the **Tools → UE-sim cfg patcher** feature.

### 5. Start

Development mode (auto-reloads on code changes):
```bash
npm run dev
```

Production mode (faster, no hot reload):
```bash
npm run build
npm run start
```

Default URL: **http://localhost:4000** (or whatever port you set).

## Choosing a different port

If port 4000 is firewalled at your site (common at customer locations), pick a different one. Four ways, in order of permanence:

| Where | How | When to use |
|-------|-----|-------------|
| One-off flag | `npm run dev -- -p 8080` | Quick test |
| Environment variable | `PORT=8080 npm run dev` (Linux/macOS) <br> `$env:PORT=8080; npm run dev` (PowerShell) <br> `set PORT=8080 && npm run dev` (cmd.exe) | Per-session |
| `.env.local` file | Add `PORT=8080` to `.env.local` in the install dir | Persistent for this checkout |
| Re-run installer | `node install.cjs --port 8080` | Persistent (writes `.env.local` for you) |

The wrapper `scripts/run.cjs` reads `PORT` from env (default 4000) and starts Next on that port. Any `-p` flag passed via `npm run dev -- -p N` overrides it.

## Features without Chromium

simqa uses Playwright Chromium for two features. The other ~70% of the app is pure HTTP / SSH and needs no browser.

| Feature | Needs browser? | Works if Chromium skipped? |
|---------|----------------|----------------------------|
| **Build Check** (Cockpit terminal automation) | ✅ yes | ✅ if system Chrome or Edge is installed |
| **UI Tests** (drives Simnovator web UI) | ✅ yes | ✅ if system Chrome or Edge is installed |
| API Tests | ❌ no | ✅ always |
| Tools (UE-sim cfg patcher) | ❌ no (SSH only) | ✅ always |
| Test Cases / Inventory / Systems Mgmt | ❌ no | ✅ always |
| Runs / Settings / Dashboard | ❌ no | ✅ always |

Runtime browser fallback chain inside the app:

1. System **Chrome** (`channel: 'chrome'`) — usually present on Windows
2. System **Edge** (`channel: 'msedge'`) — present on Windows 10+ by default
3. Bundled **Chromium** (skipped if `--skip-playwright`)
4. Bundled **Firefox**

So on a Windows customer box, you almost never need the bundled Chromium download — system Edge handles it.

**Why don't we bundle Chromium in the tarball?** It's ~150 MB and OS-specific (separate binaries for Windows/Linux/macOS, each architecture). The tarball today is 1.3 MB — bundling Chromium would balloon it 100×, ship three OS variants, and still get out-of-date. Better to use system Chrome/Edge (always patched) or download fresh.

## Smoke test

1. Sidebar should show the QA Ka BAAP mascot + nav entries (Dashboard, Test Cases, Automation, Build Check, End to End, API Tests, UI Tests, Systems Mgmt, **Tools**, Runs, Settings)
2. **Systems Mgmt** — your Simnovator system should be listed
3. **API Tests** — clicking Run should fire requests (no browser needed, smoke test for the install)
4. **Tools** — pick a UESIM box, see status panel (only works if SSH creds are in inventory.yaml)
5. **Build Check** — picking the system should populate the install plan (smoke test for browser launch)

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Node 18+ required` | Upgrade Node — see prereqs table above |
| `npm install` hangs | Check corporate proxy: `npm config set proxy http://your-proxy:port` |
| Playwright Chromium download blocked | Re-run with `--skip-playwright`. Make sure system Chrome or Edge is installed for Build Check + UI Tests. |
| Port 4000 already in use / blocked | See [Choosing a different port](#choosing-a-different-port) above. |
| Build Check fails with "could not launch any browser" | Install Chrome or Edge on the simqa host, OR rerun `node install.cjs` without `--skip-playwright` |
| Cockpit Terminal can't be reached during Build Check | Verify the Simnovator VM is reachable: `curl -k https://<host>:9090/` should return HTTP 200 |
| Tools → UE-sim patcher: system shows "missing: password" | Add SSH credentials to the UESIM entry in `inventory.yaml` — see `inventory.example.yaml` for the schema |
| "Jest worker encountered N child process exceptions" during `npm run dev` | Long-lived Next.js dev server memory leak. Ctrl+C, `rm -rf .next`, `npm run dev` again. |

## Updating

Drop a newer tarball alongside the old install dir, extract, `node install.cjs`. Your `inventory.yaml` and `.env.local` are preserved (the installer never overwrites them).

For git-based installs: `git pull && npm install`.

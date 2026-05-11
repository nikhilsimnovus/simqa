# Installing QA Ka BAAP

Works on **Windows 10/11, Linux, and macOS**. Only prerequisite is **Node 18 or newer**.

## TL;DR

```bash
tar -zxvf qakabaap-<version>.tar.gz
cd qakabaap-<version>
node install.cjs
```

Then edit `inventory.yaml` and run `npm run dev` — open http://localhost:4000.

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

This will:
1. Verify Node 18+
2. `npm install` (downloads ~200 MB of npm packages)
3. `npx playwright install chromium` (downloads ~150 MB Chromium for Build Check + UI Tests)
4. Copy `inventory.example.yaml` → `inventory.yaml` if you don't have one yet

If you're behind a corporate firewall and the Playwright Chromium download fails, re-run with `--skip-playwright`:
```bash
node install.cjs --skip-playwright
```
The app will then fall back to system Chrome / Edge at runtime.

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

Add Callbox, UESIM, App Server entries the same way — see `inventory.example.yaml` for the full schema.

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

Either way, open **http://localhost:4000** in your browser.

## Smoke test

1. Sidebar should show the QA Ka BAAP mascot + nav entries
2. **Systems Mgmt** — your Simnovator system should be listed
3. **Build Check** — picking the system should populate the install plan
4. **End to End** — you should be able to create a QA Test Setup

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Node 18+ required` | Upgrade Node — see prereqs table above |
| `npm install` hangs | Check corporate proxy: `npm config set proxy http://your-proxy:port` |
| Playwright download blocked | Re-run with `--skip-playwright` and rely on system Chrome |
| Port 4000 already in use | Edit `package.json` → `"dev"` and `"start"` scripts, change `-p 4000` to another port |
| Cockpit Terminal can't be reached during Build Check | Verify the Simnovator VM is reachable: `curl -k https://<host>:9090/` should return HTTP 200 |

## Updating

Drop a newer tarball alongside the old install dir, extract, `node install.cjs`. Your `inventory.yaml` is preserved (the installer never overwrites an existing one).

For git-based installs, just `git pull && npm install`.

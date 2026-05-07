# QA Ka BAAP

Automated QA tooling for the Simnovator UESIM product. A Next.js web app that
covers the full lifecycle: install a build, validate it, drive the UI through
hundreds of regression tests, hammer the REST API, run end-to-end test setups,
and surface results.

```
┌────────────────────────────────────────────────────────────────────┐
│  Build Check        End to End           UI Tests / API Tests     │
│  ───────────        ──────────           ──────────────────────   │
│  Install a new  →   Bind systems    →    Run a 350+ test          │
│  build via          into named QA        Playwright / API         │
│  Cockpit            test setups          regression suite         │
│  Terminal                                                          │
└────────────────────────────────────────────────────────────────────┘
```

---

## What this gives you

| Page | What it does |
|------|--------------|
| **Dashboard** | Run shortcuts + recent run summary |
| **Test Cases** | Browse and import Simnovator testcases |
| **Automation** | Save named test suites and run them as a batch |
| **Build Check** | Generate a Cockpit Terminal install plan for a fresh build, then run a checklist of REST + UI smoke checks against the box |
| **End to End** | Build "QA Test Setups" — bind a Simnovator + UESIM + Callbox + IMS/MME/AppServer into one named topology |
| **API Tests** | REST API regression suite (login, listings, exports, round-trips) |
| **UI Tests** | Playwright-driven UI regression suite — auth, navigation, testcases, statistics, logs, security, error handling, perf, compat, plus 90+ field-band validation tests |
| **Inventory** | The systems + topology profiles backing everything else |
| **Runs** | History of every run, with traces / screenshots / network logs |

The UI tests record video + a Playwright trace zip on failure. Open a trace at
[trace.playwright.dev](https://trace.playwright.dev) for a frame-by-frame replay
with the DOM and network panel.

---

## Stack

- **Next.js 15** + React 19 (app router)
- **Tailwind CSS 3** with a custom token set
- **Playwright** for UI regression + browser automation
- **node-ssh** + the host's own ssh (only used for non-Simnovator deploy
  targets — Simnovator installs go through Cockpit)
- **YAML** for inventory + topology persistence
- Pure-TypeScript runtime, no external services required

---

## Getting started

Requires Node 18+ and a modern browser.

```bash
# 1. Install deps
npm install

# 2. Pull Playwright's bundled Chromium (needed for UI tests)
npx playwright install chromium

# 3. Copy the inventory template and fill in your lab boxes
cp inventory.example.yaml inventory.yaml
# edit inventory.yaml — at minimum add one SIMNOVATOR system

# 4. Run the dev server
npm run dev

# Open http://localhost:4000
```

The first time you visit the UI, head to **Inventory** and add at least one
system marked **Simnovator** (the VM that runs the product). Then go to
**End to End** and create a QA Test Setup binding it together with a UESIM
+ Callbox + your other roles.

---

## Build Check workflow

```
1. Inventory      → mark a system as Simnovator (Cockpit creds default
                    to simnovus / admin@123, editable)
2. Build Check    → paste a build URL, click Test URL to confirm it's
                    reachable from this machine
3. Build Check    → click "Open Cockpit Terminal" (deep-links to the
                    Simnovator VM's Cockpit Terminal)
4. Cockpit        → log in, paste the 3 generated command blocks:
                       cd /tmp && wget "<URL>"
                       tar -zxvf <build>.tar.gz && cd <build>
                       ./install --ue sysadmin@<UE> --app sysadmin@<APP>
5. Build Check    → "Run checks" — runs the REST + UI smoke list
```

This app never SSHes to the Simnovator VM — installs go through Cockpit
because that's how the customer flow works.

---

## Project layout

```
src/app/                   Next.js app router pages + API routes
  about/                   /about — product overview
  api/                     REST endpoints (inventory, ui-tests, validate, …)
  api-tests/               /api-tests — REST API regression UI
  automation/              /automation — saved test suite runner
  end-to-end/              /end-to-end — QA Test Setup builder
  inventory/               /inventory — systems + topology editor
  runs/                    /runs — run history
  testcases/               /testcases — testcase browser
  ui-tests/                /ui-tests — Playwright UI regression UI
  validate/                /validate — Build Check
src/components/            Header, Sidebar, shared UI primitives
src/lib/                   Test runners, inventory model, deploy helpers,
                           uesim REST client, cfg generator, validator
scripts/                   Stand-alone scripts (probes, jira attach, etc.)
docs/                      Architecture / strategy notes
generator/                 Static cfg templates the runner consumes
callbox_configs/, mme_ims_configs/   Vendor cfg templates
```

---

## Running the test suites

### UI regression
1. Inventory → ensure your Simnovator (or a generic UESIM) is in inventory
2. UI Tests → pick a host, optional category filter, hit Run
3. Watch the live status pane; failures retain trace + video

### API regression
1. API Tests → hit Run

Both runs persist artifacts under `data/runs/<runId>/` and show up on the
Runs page afterwards. Those directories are gitignored — the suite produces
gigabytes of evidence over a few hundred runs.

---

## Configuration

`inventory.yaml` is the single source of truth for which systems exist and
how to reach them. The file is gitignored — copy `inventory.example.yaml`
and fill in your own values.

Key fields per system:

| Field | Purpose |
|-------|---------|
| `id` | Unique slug |
| `type` | `SIMNOVATOR` / `UESIM` / `CALLBOX` / `ENB` / `GNB` / `MME` / `IMS` / `APPSERVER` |
| `host` | IP or hostname |
| `username` / `password` | SSH credentials (used only for non-Simnovator deploys) |
| `cockpitUser` / `cockpitPassword` / `cockpitPort` | Cockpit defaults — only meaningful on `SIMNOVATOR` |
| `uesim.{username,password}` | UESIM REST API credentials |
| `vendor` | Adapter hint: `simnovus` / `amarisoft` / `srsran` / `oai` / `other` |

---

## Contributing

```bash
npm run typecheck       # tsc --noEmit
npm run dev             # localhost:4000
npm run build           # production build
```

PRs welcome. Keep PRs focused, include a "what / why" in the description,
and link to a Jira issue if there is one.

---

## License

Internal — copyright the project's owning organisation.

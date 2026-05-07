# QA strategy for the Simnovator UESIM

This is the operating doc behind simqa. It describes *what* we test, *how*
we test it, and *where* in this app each kind of test lives. Use it as a
reference when adding new checks.

## Pyramid

We treat each layer as a distinct flow with its own UI page:

```
                ┌─────────────────────────────┐
                │  E2E live runs (Automation) │   /automation, /runs
                ├─────────────────────────────┤
                │  Cfg generator round-trip   │   /testcases/[id] preview
                ├─────────────────────────────┤
                │  REST API smoke checks      │   /validate
                ├─────────────────────────────┤
                │  Build install + boot       │   /validate (with build)
                └─────────────────────────────┘
```

A new build flows top-down: install → API up → generator works → run a real
testcase. Failures should be caught at the lowest layer they appear in so
the green/red output points at the actual broken stage.

## Layer 1 — Build install + boot (`/validate`, with `Include build install`)

What it answers: *did this build land cleanly on the box?*

- **Download** the artifact (URL or local path) into `data/builds/`.
- **SCP** to the UESIM host (`/tmp/<file>` by default).
- **Run installer** as root via the user-supplied install command, e.g.
  `tar -xzf /tmp/build.tar.gz -C /opt && /opt/simnovator/install.sh`.
- Wait 3s for services to come back, then continue with API checks below.

Requires SSH credentials on the UESIM system (Inventory page). Auth modes:
password, or private key (paste contents or filesystem path).

## Layer 2 — REST API smoke (`/validate`)

What it answers: *is the box's HTTP surface alive?*

| Check | Endpoint | Pass criterion |
|---|---|---|
| `ui-reachable` | `GET /` | 200 + body contains "Simnovator" |
| `login` | `POST /v2/login` | JWT returned |
| `me` | `GET /v2/users/me` | username + roles[] returned |
| `list-simulators` | `GET /v2/simulators` | array of simulators |
| `list-testcases` | `GET /v2/testcases` | non-zero total |
| `list-bands` | `POST /v2/band-info` | array of bands |
| `cfg-generator-roundtrip` | pulls a real testcase + runs the generator | no exceptions |
| `sample-execution` | `POST /v2/testcases/{id}/executions` then poll until COMPLETED | result=PASS within 60s |

The first six are inexpensive and run by default. `sample-execution` is
opt-in because it actually drives the radio.

## Layer 3 — Cfg generator round-trip (`/testcases/[id]`)

What it answers: *for this specific testcase, does the generator emit the
right cfg files?*

- Pulls `testDefinition` from `/v2/testcases/{id}`.
- Runs `generateConfigs(td, id)` -> `{ enb?, gnb?, mme, ims?, ue_db? }`.
- Renders each in a tabbed code viewer.
- Surfaces a "notes" list for known gaps (NSA, NSSAI, mobility, NTN).

Used as the human-in-the-loop check before triggering a deploy.

## Layer 4 — End-to-end live runs (`/automation` -> `/runs/batch/<id>`)

What it answers: *does this set of testcases pass on this hardware?*

- An **Automation Suite** is a saved bundle: name, testcaseIds[], topologyId,
  defaultDryRun, stopOnFail. Saved to `inventory.yaml` under `suites:`.
- Running a suite spawns one Run per testcase, all sharing a `batchId`.
- Each Run goes through the full pipeline: preflight-login -> generate ->
  deploy (SSH push to topology systems) -> trigger (POST executions) ->
  poll (until COMPLETED/ABORTED).
- The batch view shows aggregate pass/fail counts and links to per-run
  evidence (cfg files, summary, execution.json).

## Inventory model

`inventory.yaml` (managed via `/inventory`):

```yaml
systems:
  - id: lab-uesim
    type: UESIM           # UESIM | CALLBOX | ENB | GNB | MME | IMS | APPSERVER
    host: 192.168.1.95
    uesim: { username: admin, password: admin }
  - id: lab-callbox
    type: CALLBOX
    host: 192.168.1.107
    username: sysadmin
    authMode: privateKey  # or password
    privateKey: |
      -----BEGIN OPENSSH PRIVATE KEY-----
      ...
    passphrase: ...       # if encrypted
    sudoPassword: ...     # for /root/* mv + systemctl restart, unless NOPASSWD

profiles:
  - id: lab-default
    name: Lab default
    uesim: lab-uesim
    callbox: lab-callbox  # this one box plays ENB+MME+IMS+APPSERVER

suites:
  - id: smoke-5g-sa
    name: Smoke - 5G SA
    testcaseIds: [Demo-5G-SA-Attach_, 5G-SA-2UE-VoNR_]
    topologyId: lab-default
    defaultDryRun: false
    stopOnFail: true
```

## Deploy convention

The deploy module pushes per-module to canonical paths and bounces the
matching service:

| Module | Remote path | Service | Probe port |
|---|---|---|---|
| enb | `/root/enb/config/enb.cfg` | `lte` | 9001 |
| gnb | `/root/enb/config/gnb.cfg` | `lte` | 9002 |
| mme | `/root/mme/config/mme.cfg` | `ltemme` | 9000 |
| ims | `/root/mme/config/ims.cfg` | `ltemme` | 9000 |
| ue  | `/root/ue/config/ue.cfg`   | `lteue` | 9002 |
| ue_db | `/root/mme/config/ue_db.cfg` | (none) | — |

Deploy order: ue_db -> mme -> ims -> enb -> gnb -> ue. A failed step
short-circuits the bundle (we don't push enb if mme failed to come up).

## What we deliberately don't test (yet)

- **UI behavior** of the Simnovator app itself. Beyond "the SPA loads",
  we don't drive it with Playwright. If you want UI regression coverage,
  add a Playwright project under `simqa/e2e/` and wire it into CI.
- **Negative API tests.** We assert success paths. Schema-fuzz with
  `schemathesis` against the OpenAPI for negative coverage when needed.
- **Long-soak / load.** simqa runs single-iteration validations. Use the
  Simnovator's own long-duration testcases (e.g. `*Longhr*`) for that;
  trigger them via a Suite with a `pollTimeoutSec` of 12 * 3600.
- **Cross-vendor RAN.** The cfg generator targets Simnovus's `lteenb`/
  `ltemme`. For Amarisoft / srsRAN / OAI add a vendor adapter under
  `src/lib/vendors/<name>/`.

## Adding a new check

1. Pick a layer. Network/REST behavior -> Layer 2 (validator). Generator
   correctness -> Layer 3 (cfg preview + maybe a unit test). Real radio
   behavior -> Layer 4 (a new testcase in the catalog).
2. For Layer 2: add a `CheckId` and a branch in `runValidationPlan` in
   `src/lib/validator.ts`. Add it to `ALL_CHECKS` in `/validate/page.tsx`.
3. For Layer 4: create or import the testcase in the Simnovator UI; it
   will show up under `/testcases` automatically.

## Operational guidance

- Run `/validate` as the very first thing after every Simnovator upgrade.
- Maintain a "smoke" suite of 3-5 testcases that exercises 5G SA, LTE,
  VoLTE, multi-cell, and a high-UE-count case. Run it nightly.
- Tag failed runs in the UI - we'll add labels in a future slice. For now,
  the run id is sortable so date-range filtering on `/runs` is enough.

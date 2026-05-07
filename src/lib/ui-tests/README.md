# Per-field test packs

This folder holds **data-driven** test packs that validate auto-populate /
range / dependency behaviour for individual UI fields against a vendor- or
spec-derived golden reference.

The first pack (band-validation) is the **template**. Future packs follow
the same shape so the test catalog stays organised as it grows.

```
src/lib/ui-tests/
├── README.md                       <- this file
├── framework-types.ts              <- types shared with per-field packs
├── reference/                      <- golden reference data (vendor/spec-derived)
│   └── master-all-rats.json        <- band → ARFCN/freq/cfg golden, 95 entries
├── lib/                            <- pure-function spec libraries (no I/O)
│   └── spec-3gpp.ts                <- TS 38.104 / TS 36.101 ARFCN math
└── tests/                          <- one file per field family
    └── band-validation.ts          <- Band picker auto-populate tests
```

## How a per-field pack works (3 layers)

For any field where the UI auto-populates / validates based on user input:

| Layer | What it tests | Speed | Where the bug lives if it fails |
|---|---|---|---|
| **L3 — Spec verify** | The golden file matches first-principles formulas | <1s offline | Bug in the golden file itself |
| **L1 — API** | The product's REST endpoint returns golden values | ~30s for 95 calls | Backend logic |
| **L2 — UI** | The UI form auto-fills with the API values when user picks | ~30 min for 95 paths | Frontend SPA |

L3 is cheapest and validates the test corpus itself. **Always include L3** before L1/L2 so a bad golden file doesn't make L1/L2 lie green.

## How to add a new per-field pack

Pick a field that has auto-populate or validation logic — e.g. PRACH
config index → root sequence index, or RAT switch → cell-config defaults.
Then:

### 1. Add reference data
Create `reference/<field>.json` with one entry per known-good combination.
Each entry needs: the **input** the user picks, the **expected output** the
UI/API should produce, and a `status: "ok"` flag (so a future "intentionally
out-of-spec" entry can opt out of L3).

### 2. Add a spec library (optional but strongly recommended)
Create `lib/<spec-name>.ts` with pure functions that compute the expected
output from the input, citing the relevant 3GPP / vendor doc section in
comments. This is what makes L3 possible.

### 3. Add a test factory
Create `tests/<field>.ts` exporting `<field>Tests(): UiTestDef[]`. Use
`makeNrSpecTest` / `makeNrApiTest` in `band-validation.ts` as the model.
Each entry generates one or more `UiTestDef`s.

### 4. Wire into the runner
Two lines in `src/lib/uiTester.ts`:

```typescript
import { fooFieldTests } from './ui-tests/tests/foo-field';
// ... at the end of defs():
list.push(...(fooFieldTests() as unknown as UiTestDef[]));
```

### 5. Add the category to the UI
- Append the new category to `UiTestCategory` in `uiTester.ts`
- Append to `DEFAULT_CATEGORIES`
- Add a label + colour in `CATEGORY_META` in `src/app/ui-tests/page.tsx`

## Naming conventions

- Test ids: `field-<field>-<layer>-<param-summary>`, e.g.
  `field-band-spec-nr-b78-bw100-scs30-ssb30`
- Test names: `[L1 API]`, `[L2 UI]`, `[L3 spec]` prefix so a glance at
  the catalog tells you which layer
- Categories: `field-<field>` prefix so all per-field tests group together

## Why three layers, not just one

A single layer mis-leads:
- **Only L1?** If the API and golden agree but both are wrong (off by one
  sub-carrier), every test passes silently.
- **Only L3?** Catches golden-file errors but says nothing about whether
  the product implements the spec.
- **Only L2?** Slow, brittle, and you can't tell if a regression is in
  the API or the UI when it fails.

Together: L3 vouches for the corpus, L1 isolates backend regressions, L2
isolates frontend regressions.

## Current packs

| Pack | Field | Reference | Spec lib | Tests generated |
|---|---|---|---|---|
| band-validation | RAT + Band → DL-ARFCN, SSB-ARFCN | master-all-rats.json (95 entries) | spec-3gpp.ts | 190 (95 L3 + 95 L1) |

## Suggested future packs

Each of these has the same shape: field with auto-populate/range/dependency
logic that we want to verify against a known-good corpus.

- **prach-config** — PRACH config index → root sequence index, format, length
- **tdd-pattern** — TDD slot pattern → DL/UL slots/symbols breakdown
- **imsi-plmn** — IMSI prefix consistency with home PLMN (MCC/MNC)
- **nssai-slicing** — slice config (SST/SD) format + range
- **subscriber-keys** — AKA Ki/OPc length + format
- **userplane-profile** — profile type → required fields visible

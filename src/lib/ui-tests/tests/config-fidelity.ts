// Config-Fidelity field pack.
//
// Brings the config-fidelity validation (the /config-fidelity page + the
// cf-matrix-run campaign) into the UI Tests regression suite. Each test reuses
// the EXISTING engine end-to-end on the box:
//
//   generate a Case -> createTestCase -> generateAndRetrieveUeCfg (execute +
//   SSH-read ue.cfg) -> validateConfig (prove every JSON param is honoured)
//
// PASS = fidelity ok (0 mismatch, 0 critical-missing) AND no config errors.
//
// These EXECUTE a real testcase on the box, so they are marked `destructive`
// (the driver's isSerial() runs destructive tests sequentially — honouring the
// box's system-wide execution mutex even at concurrency > 1) and `longRunning`.
// `severity: normal` keeps them in the Regression/Full profiles but OUT of the
// critical-only Smoke profile. They authenticate server-side via the REST API
// (createTestCase -> ensureToken), so they do NOT need the browser auth
// preflight (needsAuth: false) — the Playwright page in the bundle is unused.
//
// Nothing here touches the live configFidelity/runner.ts or cf-matrix-run.cjs;
// we only call their already-exported building blocks.

import type { UiTestDef } from '../framework-types';
import { loadInventory, isUesimLike, uesimApiOptsForSystem, type InventorySystem } from '../../inventory';
import type { Case, InputConfig } from '../../configFidelity/types';
import type { ApiOpts } from '../../configFidelity/testCreator';
import type { BandRat } from '../../configFidelity/bandTable';
import { generateBandSweep, generateMatrix } from '../../configFidelity/paramSpace';
import { generateVariationSweep, type TrafficKind } from '../../configFidelity/variationSweep';
import { createTestCase, deleteTestCase, CreateError } from '../../configFidelity/testCreator';
import { generateAndRetrieveUeCfg } from '../../configFidelity/ueCfg';
import { validateConfig, detectConfigErrors } from '../../configFidelity/validate';

// Resolve the box REST target + the SSH-capable UE-sim host from inventory,
// exactly like configFidelity/runner.ts does. ctx.host selects which box the
// UI Tests run is targeting; the UE-sim is whichever inventory system carries
// SSH credentials (needed to read /root/ue/config/ue.cfg).
function resolveTargets(ctxHost: string): { api: ApiOpts; ueSim: InventorySystem } | { error: string } {
  const inv = loadInventory();
  const box = inv.systems.find((s) => s.host === ctxHost && isUesimLike(s)) ?? inv.systems.find(isUesimLike);
  const opts = uesimApiOptsForSystem(inv, box?.id);
  if (!opts) return { error: 'no Simnovator/UESIM REST target in inventory.yaml' };
  const ueSim = inv.systems.find((s) => isUesimLike(s) && !!s.username) ?? inv.systems.find((s) => !!s.username);
  if (!ueSim) return { error: 'no UE-sim system with SSH credentials in inventory.yaml (needed to read ue.cfg)' };
  return { api: { host: opts.host, username: opts.username, password: opts.password }, ueSim };
}

type RunResult = { ok: boolean; detail: string; expected?: string };

// create -> execute -> retrieve ue.cfg -> validate -> cleanup. Mirrors
// runner.ts:runOneCase (minus the report bookkeeping / artifact writing).
async function runCase(ctxHost: string, c: Case): Promise<RunResult> {
  const t = resolveTargets(ctxHost);
  if ('error' in t) return { ok: false, detail: t.error, expected: 'inventory has a Simnovator REST target + an SSH-capable UE-sim' };
  const { api, ueSim } = t;

  // Unique box name so the settings finaliser doesn't 400 on a name that
  // already exists (from a previous run or the parallel cf campaign). Same
  // trick as runner.ts. Date.now() is fine here (ordinary server code).
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const uniq = `${c.id}-${stamp}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  if (c.settings?.settings) { c.settings.settings.testCaseName = uniq; c.settings.settings.test_name = uniq; }

  let testCaseId: string | undefined;
  try {
    const created = await createTestCase(api, c);
    testCaseId = created.testCaseId;

    const gen = await generateAndRetrieveUeCfg({ api, ueSimSystem: ueSim, testCaseId, expectedName: uniq });
    const configErrors = detectConfigErrors(gen.signals);

    if (!gen.ueCfg) {
      const ce = configErrors.length ? ' · ' + configErrors.map((e) => e.message).join('; ') : '';
      return { ok: false, detail: `no ue.cfg retrieved${ce}`, expected: 'box writes a ue.cfg at execution start; SSH retrieval returns it' };
    }

    const v = validateConfig(c.input, gen.ueCfg);
    const ok = v.ok && configErrors.length === 0;
    const cfgErr = configErrors.length ? ` · ${configErrors.length} cfg-err: ${configErrors.map((e) => e.message).join('; ').slice(0, 120)}` : '';
    // On failure, name the offending params (mismatch + critical-missing) with
    // expected/actual so the report is actionable without re-running by hand.
    const bad = v.params.filter((p) => p.status === 'mismatch' || (p.status === 'missing' && p.criticality === 'critical'));
    const badStr = bad.length
      ? ` — ${bad.map((p) => `${p.label} [${p.status}] exp=${JSON.stringify(p.expected)} act=${JSON.stringify(p.actual)}`).join('; ').slice(0, 240)}`
      : '';
    return {
      ok,
      detail: `${v.counts.honoured}✓ ${v.counts.mismatch}✗ ${v.counts.missing}gap (${v.counts.noRule} no-rule)${cfgErr}${badStr}`,
      expected: 'every configured JSON parameter is honoured in the generated ue.cfg (0 mismatch, 0 critical-missing, no config errors)',
    };
  } catch (e: any) {
    if (e instanceof CreateError) return { ok: false, detail: `box refused the config: ${e.message}`, expected: 'box accepts the generated /tests/* config sections' };
    return { ok: false, detail: e?.message ?? String(e), expected: 'create → execute → retrieve → validate completes without error' };
  } finally {
    // Auto-clean (matches runner behaviour) so the box returns to baseline.
    if (testCaseId) await deleteTestCase(api, testCaseId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Band honour — one per RAT, first vetted band (real ARFCN) from bandTable.ts.
// Reuses the same generateBandSweep the /config-fidelity page drives, so these
// stay sourced from config-fidelity's band master table automatically.
// ---------------------------------------------------------------------------
const BAND_RATS: BandRat[] = ['NR', 'LTE', 'CATM', 'NBIOT'];

function bandHonourTests(): UiTestDef[] {
  return BAND_RATS.map((rat): UiTestDef => {
    const c = generateBandSweep({ rats: [rat], dataType: 'no_data', cap: 1 })[0];
    return {
      id: `cf-honour-band-${rat.toLowerCase()}`,
      name: `[config-fidelity] ${rat} band → ue.cfg honoured${c ? ` (${c.id})` : ''}`,
      description: `Config-fidelity band sweep for ${rat}: create a testcase for the first vetted band (real ARFCN from bandTable.ts), execute it, retrieve the generated ue.cfg over SSH, and assert every JSON parameter (band/ARFCN, bandwidth, antennas, subscriber + settings) is honoured.`,
      category: 'config-fidelity',
      severity: 'normal',
      needsAuth: false,
      longRunning: true,
      destructive: true,
      run: async ({ ctx }) => {
        if (!c) return { ok: false, detail: `bandTable.ts produced no ${rat} band`, expected: `at least one ${rat} band in the vetted master table` };
        return runCase(ctx.host, c);
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Variation dimensions — fix an NR-SA base (synthesized from generateMatrix, so
// the test is self-contained and not tied to a specific box testcase id), then
// vary ONE config-fidelity dimension per test: traffic / mobility / channel
// model (fading) / power-cycle. Mirrors what the variation sweep exercises.
// ---------------------------------------------------------------------------
function variationBase(): InputConfig | null {
  const m = generateMatrix({ rats: ['nr-sa'], cap: 1 })[0];
  return m ? m.input : null;
}

interface VarDim {
  id: string;
  label: string;
  traffic: TrafficKind;
  trip: string;
  fading: string;          // NR fading model; non-awgn forces channelSim = true
  power: { loopProfile: string; attachType: string; count: number };
}

const VAR_DIMS: VarDim[] = [
  { id: 'traffic-udp',        label: 'traffic udp',        traffic: 'udp',     trip: 'stationary', fading: 'awgn',   power: { loopProfile: 'disable', attachType: 'bursty', count: 0 } },
  { id: 'traffic-tcp',        label: 'traffic tcp',        traffic: 'tcp',     trip: 'stationary', fading: 'awgn',   power: { loopProfile: 'disable', attachType: 'bursty', count: 0 } },
  { id: 'mobility-roundtrip', label: 'mobility roundTrip', traffic: 'no_data', trip: 'roundTrip',  fading: 'awgn',   power: { loopProfile: 'disable', attachType: 'bursty', count: 0 } },
  { id: 'fading-tdla30',      label: 'fading tdla30',      traffic: 'no_data', trip: 'stationary', fading: 'tdla30', power: { loopProfile: 'disable', attachType: 'bursty', count: 0 } },
  { id: 'powercycle-count',   label: 'power-cycle count',  traffic: 'no_data', trip: 'stationary', fading: 'awgn',   power: { loopProfile: 'count',   attachType: 'bursty', count: 2 } },
];

function variationTests(): UiTestDef[] {
  return VAR_DIMS.map((d): UiTestDef => ({
    id: `cf-honour-${d.id}`,
    name: `[config-fidelity] variation ${d.label} → ue.cfg honoured`,
    description: `Config-fidelity variation sweep on a fixed NR-SA base, varying ${d.label}. Create the variation testcase, execute it, retrieve ue.cfg, and assert every parameter (including the varied dimension) is honoured.`,
    category: 'config-fidelity',
    severity: 'normal',
    needsAuth: false,
    longRunning: true,
    destructive: true,
    run: async ({ ctx }) => {
      const base = variationBase();
      if (!base) return { ok: false, detail: 'could not synthesize an NR-SA base config', expected: 'generateMatrix produces an nr-sa case' };
      const c = generateVariationSweep({
        base,
        traffic: [d.traffic],
        tripTypes: [d.trip],
        fading: [d.fading],
        powerLoops: [d.power],
        mode: 'pairwise',
        cap: 1,
      })[0];
      if (!c) return { ok: false, detail: `no variation case generated for ${d.label}`, expected: 'generateVariationSweep yields a case for the requested dimension' };
      return runCase(ctx.host, c);
    },
  }));
}

// Public: all config-fidelity test definitions for the UI Tests catalog.
export function configFidelityTests(): UiTestDef[] {
  return [...bandHonourTests(), ...variationTests()];
}

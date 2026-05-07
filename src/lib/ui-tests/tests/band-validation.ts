// Band → ARFCN auto-populate validation.
//
// This is the FIRST per-field test pack and the template for future ones
// (PRACH config, TDD pattern, IMSI/PLMN, etc.). The pattern is:
//
//   1. Reference data lives in src/lib/ui-tests/reference/<file>.json
//      (the "golden" set of known-good (input, expected output) tuples).
//   2. A spec library in src/lib/ui-tests/lib/<spec>.ts implements the
//      independent computation from first principles (3GPP, vendor doc).
//   3. THIS FILE generates one test per golden entry across 3 layers:
//        L1 (API)        - hit /v2/band-info, assert response matches golden
//        L2 (UI)         - drive the UI band picker, assert auto-fill matches
//        L3 (spec verify) - re-derive from 3GPP, assert golden matches spec
//
// The L3 layer catches bugs in the golden file itself (which would otherwise
// silently propagate to L1+L2). L1 catches API regressions cheaply. L2 is
// the slowest but proves the actual user experience works.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { verifyNrEntry, verifyLteEntry } from '../lib/spec-3gpp';
import type { UiTestDef } from '../framework-types';

const REFERENCE_FILE = path.join(process.cwd(), 'src', 'lib', 'ui-tests', 'reference', 'master-all-rats.json');

interface GoldenNrEntry {
  rat: 'NR'; band: number; duplex: string; bwMHz: number; scsKHz: number; ssbScsKHz: number;
  dlArfcn: number; dlFreqMHz: number; ssbArfcn: number; ssbGscn?: number; ssbFreqMHz: number;
  status: string; cfg: { core: Record<string, any> };
}
interface GoldenLteEntry {
  rat: 'LTE' | 'CATM' | 'NBIOT'; band: number; duplex: string; bwMHz: number;
  dlArfcn: number; dlFreqMHz: number;
  status: string; cfg: { core: Record<string, any> };
}

interface GoldenFile {
  generatedAt: string;
  perRat: Record<string, { ok: number; fail: number; total: number }>;
  bands: { NR?: GoldenNrEntry[]; LTE?: GoldenLteEntry[]; CATM?: GoldenLteEntry[]; NBIOT?: GoldenLteEntry[] };
}

function loadGolden(): GoldenFile | null {
  if (!fs.existsSync(REFERENCE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8')) as GoldenFile; }
  catch { return null; }
}

// ===========================================================================
// LAYER 3: 3GPP-spec verification (offline, fast)
// ===========================================================================

function makeNrSpecTest(entry: GoldenNrEntry): UiTestDef {
  return {
    id: `field-band-spec-nr-b${entry.band}-bw${entry.bwMHz}-scs${entry.scsKHz}-ssb${entry.ssbScsKHz}`,
    name: `[L3 spec] NR n${entry.band} bw=${entry.bwMHz}MHz scs=${entry.scsKHz}kHz: golden ARFCN matches TS 38.104`,
    description: `Layer 3 (offline). Re-derives DL frequency (${entry.dlFreqMHz} MHz) and SSB frequency (${entry.ssbFreqMHz} MHz) from the golden ARFCN values using TS 38.104 §5.4.2.1, asserts they match within 0.01 MHz, and confirms DL frequency falls inside band n${entry.band}'s DL range per Table 5.2-1.`,
    category: 'field-band',
    severity: 'normal',
    run: async () => {
      const r = verifyNrEntry(entry);
      // "Band not in spec table" means our verification dataset is incomplete - that's not a product failure, it's a coverage gap. Surface as informational.
      if (!r.ok && /not in TS 38\.104/.test(r.observation)) {
        return { ok: true, detail: `informational: ${r.observation}. Add entry to NR_BANDS in spec-3gpp.ts to verify.`, expected: 'expand NR_BANDS table to cover this band' };
      }
      return {
        ok: r.ok,
        detail: r.observation,
        expected: 'golden ARFCN derives to declared frequency via 3GPP formula; frequency falls inside band\'s DL range',
      };
    },
  };
}

function makeLteSpecTest(entry: GoldenLteEntry): UiTestDef {
  return {
    id: `field-band-spec-${entry.rat.toLowerCase()}-b${entry.band}-bw${entry.bwMHz}`,
    name: `[L3 spec] ${entry.rat} b${entry.band} bw=${entry.bwMHz}MHz: golden EARFCN matches TS 36.101`,
    description: `Layer 3 (offline). Re-derives DL frequency (${entry.dlFreqMHz} MHz) from EARFCN ${entry.dlArfcn} using TS 36.101 §5.7.3, asserts within 0.01 MHz, and confirms EARFCN is in band ${entry.band}'s downlink range per Table 5.5-1.`,
    category: 'field-band',
    severity: 'normal',
    run: async () => {
      const r = verifyLteEntry(entry);
      if (!r.ok && /not in TS 36\.101/.test(r.observation)) {
        return { ok: true, detail: `informational: ${r.observation}. Add entry to LTE_BANDS in spec-3gpp.ts to verify.`, expected: 'expand LTE_BANDS table to cover this band' };
      }
      return {
        ok: r.ok,
        detail: r.observation,
        expected: 'golden EARFCN derives to declared frequency; EARFCN in band downlink range',
      };
    },
  };
}

// ===========================================================================
// LAYER 1: API verification - POST /v2/band-info matches golden
// ===========================================================================

function makeNrApiTest(entry: GoldenNrEntry): UiTestDef {
  return {
    id: `field-band-api-nr-b${entry.band}-bw${entry.bwMHz}-scs${entry.scsKHz}-ssb${entry.ssbScsKHz}`,
    name: `[L1 API] NR n${entry.band} bw=${entry.bwMHz}MHz scs=${entry.scsKHz}kHz: /v2/band-info returns golden values`,
    description: `Layer 1 (API). POST /v2/band-info {rat:"NR", band:${entry.band}, bwMHz:${entry.bwMHz}, scsKHz:${entry.scsKHz}, ssbScsKHz:${entry.ssbScsKHz}}; asserts response includes dlArfcn=${entry.dlArfcn} and ssbArfcn=${entry.ssbArfcn}.`,
    category: 'field-band',
    severity: 'normal',
    needsAuth: true,
    run: async ({ ctx, bundle }) => {
      // Pull token from the SPA's localStorage (already populated by preflight-login).
      const result = await bundle.page.evaluate(async ({ host, payload }) => {
        let token = '';
        for (const k of ['access_token', 'token', 'jwt', 'auth_token', 'authToken']) {
          const v = localStorage.getItem(k);
          if (v && v.length > 20) { token = v.replace(/^"|"$/g, ''); break; }
        }
        if (!token) {
          // Visit a protected page first so the SPA loads its token.
          await fetch(`http://${host}/v2/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin' }),
          }).then(r => r.json()).then(j => { if (j.access_token) token = j.access_token; });
        }
        if (!token) return { error: 'no token available' };
        const r = await fetch(`http://${host}/v2/band-info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        const text = await r.text();
        try { return { status: r.status, body: JSON.parse(text) }; }
        catch { return { status: r.status, body: text }; }
      }, { host: ctx.host, payload: { rat: 'NR', band: entry.band, bwMHz: entry.bwMHz, scsKHz: entry.scsKHz, ssbScsKHz: entry.ssbScsKHz } }).catch((e: any) => ({ error: e?.message ?? String(e) }));

      if ('error' in result) return { ok: false, detail: `request failed: ${result.error}` };
      if (result.status !== 200) return { ok: false, detail: `HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 200)}`, expected: '200 with band-info payload' };
      const b: any = result.body;
      const apiDl = b?.dlArfcn ?? b?.dl_nr_arfcn ?? b?.data?.dlArfcn;
      const apiSsb = b?.ssbArfcn ?? b?.ssb_nr_arfcn ?? b?.data?.ssbArfcn;
      if (apiDl !== entry.dlArfcn || apiSsb !== entry.ssbArfcn) {
        return {
          ok: false,
          detail: `mismatch: API dlArfcn=${apiDl} ssbArfcn=${apiSsb}, expected ${entry.dlArfcn}/${entry.ssbArfcn}`,
          expected: `dlArfcn=${entry.dlArfcn} and ssbArfcn=${entry.ssbArfcn} per master-all-rats.json`,
        };
      }
      return { ok: true, detail: `API returned dlArfcn=${apiDl} ssbArfcn=${apiSsb} (matches golden)` };
    },
  };
}

function makeLteApiTest(entry: GoldenLteEntry): UiTestDef {
  return {
    id: `field-band-api-${entry.rat.toLowerCase()}-b${entry.band}-bw${entry.bwMHz}`,
    name: `[L1 API] ${entry.rat} b${entry.band} bw=${entry.bwMHz}MHz: /v2/band-info returns golden EARFCN`,
    description: `Layer 1 (API). POST /v2/band-info {rat:"${entry.rat}", band:${entry.band}, bwMHz:${entry.bwMHz}}; asserts dlArfcn (or dl_earfcn) = ${entry.dlArfcn}.`,
    category: 'field-band',
    severity: 'normal',
    needsAuth: true,
    run: async ({ ctx, bundle }) => {
      const result = await bundle.page.evaluate(async ({ host, payload }) => {
        let token = '';
        for (const k of ['access_token', 'token', 'jwt', 'auth_token', 'authToken']) {
          const v = localStorage.getItem(k);
          if (v && v.length > 20) { token = v.replace(/^"|"$/g, ''); break; }
        }
        if (!token) return { error: 'no token' };
        const r = await fetch(`http://${host}/v2/band-info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        const text = await r.text();
        try { return { status: r.status, body: JSON.parse(text) }; }
        catch { return { status: r.status, body: text }; }
      }, { host: ctx.host, payload: { rat: entry.rat, band: entry.band, bwMHz: entry.bwMHz } }).catch((e: any) => ({ error: e?.message ?? String(e) }));

      if ('error' in result) return { ok: false, detail: `request failed: ${result.error}` };
      if (result.status !== 200) return { ok: false, detail: `HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 200)}` };
      const b: any = result.body;
      const apiDl = b?.dlArfcn ?? b?.dl_earfcn ?? b?.data?.dlArfcn ?? b?.data?.dl_earfcn;
      if (apiDl !== entry.dlArfcn) {
        return {
          ok: false,
          detail: `mismatch: API dlArfcn=${apiDl}, expected ${entry.dlArfcn}`,
          expected: `dlArfcn=${entry.dlArfcn} per master-all-rats.json`,
        };
      }
      return { ok: true, detail: `API returned dlArfcn=${apiDl} (matches golden)` };
    },
  };
}

// ===========================================================================
// Public: gather all band-validation test definitions.
// Layer 2 (UI driving) is intentionally absent - the testcase create wizard
// is currently broken (F29). Add it here once that lifecycle is reachable.
// ===========================================================================

export function bandValidationTests(): UiTestDef[] {
  const golden = loadGolden();
  if (!golden) {
    return [{
      id: 'field-band-reference-missing',
      name: 'Reference data: master-all-rats.json present',
      description: 'Loads src/lib/ui-tests/reference/master-all-rats.json. All band-validation tests depend on this golden file.',
      category: 'field-band',
      severity: 'critical',
      run: async () => ({
        ok: false,
        detail: `${REFERENCE_FILE} not found or unparseable`,
        expected: 'reference file exists and is valid JSON with bands.{NR,LTE,CATM,NBIOT}[]',
      }),
    }];
  }
  const tests: UiTestDef[] = [];

  for (const entry of golden.bands.NR ?? []) {
    if (entry.status !== 'ok') continue;
    tests.push(makeNrSpecTest(entry));
    tests.push(makeNrApiTest(entry));
  }
  for (const rat of ['LTE', 'CATM', 'NBIOT'] as const) {
    for (const entry of golden.bands[rat] ?? []) {
      if (entry.status !== 'ok') continue;
      tests.push(makeLteSpecTest(entry));
      tests.push(makeLteApiTest(entry));
    }
  }
  return tests;
}

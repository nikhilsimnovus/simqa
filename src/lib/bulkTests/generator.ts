// Bulk-testcase generator. Authors 500+ valid varied testcases on a target
// Simnovator box via the REST create-lifecycle:
//
//   POST /v2/tests/cells          → init + return testCaseId
//   POST /v2/tests/{id}/subscribers
//   POST /v2/tests/{id}/user-plane
//   POST /v2/tests/{id}/power-cycle
//   POST /v2/tests/{id}/mobility
//   POST /v2/tests/{id}/settings  (finaliser; locks the case)
//   PUT  /v2/testcases/{id}       (tag it with qa-bulk so cleanup is one-shot)
//
// All variants are derived from `SLICES` in spec.ts, but only after we
// intersect each slice with the box's live `band-info` so we never push a
// (band, duplex, bandwidth) combo the box would reject. Variants are
// materialised eagerly into a flat list — generation is fully resumable: if
// a name already exists on the box (e.g. from an earlier partial run), we
// SKIP that variant rather than re-create it.

import type { UesimApiOpts } from './types';
import {
  SLICES,
  type BulkTestCaseSpec,
  type RAT,
  BULK_NAME_PREFIX,
  BULK_TAG,
  categoryOf,
  specToId,
} from './spec';

// ─── Live band-info shape (subset we actually use) ───────────────────────

interface BandInfoEntry {
  band: string;
  bandName: string;
  mode: 'FDD' | 'TDD';
  dlFreqRange: { lowArfcn: number; centreArfcn: number; highArfcn: number };
  ulFreqRange: { lowArfcn: number; centreArfcn: number; highArfcn: number };
  scs: number[] | null;            // null on LTE
  scsBandwidthCombination: Array<{ scs: number; bandwidths: number[] }>;
}

type BandInfoMap = Record<string, BandInfoEntry>;   // keyed by band id

async function fetchBandInfo(host: string, token: string, rat: 'NR' | 'LTE'): Promise<BandInfoMap> {
  const r = await fetch(`http://${host}/v2/band-info`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rat }),
  });
  if (!r.ok) throw new Error(`band-info ${rat} returned ${r.status}`);
  const wrapped: any = await r.json();
  // Box returns { code: 200, data: [...] } — handle both wrapped and naked.
  const arr: BandInfoEntry[] = Array.isArray(wrapped)
    ? wrapped
    : (wrapped.data ?? wrapped.bands ?? wrapped.items ?? []);
  const out: BandInfoMap = {};
  for (const e of arr) out[e.band] = e;
  return out;
}

// ─── Slice expansion ──────────────────────────────────────────────────────

export function expandSlices(nr: BandInfoMap, lte: BandInfoMap): BulkTestCaseSpec[] {
  const out: BulkTestCaseSpec[] = [];

  for (const slice of SLICES) {
    const ratMap = (slice.rat === 'LTE' || slice.rat === 'NB-IoT') ? lte : nr;
    let added = 0;
    const cap = slice.maxVariants ?? Infinity;
    // For LTE/NB-IoT, the scs dimension doesn't apply — fall through with
    // a single sentinel undefined so the outer loops still iterate once.
    const scsValues: ReadonlyArray<number | undefined> = (slice.scs && slice.scs.length > 0) ? slice.scs : [undefined];

    outer: for (const band of slice.bands) {
      const bi = ratMap[band];
      if (!bi) continue;                                // band not on this box
      const supportedBws: Set<number> = new Set();
      for (const combo of bi.scsBandwidthCombination ?? []) {
        for (const bw of combo.bandwidths) supportedBws.add(bw);
      }

      for (const bw of slice.bandwidths) {
        if (!supportedBws.has(bw) && !supportedBws.has(Math.floor(bw))) continue;
        for (const scs of scsValues) {
          for (const ueCount of slice.ueCounts) {
            for (const [dlAnt, ulAnt] of slice.antennas) {
              for (const dataType of slice.dataTypes) {
                for (const mobility of slice.mobility) {
                  for (const fading of slice.fading) {
                    added += 1;
                    const id = specToId(
                      slice.rat, band, bw, ueCount,
                      { dl: dlAnt, ul: ulAnt },
                      dataType, mobility, fading, scs,
                      added,
                    );
                    const isNr = slice.rat === 'NR-SA' || slice.rat === 'NR-NSA';
                    out.push({
                      id,
                      name: id,
                      rat: slice.rat,
                      band,
                      bandwidth: bw,
                      duplexMode: bi.mode,
                      earfcnDl: bi.dlFreqRange.centreArfcn,
                      earfcnUl: !isNr ? bi.ulFreqRange.centreArfcn : undefined,
                      nrarfcnSsb: isNr ? bi.dlFreqRange.centreArfcn : undefined,
                      scs: isNr ? (scs ?? bi.scs?.[0] ?? 30) : undefined,
                      ueCount,
                      antennas: { dl: dlAnt, ul: ulAnt },
                      dataType,
                      mobility,
                      fading,
                      category: categoryOf(slice.rat),
                    });
                    if (added >= cap) break outer;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

// ─── Body builders per section ────────────────────────────────────────────

function buildCellsBody(spec: BulkTestCaseSpec) {
  if (spec.rat === 'LTE' || spec.rat === 'NB-IoT') {
    return {
      cellConfig: {
        master: {
          product: 'UE-SIM',
          carrierAggregation: false,
          channelSim: false,
          pdcchDecodeOpt: true,
          pdcchDecodeOptThreshold: 0.1,
          ratType: 'smartphone',
          turboIteration: 14,
        },
        cells: [{
          cellType: '4g',
          syncId: 0,
          duplexMode: spec.duplexMode,
          band: spec.band,
          EARFCN: { dl: spec.earfcnDl, ul: spec.earfcnUl ?? spec.earfcnDl + 18000 },
          bandwidth: String(spec.bandwidth),
          prach: 0,
          antennas: { dl: spec.antennas.dl, ul: spec.antennas.ul },
          rfCard: 0,
          rxToTxLatency: 4,
          txGain: Array(spec.antennas.ul).fill(70),
          rxGain: Array(spec.antennas.dl).fill(0),
          globalTimingAdvance: -1,
          mobility: { antennaType: 'isotropic', position: [4, 3], referencePower: -25, ulAttenuation: 60 },
        }],
      },
    };
  }
  // NR-SA / NR-NSA — master config DIFFERS from LTE on this build:
  //   - ratType is 'sa' or 'nsa' (NOT 'smartphone' — that's an LTE knob)
  //   - ldpcIteration replaces turboIteration
  //   - pdcchDecodeOpt defaults false in shipped NR templates
  // Cell-level keys also differ (NRARFCN + scs + ratTypeP).
  return {
    cellConfig: {
      master: {
        product: 'UE-SIM',
        carrierAggregation: false,
        channelSim: false,
        ldpcIteration: 5,
        pdcchDecodeOpt: false,
        ratType: spec.rat === 'NR-SA' ? 'sa' : 'nsa',
      },
      cells: [{
        cellType: '5g',
        syncId: 0,
        duplexMode: spec.duplexMode,
        band: spec.band,
        NRARFCN: { dl: spec.earfcnDl, ssb: spec.nrarfcnSsb ?? spec.earfcnDl },
        bandwidth: String(spec.bandwidth),
        prach: 0,
        antennas: { dl: spec.antennas.dl, ul: spec.antennas.ul },
        rfCard: 0,
        scs: spec.scs ?? 30,
        ssbScs: spec.scs ?? 30,                  // box requires explicit ssbScs (separate from carrier scs)
        ratTypeP: spec.rat === 'NR-SA' ? 'sa' : 'nsa',
        carrierAggregationP: false,
        channelSimP: false,
        NTN: false,
        asymmetricApplicable: false,
        txGain: Array(spec.antennas.ul).fill(80),
        rxGain: Array(spec.antennas.dl).fill(20),
      }],
    },
  };
}

function buildSubscribersBody(spec: BulkTestCaseSpec) {
  // Spread the IMSIs across variants so multiple bulk testcases don't share
  // an IMSI range (the box validator may eventually reject duplicates).
  // The hash-of-id mod 1e6 keeps the seed deterministic but unique-ish.
  let h = 0;
  for (let i = 0; i < spec.id.length; i++) h = (h * 31 + spec.id.charCodeAt(i)) | 0;
  const imsiSeed = 1010100000000 + (Math.abs(h) % 1000000) * 100;

  const isNr = spec.rat === 'NR-SA' || spec.rat === 'NR-NSA';

  if (isNr) {
    // NR-SA subscribers schema (sampled from an existing on-box testcase):
    //   - SUPI fields, NOT IMSI (startingSUPI / nextSUPI)
    //   - nea/nia algos, NOT eea/eia
    //   - asRelease is uint8 integer in {15,16,17}
    //   - protectionScheme literal "null" (NOT "null-scheme")
    //   - algorithm "xor" (the box-shipped NR templates use xor by default;
    //     milenage requires op which the NR schema doesn't carry)
    //   - many NR-only required fields: NTNP, BLEROverrideValue, cellTypeP,
    //     cellsLen, duplexModeP, ratTypeP, networkSlicing, publicKeyId,
    //     routingIndicator, mncDigits, VoNRSupport, external_sim,
    //     incrementSharedKey, access_control_classes, uac_access_identities
    return {
      subsConfig: {
        subs: [{
          ueCount: spec.ueCount,
          servingCell: 0,
          startingSUPI: imsiSeed,
          nextSUPI: 1,
          algorithm: 'xor',
          sharedKey: '00112233445566778899aabbccddeeff',
          incrementSharedKey: 0,
          resLength: 8,
          securityContext: true,
          asRelease: 15,
          ueCategoryType: 'combined',
          ueCategory: 'nr',
          imeisv: '4085780000000102',
          powerControl: false,
          attachType: 'normal',
          ueInitiatedEvents: 'none',
          pdnType: 'ipv4',
          cipherAlgorithm: ['nea0', 'nea1', 'nea2'],
          integrityAlgorithm: ['nia0', 'nia1', 'nia2'],
          cqi: 'auto',
          ri: 'auto',
          pmi: 'auto',
          preambleIndex: 0,
          mncDigits: 2,
          VoNRSupport: false,
          protectionScheme: 'null',
          publicKeyId: 0,
          routingIndicator: 1111,
          networkSlicing: 'disable',
          ratTypeP: spec.rat === 'NR-SA' ? 'sa' : 'nsa',
          cellTypeP: '5g',
          cellsLen: 1,
          carrierAggregationP: false,
          channelSimP: false,
          duplexModeP: spec.duplexMode,
          NTNP: false,
          BLEROverrideValue: 0,
          external_sim: false,
          access_control_classes: [],
          uac_access_identities: [],
        }],
      },
    };
  }

  // LTE / NB-IoT subscriber schema (eea/eia + integer asRelease + IMSI).
  return {
    subsConfig: {
      subs: [{
        ueCount: spec.ueCount,
        servingCell: 0,
        startingIMSI: imsiSeed,
        preferredPLMN: ['011-01', '544-780'],
        nextIMSI: 1,
        algorithm: 'milenage',
        sharedKey: '00112233445566778899aabbccddeeff',
        op: '000102030405060708090A0B0C0D0E0F',
        resLength: 8,
        securityContext: true,
        asRelease: 13,
        redCap: false,
        ueCategoryType: 'combined',
        ueCategory: '6',
        imeisv: '4085780000000102',
        powerControl: false,
        powerMin: 0,
        powerMax: 0,
        attachType: 'normal',
        ueInitiatedEvents: 'tau',
        eventsInLoop: true,
        triggerTime: [10],
        pdnType: 'ipv4',
        defaultApn: '',
        cipherAlgorithm: ['eea0', 'eea1', 'eea2'],
        integrityAlgorithm: ['eia0', 'eia1', 'eia2'],
        cqi: 'auto',
        ri: 'auto',
        pmi: 'auto',
        preambleIndex: 0,
      }],
    },
  };
}

function buildUserPlaneBody(spec: BulkTestCaseSpec) {
  // Box-valid dataTypes (learned from existing testcases on 4.0.0_260602):
  //   'no_data' — no PDU traffic, used for attach-detach style cases
  //   'iperf'   — bidirectional or single-direction throughput, drives `dataDirection`
  if (spec.dataType === 'no_data') {
    return {
      userPlaneConfig: {
        profiles: [{
          subscriberGroup: [0],
          dataType: 'no_data',
          pdnType: 'ipv4',
          apnName: '',
        }],
      },
    };
  }
  const direction =
    spec.dataType === 'iperf-dl' ? 'downlink' :
    spec.dataType === 'iperf-ul' ? 'uplink' :
    'both';
  return {
    userPlaneConfig: {
      profiles: [{
        subscriberGroup: [0],
        dataType: 'iperf',
        dataDirection: direction,
        dataLoop: false,
        dataBitrate: {
          dl: { unit: 'mbps', value: 100 },
          ul: { unit: 'mbps', value: 20 },
        },
        transportProtocol: 'udp',
        startDelay: 5,
        sessionDuration: 60,
        serverIpAddress: '20.10.10.1',
        portRange: 5000,
        mtuSize: 1500,
        subsLen: spec.ueCount,
        pdnType: 'ipv4',
        apnName: '',
      }],
    },
  };
}

function buildPowerCycleBody() {
  return {
    powerCycleConfig: {
      profiles: [{
        subscriberGroup: [0],
        loopProfile: 'disable',
        attachType: 'bursty',
        attachRate: 1,
        attachDelay: 0,
        powerOnTime: 2000,
        powerOffTime: 10,
      }],
    },
  };
}

function buildMobilityBody(spec: BulkTestCaseSpec) {
  // tripType: 'stationary' → speed 0, no motion; 'roundTrip' → moves back
  // and forth across the configured distance. fadingType maps directly to
  // the box's accepted channel models (awgn/tdla30/tdlb100/epa5/eva70).
  const isStationary = spec.mobility === 'stationary';
  return {
    mobilityConfig: {
      profiles: [{
        subscriberGroup: [0],
        tripType: isStationary ? 'stationary' : 'roundTrip',
        loopProfile: 'time',
        startDelay: 5,
        duration: 380,
        waitTime: 0,
        uePosition: [0, 0],
        speed: isStationary ? 0 : 1,
        direction: 0,
        distance: isStationary ? 0 : 50,
        fadingProfile: { fadingType: spec.fading, frequencyDoppler: 70, mimoCorrelation: 'low' },
        noiseSpectralDensity: -174,
      }],
    },
  };
}

/** Settings is the finaliser. We self-discover valid loggingProfileName +
 *  successCriteriaName from any existing testcase on the box (4.0.0_260602+
 *  validates these against an internal list with no public enumeration
 *  endpoint — see overnight bug-report P2). */
async function buildSettingsBody(host: string, token: string, testCaseName: string): Promise<any> {
  const fallback = { loggingProfileName: 'debug', successCriteriaName: 'BLER Success' };
  try {
    const r = await fetch(`http://${host}/v2/testcases/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset: 0, limit: 25 }),
    });
    if (r.ok) {
      const data: any = await r.json();
      const items: any[] = data.items ?? data.data ?? [];
      for (const it of items) {
        const t = await fetch(`http://${host}/v2/testcases/${encodeURIComponent(it.id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!t.ok) continue;
        const td: any = await t.json();
        const s = td?.testDefinition?.settings;
        if (s?.successCriteriaName && s?.loggingProfileName) {
          return { settings: { ...s, testCaseName, test_name: testCaseName } };
        }
      }
    }
  } catch { /* fall through */ }
  return { settings: { ...fallback, testCaseName, test_name: testCaseName } };
}

// ─── Progress + result types ──────────────────────────────────────────────

export interface GenerationProgress {
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  passed: number;
  failed: number;
  skipped: number;
  currentName?: string;
  /** Aborted via signal — true once an abort propagated. */
  aborted?: boolean;
}

/** Per-testcase dimension summary — surfaced in both the manifest's
 *  `created[]` and downstream report rendering so consumers don't have
 *  to re-parse the name to get back to band/bw/ueCount/etc. */
export interface CreatedTestcase {
  id: string;
  name: string;
  boxId: string;
  rat: RAT;
  category: string;
  band: string;
  bandwidth: number;
  duplexMode: 'FDD' | 'TDD';
  ueCount: number;
  antennas: { dl: number; ul: number };
  dataType: string;
  mobility: string;
  fading: string;
  scs?: number;
}

export interface GenerationResult {
  startedAt: string;
  finishedAt: string;
  targetHost: string;
  /** Simnovator build version captured at generation time (best-effort). */
  buildVersion?: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Created testcases (one entry per success). */
  created: CreatedTestcase[];
  /** Variants we tried but failed at some lifecycle step. */
  failures: Array<{ id: string; name: string; step: string; status: number; message: string }>;
  /** Variants we skipped because a same-name testcase already existed. */
  skips: Array<{ id: string; name: string; reason: string }>;
}

// ─── Main generator ──────────────────────────────────────────────────────

export async function generateBulkTestcases(
  opts: UesimApiOpts,
  onProgress?: (p: GenerationProgress) => void,
  signal?: AbortSignal,
  limit?: number,
): Promise<GenerationResult> {
  const startedAt = new Date().toISOString();

  // 1. Login.
  const loginR = await fetch(`http://${opts.host}/v2/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: opts.password }),
  });
  if (!loginR.ok) throw new Error(`login: ${loginR.status} ${await loginR.text()}`);
  const loginD: any = await loginR.json();
  const token: string = loginD.access_token ?? loginD.token;

  // 2. Pull live band-info so every variant we emit is actually valid.
  const [nrBands, lteBands] = await Promise.all([
    fetchBandInfo(opts.host, token, 'NR'),
    fetchBandInfo(opts.host, token, 'LTE'),
  ]);

  // 2b. Stamp the report with the box's build version. Best-effort —
  // /v2/version is the only endpoint that returns it; if it's missing the
  // result just has buildVersion=undefined.
  let buildVersion: string | undefined;
  try {
    const vR = await fetch(`http://${opts.host}/v2/version`, { headers: { Authorization: `Bearer ${token}` } });
    if (vR.ok) {
      const vJ: any = await vR.json();
      const v = vJ?.simnovator?.version;
      const b = vJ?.simnovator?.build;
      buildVersion = v && b ? `${v} (${b})` : (v ?? undefined);
    }
  } catch { /* keep undefined */ }

  // 3. Materialise variants.
  let variants = expandSlices(nrBands, lteBands);
  if (limit && limit > 0) variants = variants.slice(0, limit);

  // 4. Pre-load existing names so we can skip duplicates cheaply. POST
  // /testcases/search caps at 50 on this build, so we use the GET form.
  const existingByName = new Set<string>();
  try {
    const sR = await fetch(`http://${opts.host}/v2/testcases?limit=1000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (sR.ok) {
      const data: any = await sR.json();
      for (const it of (data.items ?? data.data ?? [])) {
        if (it?.name) existingByName.add(String(it.name).toLowerCase());
      }
    }
  } catch { /* keep going — duplicate-name will surface as a 4xx */ }

  // 5. Iterate.
  const created: GenerationResult['created'] = [];
  const failures: GenerationResult['failures'] = [];
  const skips: GenerationResult['skips'] = [];
  const progress: GenerationProgress = { startedAt, total: variants.length, done: 0, passed: 0, failed: 0, skipped: 0 };

  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const POST = (path: string, body: any) => fetch(`http://${opts.host}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const PUT  = (path: string, body: any) => fetch(`http://${opts.host}${path}`, { method: 'PUT',  headers: H, body: JSON.stringify(body) });
  const DEL  = (path: string)            => fetch(`http://${opts.host}${path}`, { method: 'DELETE', headers: H });

  for (const v of variants) {
    if (signal?.aborted) { progress.aborted = true; break; }
    progress.currentName = v.name;
    onProgress?.(progress);

    if (existingByName.has(v.name.toLowerCase())) {
      skips.push({ id: v.id, name: v.name, reason: 'a testcase with this name already exists' });
      progress.skipped++; progress.done++;
      continue;
    }

    // Step 1: cells
    let boxId = '';
    try {
      const r = await POST('/v2/tests/cells', buildCellsBody(v));
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.testCaseId) {
        failures.push({ id: v.id, name: v.name, step: 'cells', status: r.status, message: JSON.stringify(j).slice(0, 200) });
        progress.failed++; progress.done++;
        continue;
      }
      boxId = j.testCaseId;

      const steps: Array<[string, () => Promise<Response>]> = [
        ['subscribers', () => POST(`/v2/tests/${encodeURIComponent(boxId)}/subscribers`, buildSubscribersBody(v))],
        ['user-plane',  () => POST(`/v2/tests/${encodeURIComponent(boxId)}/user-plane`,  buildUserPlaneBody(v))],
        ['power-cycle', () => POST(`/v2/tests/${encodeURIComponent(boxId)}/power-cycle`, buildPowerCycleBody())],
        ['mobility',    () => POST(`/v2/tests/${encodeURIComponent(boxId)}/mobility`,    buildMobilityBody(v))],
      ];
      let failedStep: string | null = null;
      let failedStatus = 0;
      let failedMsg = '';
      for (const [step, fn] of steps) {
        if (signal?.aborted) { progress.aborted = true; break; }
        const sr = await fn();
        if (!sr.ok) {
          failedStep = step; failedStatus = sr.status;
          failedMsg = (await sr.text()).slice(0, 200);
          break;
        }
      }
      if (failedStep) {
        await DEL(`/v2/testcases/${encodeURIComponent(boxId)}`);
        failures.push({ id: v.id, name: v.name, step: failedStep, status: failedStatus, message: failedMsg });
        progress.failed++; progress.done++;
        continue;
      }

      // Settings — finaliser, with self-discovered valid criterion.
      const settingsBody = await buildSettingsBody(opts.host, token, v.name);
      const settR = await POST(`/v2/tests/${encodeURIComponent(boxId)}/settings`, settingsBody);
      if (!settR.ok) {
        const settMsg = (await settR.text()).slice(0, 200);
        await DEL(`/v2/testcases/${encodeURIComponent(boxId)}`);
        failures.push({ id: v.id, name: v.name, step: 'settings', status: settR.status, message: settMsg });
        progress.failed++; progress.done++;
        continue;
      }

      // Tag for cleanup.
      await PUT(`/v2/testcases/${encodeURIComponent(boxId)}`, { user_tags: [BULK_TAG, v.category] }).catch(() => {});

      created.push({
        id: v.id, name: v.name, boxId, rat: v.rat, category: v.category,
        band: v.band, bandwidth: v.bandwidth, duplexMode: v.duplexMode,
        ueCount: v.ueCount, antennas: v.antennas, dataType: v.dataType,
        mobility: v.mobility, fading: v.fading, scs: v.scs,
      });
      progress.passed++; progress.done++;
    } catch (e: any) {
      // Best-effort cleanup of orphan if we created one.
      if (boxId) { await DEL(`/v2/testcases/${encodeURIComponent(boxId)}`).catch(() => {}); }
      failures.push({ id: v.id, name: v.name, step: 'exception', status: 0, message: e?.message ?? String(e) });
      progress.failed++; progress.done++;
    }
    onProgress?.(progress);
  }

  const finishedAt = new Date().toISOString();
  progress.finishedAt = finishedAt;
  onProgress?.(progress);

  return {
    startedAt, finishedAt,
    targetHost: opts.host,
    buildVersion,
    total: variants.length,
    passed: created.length,
    failed: failures.length,
    skipped: skips.length,
    created, failures, skips,
  };
}

/** Delete every testcase whose user_tags include `qa-bulk`. Best-effort. */
export async function cleanupBulkTestcases(opts: UesimApiOpts): Promise<{ deleted: string[]; failed: Array<{ id: string; status: number }> }> {
  const loginR = await fetch(`http://${opts.host}/v2/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: opts.password }),
  });
  if (!loginR.ok) throw new Error(`login: ${loginR.status}`);
  const loginD: any = await loginR.json();
  const token: string = loginD.access_token ?? loginD.token;

  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // List all. Use GET /v2/testcases?limit=1000 since:
  //   - POST /testcases/search caps at 50 regardless of `limit` (product bug P5)
  //   - Pagination via ?offset= returns 0 once offset>0 (product bug P6)
  // GET with limit=1000 reliably returns all rows up to ~1000.
  const sR = await fetch(`http://${opts.host}/v2/testcases?limit=1000`, { headers: H });
  if (!sR.ok) throw new Error(`list: ${sR.status}`);
  const data: any = await sR.json();
  const items: any[] = data.items ?? data.data ?? [];
  const targets = items.filter(it => {
    const name = String(it?.name ?? '').toLowerCase();
    const tags: string[] = it?.metadata?.user_tags ?? it?.user_tags ?? [];
    return name.startsWith(BULK_NAME_PREFIX) || (Array.isArray(tags) && tags.includes(BULK_TAG));
  });

  const deleted: string[] = [];
  const failed: Array<{ id: string; status: number }> = [];
  for (const t of targets) {
    const r = await fetch(`http://${opts.host}/v2/testcases/${encodeURIComponent(t.id)}`, { method: 'DELETE', headers: H });
    if (r.ok) deleted.push(t.id);
    else failed.push({ id: t.id, status: r.status });
  }
  return { deleted, failed };
}

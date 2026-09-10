// Prove that every parameter authored in a testcase is honoured in the ue.cfg
// the UE-sim generated for it.
//
// DIRECTION MATTERS. An early version walked the ue.cfg and looked for each of
// its fields in the testcase, which answers "does the cfg contain anything
// unexpected?" — a weaker question. The one that matters is the other way
// round: the testcase is what was asked for, so every parameter in it has to
// turn up in the cfg, and one that quietly does not is the defect this feature
// exists to catch.
//
// NAMES DO NOT MATCH BETWEEN THE TWO SIDES, and assuming they do was the second
// mistake. dataBitrate.dl is bitrate_dl in the cfg; antennas.dl is n_antenna_dl;
// prach is prach_delay. A hand-written table covered about thirty of the 270
// parameters in the corpus and reported the rest as "not checked", which on
// screen reads as "missing" — so a value that WAS in the cfg was shown as
// absent. Resolution is now structural and lives in resolve.ts.
//
// Every authored parameter gets a row, named by its TESTCASE path, carrying:
//
//   honoured      found in the cfg with the same value
//   mismatch      found, but different                     -> fails the capture
//   not-honoured  the export's own config says it should be there and it is not
//   not-emitted   known to have no cfg destination, with the reason
//   no-rule       searched by name AND by value, nothing found
//
// The last two are distinct on purpose. "not-emitted" is a claim about the
// product and needs evidence; "no-rule" is a statement about what the search
// found. Neither is ever counted as a pass.
//
// IMPORTS: resolve.ts and node builtins only, so this unit-tests directly under
// `node --test`.

import { resolveParam, hasKnownCfgName, normKey, type Scope } from './resolve.ts';

export type RowStatus =
  | 'honoured' | 'mismatch' | 'not-honoured' | 'not-emitted' | 'no-rule' | 'cfg-only';

export interface CompareRow {
  /** Path in the TESTCASE — the first column, and the identity of the row. */
  testcasePath: string;
  testcaseValue?: unknown;
  /** Where the counterpart was found in the ue.cfg. */
  ueCfgPath?: string;
  ueCfgValue?: unknown;
  status: RowStatus;
  section: string;
  note?: string;
}

export interface CompareResult {
  rows: CompareRow[];
  compared: number;
  differences: number;
  ok: boolean;
  counts: Record<RowStatus, number>;
  notes: string[];
}

// ── value comparison ─────────────────────────────────────────────────────────

/**
 * Compare values the way the two sides actually encode them. Every case is a
 * real representational difference: bandwidth is "5" in the GUI and 5 in the
 * cfg; sharedKey is lowercase in the GUI and uppercase in the cfg;
 * attach_pdn_type emits "non-ip" where the GUI stores "non_ip"; stagger
 * arithmetic produces values like 55804.999999960004.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-3;
  // The cfg writes some flags as 0/1 where the GUI holds false/true.
  if (typeof a === 'boolean' && typeof b === 'number') return Number(a) === b;
  if (typeof a === 'number' && typeof b === 'boolean') return a === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }

  const sa = String(a), sb = String(b);
  if (sa === sb) return true;
  const na = Number(sa), nb = Number(sb);
  if (sa.trim() !== '' && sb.trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return Math.abs(na - nb) < 1e-3;
  }
  const canon = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '');
  return canon(sa) === canon(sb);
}

// ── cell pairing ─────────────────────────────────────────────────────────────

const RAT_OF_CELLTYPE: Record<string, string> = { '5g': 'nr', '4g': 'lte', nbiot: 'nbiot' };
const GROUPS_OF_RATTYPE: Record<string, string[]> = {
  sa: ['nr'], nsa: ['lte', 'nr'], smartphone: ['lte'], nbiot: ['nbiot'], multirat: ['nr', 'lte'],
};

export interface CellPairing { intermediateIndex: number; groupIndex: number; cellIndex: number; path: string }

/**
 * Pair authored cells with ue.cfg cells.
 *
 * NOT a positional flatten. The cfg PARTITIONS the authored list by RAT while
 * the intermediate object keeps authoring order: a testcase authored 5g, 4g, 5g
 * becomes cfg groups [nr: 5g, 5g] and [lte: 4g], so pairing by position hands
 * the 4g cell's values to an NR cell. Verified 959/960 over 963 exports;
 * positional flattening mispairs 14 of them.
 */
export function pairCells(intermediate: any, ueCfg: any): CellPairing[] {
  const cells: any[] = intermediate?.cellConfig?.cells ?? [];
  const groups: any[] = ueCfg?.cell_groups ?? [];
  if (!cells.length || !groups.length) return [];

  const byRat = new Map<string, Array<{ gi: number; ci: number }>>();
  groups.forEach((g, gi) => (g?.cells ?? []).forEach((_c: any, ci: number) => {
    const rat = String(g?.group_type ?? '');
    if (!byRat.has(rat)) byRat.set(rat, []);
    byRat.get(rat)!.push({ gi, ci });
  }));

  const ratType = String(intermediate?.cellConfig?.master?.ratType ?? '').toLowerCase();
  const expected = GROUPS_OF_RATTYPE[ratType];
  const cursor = new Map<string, number>();
  const out: CellPairing[] = [];

  cells.forEach((c, i) => {
    let rat = RAT_OF_CELLTYPE[String(c?.cellType ?? '').toLowerCase()];
    // NB-IoT is authored as 4g but lands in an 'nbiot' group, and a single-RAT
    // testcase pairs unambiguously whatever it called itself.
    if (!rat || !byRat.has(rat)) {
      if (expected?.length === 1 && byRat.has(expected[0])) rat = expected[0];
      else if (byRat.size === 1) rat = [...byRat.keys()][0];
    }
    const slot = rat ? byRat.get(rat) : undefined;
    if (!slot) return;
    const k = cursor.get(rat!) ?? 0;
    const m = slot[k];
    if (!m) return;
    cursor.set(rat!, k + 1);
    out.push({ intermediateIndex: i, groupIndex: m.gi, cellIndex: m.ci, path: `cell_groups[${m.gi}].cells[${m.ci}]` });
  });
  return out;
}

// ── known to have no ue.cfg destination ──────────────────────────────────────

/**
 * Parameters that genuinely never reach the ue.cfg, each with the reason.
 *
 * Short on purpose. Everything else is SEARCHED — by normalised name, then by
 * value — and only reported as absent when that search comes up empty, so a
 * renamed parameter is found rather than declared missing.
 */
const NOT_EMITTED: Record<string, string> = {
  'subsConfig.subs[].networkSlicing':
    'slicing is signalled over NAS at registration, not encoded as a static ue.cfg field',
  'userPlaneConfig.profiles[].networkSlicingP':
    'slicing is signalled over NAS at registration, not encoded as a static ue.cfg field',
  'settings.successCriteriaName':
    'a post-run verdict rule applied to results, not an input to the simulator',
  'settings.description': 'free text carried for the GUI only',
  'userPlaneConfig.profiles[].pdnType':
    'a decoy: the cfg’s attach_pdn_type follows the SUBSCRIBER group’s pdnType, not the traffic profile’s. '
    + 'In the 10 corpus testcases where the two differ, the cfg follows the subscriber 10-0',
  'subsConfig.subs[].cellsLen':
    'a GUI mirror of the cell count; identical across every subscriber group in 207/207 multi-group exports, and it goes stale',
  'userPlaneConfig.profiles[].subsLen': 'a GUI mirror of the subscriber-group count; goes stale',
  'powerCycleConfig.profiles[].subsLen': 'a GUI mirror of the subscriber-group count; goes stale',
  'cellConfig.master.product': 'identifies which product authored the testcase',
  'cellConfig.cells[].productP': 'identifies which product authored the testcase',
};

/** Fields the cfg omits when they are off, so an authored `false` with no cfg
 *  key is honoured rather than dropped. */
const ABSENT_MEANS_FALSE = new Set([
  'cellConfig.cells[].channelSimP',
  'cellConfig.master.channelSim',
  'cellConfig.master.pdcchDecodeOpt',
]);

// ── authored-value transforms ────────────────────────────────────────────────

/** The authored value as the cfg would encode it. Only transforms verified
 *  against the corpus; anything else is compared as authored. */
const K = (authored: string) => normKey(authored);

/**
 * The authored value as the cfg would encode it.
 *
 * Keyed through normKey rather than by hand — writing 'cipheralgorithm' looked
 * right and was unreachable, because the normaliser sorts tokens and produces
 * 'algorithm_cipher'. Only transforms verified against the corpus are here.
 */
function expectedValue(name: string, raw: unknown): unknown {
  const k = normKey(name);
  if (k === K('band')) {
    // "n78" in the GUI, 78 in the cfg. mapping.ts does the same via bandNum().
    const m = String(raw).match(/[0-9]+/);
    return m ? Number(m[0]) : raw;
  }
  if (k === K('cipherAlgorithm') || k === K('integrityAlgorithm')) {
    // eeaN / neaN sets bit (7 - N): eea0+eea1+eea2 = 128+64+32 = 224.
    if (!Array.isArray(raw)) return raw;
    return raw.reduce((m: number, a: any) => m | (128 >> Number(String(a).replace(/[^0-9]/g, ''))), 0);
  }
  if (k === K('startingIMSI') || k === K('startingSUPI')) return String(raw).padStart(15, '0');
  if (k === K('sharedKey')) return String(raw).toUpperCase();
  if (k === K('test_name')) return `/tmp/${raw}.log`;
  return raw;
}

/**
 * Parameters whose cfg counterpart is an EXPANSION, not a copy.
 *
 * loggingProfileName "nas_rrc_debug" becomes a 13-clause log_options string, so
 * comparing them for equality is meaningless — the check is that the cfg has
 * the field at all.
 */
const PRESENCE_ONLY = new Set([K('loggingProfileName')]);

// ── flattening the authored side ─────────────────────────────────────────────

function sectionOf(path: string): string {
  if (path.startsWith('cellConfig')) return 'Cells';
  if (path.startsWith('subsConfig')) return 'Subscribers';
  if (path.startsWith('userPlaneConfig')) return 'Traffic';
  if (path.startsWith('powerCycleConfig')) return 'Power cycle';
  if (path.startsWith('mobilityConfig')) return 'Mobility';
  if (path.startsWith('settings')) return 'Settings';
  if (path.startsWith('Config_File')) return 'Generated config';
  return 'Other';
}

/**
 * Every authored leaf, as { path, value, name }.
 *
 * `name` is what the resolver matches on and is NOT just the last path segment:
 * it accumulates down the nesting, so dataBitrate.dl is searched for as
 * "dataBitrate dl" and finds bitrate_dl.
 *
 * A `{ unit, value }` pair is ONE parameter, not two — dataBitrate.dl is
 * `{unit:"mbps", value:1500}` and lands in the cfg as the single number 1500.
 * Emitting `.unit` separately would put "mbps" up against a number.
 */
function leaves(
  o: any, base: string, nameHint: string, out: Array<{ path: string; value: unknown; name: string }>,
): void {
  if (o === null || typeof o !== 'object') { out.push({ path: base, value: o, name: nameHint }); return; }

  if (Array.isArray(o)) {
    if (!o.length) { out.push({ path: base, value: [], name: nameHint }); return; }
    // An array of scalars is one parameter (cipherAlgorithm, subscriberGroup).
    if (o.every((v) => v === null || typeof v !== 'object')) { out.push({ path: base, value: o, name: nameHint }); return; }
    o.forEach((v, i) => leaves(v, `${base}[${i}]`, nameHint, out));
    return;
  }

  const keys = Object.keys(o);
  if (!keys.length) { out.push({ path: base, value: {}, name: nameHint }); return; }

  if (keys.length <= 2 && 'value' in o && keys.every((k) => k === 'value' || k === 'unit')) {
    out.push({ path: `${base}.value`, value: (o as any).value, name: nameHint });
    return;
  }

  for (const k of keys) {
    const childName = `${nameHint} ${k}`.trim();
    leaves(o[k], base ? `${base}.${k}` : k, childName, out);
  }
}

const pattern = (p: string) => p.replace(/\[\d+\]/g, '[]');

/**
 * The name to search the cfg for, taken from the path BELOW its element.
 *
 * Not the accumulated path: `subsConfig.subs[0].algorithm` must be searched for
 * as "algorithm", not "subsConfig subs algorithm" — the latter normalises to
 * `algorithm_sub_sub` and matches nothing, which is why every alias silently
 * failed to fire the first time. Nested keys below the element are kept, so
 * `dataBitrate.dl.value` is searched for as "dataBitrate dl" and finds
 * bitrate_dl. A trailing `value` is dropped: it came from a { unit, value }
 * wrapper and names nothing.
 */
export function searchNameFor(path: string): string {
  const rest = path
    .replace(/^cellConfig\.cells\[\d+\]\.?/, '')
    .replace(/^cellConfig\.master\.?/, '')
    .replace(/^subsConfig\.subs\[\d+\]\.?/, '')
    .replace(/^userPlaneConfig\.profiles\[\d+\]\.?/, '')
    .replace(/^powerCycleConfig\.profiles\[\d+\]\.?/, '')
    .replace(/^mobilityConfig\.profiles\[\d+\]\.?/, '')
    .replace(/^settings\.?/, '');
  const parts = (rest || path).split('.').filter((s) => s && !/^\d+$/.test(s));
  if (parts.length > 1 && parts[parts.length - 1] === 'value') parts.pop();
  return parts.join(' ');
}

/** ueCount lives under subscriberProfileInfo in the older schema; reading the
 *  flat key alone yields 0 there and collapses every segment onto offset 0. */
const ueCountOfSub = (s: any) => Number(s?.subscriberProfileInfo?.ueCount ?? s?.ueCount ?? 0);

/**
 * Where in the ue.cfg a given authored parameter could live, most specific
 * first. Searching a SCOPE rather than one field is what lets a renamed
 * parameter still be found.
 */
/**
 * Where authored userPlane profile `i` sits among the profiles of its OWN
 * dataType — its 0-based dense rank.
 *
 * The testcase numbers traffic profiles globally; ue.cfg buckets them by type
 * (`global_traffic.iperf[…]`, `global_traffic.ping[…]`). Indexing the cfg with
 * the authored index therefore lands on nothing as soon as a testcase mixes
 * types: on SA_2cell_32UEsEach_UDP_Ping, profile[1] (ping) was looked up as
 * global_traffic.ping[1] when the cfg holds a single ping at [0]. The scope
 * came back undefined, so the whole ping profile — packet_count, packet_size,
 * interval — was never in scope and every one of its parameters reported "not
 * honoured" with no cfg counterpart.
 */
export function trafficRank(profiles: any[], i: number): number {
  // No profile at that index means there is nothing to rank. Without this the
  // loop below counts every earlier absent profile as a same-type match (they
  // all normalise to the empty type) and returns i — a plausible-looking index
  // into a bucket that does not exist.
  if (!Array.isArray(profiles) || !profiles[i]) return 0;
  const type = String(profiles[i]?.dataType ?? '');
  let rank = 0;
  for (let k = 0; k < i; k++) if (String(profiles[k]?.dataType ?? '') === type) rank++;
  return rank;
}

function scopesFor(path: string, io: any, ue: any, pairs: CellPairing[], offsets: number[]): Scope[] {
  const out: Scope[] = [];
  const cellIdx = path.match(/^cellConfig\.cells\[(\d+)\]/);
  const subIdx = path.match(/^subsConfig\.subs\[(\d+)\]/);
  const upIdx = path.match(/^userPlaneConfig\.profiles\[(\d+)\]/);
  const pcIdx = path.match(/^powerCycleConfig\.profiles\[(\d+)\]/);

  if (cellIdx) {
    const p = pairs.find((x) => x.intermediateIndex === Number(cellIdx[1]));
    if (p) {
      out.push({ obj: ue?.cell_groups?.[p.groupIndex]?.cells?.[p.cellIndex], path: p.path });
      out.push({ obj: ue?.cell_groups?.[p.groupIndex], path: `cell_groups[${p.groupIndex}]` });
    }
    out.push({ obj: ue, path: '' });
  } else if (subIdx) {
    const i = Number(subIdx[1]);
    const base = offsets[i] ?? 0;
    out.push({ obj: ue?.ue_list?.[base], path: `ue_list[${base}]` });
    out.push({ obj: ue, path: '' });
  } else if (upIdx) {
    const i = Number(upIdx[1]);
    const profiles: any[] = io?.userPlaneConfig?.profiles ?? [];
    const type = String(profiles[i]?.dataType ?? '');
    // The authored index is global across every profile; the cfg numbers
    // traffic WITHIN each dataType. So authored profile 1 of a
    // [iperf, ping] testcase is global_traffic.ping[0], not ping[1] — the
    // same partition-then-rank shape pairCells handles for RAT.
    const rank = trafficRank(profiles, i);

    const slot = ue?.global_traffic?.[type]?.[rank];
    if (slot) {
      const id = Object.keys(slot)[0];
      out.push({ obj: slot[id], path: `global_traffic.${type}[${rank}].${id}` });
    }
    // ue_list[].traffic is a list of single-key objects, one per profile, and
    // NOT in the authored order — on a [iperf, ping] testcase the cfg had
    // [{ping}, {iperf}]. Select by type and rank rather than by position.
    //
    // And search EVERY UE, not just ue_list[0]. A profile belongs to a
    // subscriber group, so its traffic sits on that group's UEs: on
    // SA_2cell_32UEsEach_UDP_Ping the first 32 UEs run iperf and the second 32
    // run ping, so the ping profile's start_time lives at ue_list[32]. Looking
    // only at ue_list[0] found nothing and reported startDelay as a dropped
    // parameter when the cfg carried it correctly.
    const ueList: any[] = Array.isArray(ue?.ue_list) ? ue.ue_list : [];
    for (let n = 0; n < ueList.length; n++) {
      const entries: any[] = Array.isArray(ueList[n]?.traffic) ? ueList[n].traffic : [];
      const t = entries.filter((e) => e && e[type])[rank]?.[type]?.[0];
      if (t) { out.push({ obj: t, path: `ue_list[${n}].traffic.${type}[${rank}]` }); break; }
    }
    out.push({ obj: ue?.global_traffic, path: 'global_traffic' });
  } else if (pcIdx) {
    const ev = ue?.ue_list?.[0]?.sim_events;
    if (Array.isArray(ev)) {
      // sim_events is neither ordered nor a fixed pair — select by event name.
      const on = ev.find((e: any) => e?.event === 'power_on');
      const off = ev.find((e: any) => e?.event === 'power_off');
      const bag: any = {};
      if (on) bag.power_on_start_time = on.start_time;
      if (off) bag.power_off_start_time = off.start_time;
      if (Object.keys(bag).length) out.push({ obj: bag, path: 'ue_list[0].sim_events' });
    }
    out.push({ obj: ue?.ue_list?.[0], path: 'ue_list[0]' });
  } else if (path.startsWith('cellConfig.master')) {
    (ue?.cell_groups ?? []).forEach((g: any, gi: number) => out.push({ obj: g, path: `cell_groups[${gi}]` }));
    out.push({ obj: ue, path: '' });
  } else {
    out.push({ obj: ue, path: '' });
  }
  return out.filter((s) => s.obj && typeof s.obj === 'object');
}

// ── entry point ──────────────────────────────────────────────────────────────

export function compareCapture(ueCfg: any, testcaseExport: any): CompareResult {
  const rows: CompareRow[] = [];
  const notes: string[] = [];
  const zero = (): Record<RowStatus, number> =>
    ({ honoured: 0, mismatch: 0, 'not-honoured': 0, 'not-emitted': 0, 'no-rule': 0, 'cfg-only': 0 });

  const detail = testcaseExport?.test_case_details?.[0];
  const io = detail?.Test_Config_Intermediate_Object;
  const configFile = detail?.Config_File?.config;

  if (!ueCfg || typeof ueCfg !== 'object') {
    return { rows, compared: 0, differences: 0, ok: false, counts: zero(), notes: ['no ue.cfg to compare against'] };
  }
  if (!io && !configFile) {
    return { rows, compared: 0, differences: 0, ok: false, counts: zero(), notes: ['the export carries neither an intermediate object nor a Config_File'] };
  }

  if (io) {
    const pairs = pairCells(io, ueCfg);
    const cells: any[] = io?.cellConfig?.cells ?? [];
    const subs: any[] = io?.subsConfig?.subs ?? [];
    if (cells.length && !pairs.length) {
      notes.push('the authored cells could not be paired with the ue.cfg cell groups, so cell parameters were searched against the whole cfg');
    }

    const offsets: number[] = [];
    let base = 0;
    for (const s of subs) { offsets.push(base); base += ueCountOfSub(s); }
    const ueList: any[] = ueCfg?.ue_list ?? [];
    if (subs.length && base !== ueList.length) {
      notes.push(`subscriber groups declare ${base} UEs but the ue.cfg has ${ueList.length}; per-group values are read from each segment's first UE and may be misaligned`);
    }

    const authored: Array<{ path: string; value: unknown; name: string }> = [];
    leaves(io, '', '', authored);

    for (const { path, value, name } of authored) {
      const pat = pattern(path);
      const row: CompareRow = { testcasePath: path, testcaseValue: value, status: 'no-rule', section: sectionOf(path) };

      const why = NOT_EMITTED[pat];
      if (why) { row.status = 'not-emitted'; row.note = why; rows.push(row); continue; }

      const searchName = searchNameFor(path) || name;

      // rxGain / txGain are per ANTENNA, and the top-level rx_gain / tx_gain are
      // the per-cell arrays CONCATENATED across cells — so a cell's [10] belongs
      // against its own slice, not the whole array. Verified 526/526 on the
      // corpus. Written without a regex: a backslash in a template literal has
      // silently collapsed in this repo several times.
      const isGain = path.startsWith('cellConfig.cells[')
        && (path.endsWith('.rxGain') || path.endsWith('.txGain'));
      if (isGain && Array.isArray(value)) {
        const ci = Number(path.slice('cellConfig.cells['.length).split(']')[0]);
        const field = path.endsWith('.rxGain') ? 'rxGain' : 'txGain';
        const which = field === 'rxGain' ? 'rx_gain' : 'tx_gain';
        const all: any[] = Array.isArray(ueCfg?.[which]) ? ueCfg[which] : [];
        let off = 0;
        for (let k = 0; k < ci; k++) {
          const prev = (io?.cellConfig?.cells?.[k] ?? {})[field];
          off += Array.isArray(prev) ? prev.length : 0;
        }
        const slice = all.slice(off, off + value.length);
        row.ueCfgPath = `${which}[${off}..${off + value.length - 1}]`;
        row.ueCfgValue = slice;
        row.status = slice.length === value.length && valuesEqual(value, slice) ? 'honoured' : 'mismatch';
        row.note = `one entry per antenna; this cell owns ${which}[${off}..${off + value.length - 1}] of ${all.length}`;
        rows.push(row);
        continue;
      }

      // rxGain / txGain are per ANTENNA and the top-level arrays are the
      // per-cell arrays CONCATENATED across cells, so a cell's [10] belongs
      // against its own slice of rx_gain, not the whole thing. Verified
      // 526/526 against the corpus.
      const gain = path.match(/^cellConfig.cells[(d+)].(rxGain|txGain)$/);
      if (gain && Array.isArray(value)) {
        const ci = Number(gain[1]);
        const which = gain[2] === 'rxGain' ? 'rx_gain' : 'tx_gain';
        const all: any[] = Array.isArray(ueCfg?.[which]) ? ueCfg[which] : [];
        let off = 0;
        for (let k = 0; k < ci; k++) {
          const prev = (io?.cellConfig?.cells?.[k] ?? {})[gain[2]];
          off += Array.isArray(prev) ? prev.length : 0;
        }
        const slice = all.slice(off, off + value.length);
        row.ueCfgPath = `${which}[${off}..${off + value.length - 1}]`;
        row.ueCfgValue = slice;
        row.status = slice.length === value.length && valuesEqual(value, slice) ? 'honoured' : 'mismatch';
        row.note = `one entry per antenna; this cell owns ${which}[${off}..${off + value.length - 1}] of ${all.length}`;
        rows.push(row);
        continue;
      }
      const scopes = scopesFor(path, io, ueCfg, pairs, offsets);
      const expected = expectedValue(searchName, value);
      const hit = resolveParam(searchName, expected, scopes);

      if (hit && hit.value !== undefined) {
        const agrees = valuesEqual(expected, hit.value);
        if (PRESENCE_ONLY.has(normKey(searchName))) {
          // The cfg expands this into a different form — loggingProfileName
          // "nas_rrc_debug" becomes a 13-clause log_options string — so equality
          // is meaningless and presence is the check.
          row.ueCfgPath = hit.path.replace(/^\./, '');
          row.ueCfgValue = hit.value;
          row.status = 'honoured';
          row.note = 'the cfg expands this into a different form, so only its presence is checked';
        } else if (agrees || hit.firm) {
          // A firm match — exact normalised name or explicit alias — identifies
          // the field, so a disagreement is a real finding. A guessed match that
          // disagrees is far more likely to be the wrong field, and reporting
          // those as mismatches is what filled the table with false failures.
          row.ueCfgPath = hit.path.replace(/^\./, '');
          row.ueCfgValue = hit.value;
          row.status = agrees ? 'honoured' : 'mismatch';
          if (hit.how === 'value') row.note = 'matched by value — the cfg names this field differently';
          else if (hit.how === 'partial-name') row.note = 'matched on a partial name';
          if (row.status === 'mismatch' && expected !== value) {
            row.note = `${row.note ? row.note + '; ' : ''}expected ${JSON.stringify(expected)} in the cfg for this authored value`;
          }
        } else {
          row.status = 'no-rule';
          row.note = `the closest cfg field by name is ${hit.path.replace(/^\./, '')} = ${JSON.stringify(hit.value)}, `
            + 'but the names only partly agree, so it was not treated as this parameter’s counterpart';
        }
      } else if (ABSENT_MEANS_FALSE.has(pat) && (value === false || value === undefined)) {
        row.status = 'honoured';
        row.note = 'off, and the cfg omits this field when it is off';
      } else if (path.startsWith('cellConfig.cells[') && path.endsWith('.band')) {
        row.status = 'not-emitted';
        row.note = 'an LTE cell carries no band field — the band is implied by dl_earfcn, which is checked separately';
      } else if (path.startsWith('cellConfig.cells[') && path.endsWith('.scs')) {
        // Reached only when scs did NOT resolve, which on an NR cell it does
        // (subcarrier_spacing). LTE's subcarrier spacing is fixed at 15 kHz and
        // has no cfg field, but the GUI carries an scs value on every cell
        // regardless of RAT — so an LTE capture reported it as a dropped
        // parameter. It is a field that does not exist for this RAT.
        row.status = 'not-emitted';
        row.note = 'subcarrier spacing is an NR field — LTE is fixed at 15 kHz and the cfg has no counterpart';
      } else if (hasKnownCfgName(searchName)) {
        // We know what the cfg calls this one and it is not there. That is a
        // dropped parameter, not a gap in our coverage.
        row.status = 'not-honoured';
        row.note = 'this parameter has a known ue.cfg field, and the generated cfg does not contain it';
      } else {
        // Searched and genuinely not found. Reported, but not counted as a
        // failure: many GUI-side fields legitimately have no cfg destination,
        // and failing every capture on them would make the verdict useless.
        row.status = 'no-rule';
        row.note = `searched ${scopes.map((s) => s.path || 'the cfg root').join(', ')} by name and by value — no counterpart found`;
      }
      rows.push(row);
    }
  }

  // The export's own ue.cfg-shaped copy, against the real one. Field names are
  // identical on both sides here, so this half is a straight comparison — and a
  // difference means the box disagrees with itself.
  if (configFile) {
    const authored: Array<{ path: string; value: unknown; name: string }> = [];
    leaves(configFile, '', '', authored);
    for (const { path, value } of authored) {
      const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
        .map((k) => (/^\d+$/.test(k) ? Number(k) : k));
      const actual = keys.reduce((v: any, k) => (v === undefined || v === null ? undefined : v[k as any]), ueCfg);
      const row: CompareRow = {
        testcasePath: `Config_File.${path}`, testcaseValue: value,
        ueCfgPath: path, ueCfgValue: actual, section: 'Generated config', status: 'honoured',
      };
      if (actual === undefined) {
        if (value === false) { row.status = 'not-emitted'; row.note = 'written explicitly by the export; the cfg omits it when false'; }
        else { row.status = 'not-honoured'; row.note = 'present in the export’s config but absent from the generated ue.cfg'; }
      } else {
        row.status = valuesEqual(value, actual) ? 'honoured' : 'mismatch';
      }
      rows.push(row);
    }
  } else {
    notes.push('this export has no Config_File section, so only the authored parameters could be checked');
  }

  const counts = rows.reduce((acc, r) => { acc[r.status] += 1; return acc; }, zero());
  const differences = counts.mismatch + counts['not-honoured'];
  const compared = counts.honoured + differences;

  const rank: Record<RowStatus, number> = {
    mismatch: 0, 'not-honoured': 1, 'no-rule': 2, 'not-emitted': 3, 'cfg-only': 4, honoured: 5,
  };
  rows.sort((a, b) => rank[a.status] - rank[b.status] || a.testcasePath.localeCompare(b.testcasePath));

  if (counts['no-rule']) {
    notes.push(`${counts['no-rule']} authored parameter(s) were searched in the ue.cfg by name and by value and no counterpart was found; they are listed rather than counted either way`);
  }

  return { rows, compared, differences, ok: differences === 0, counts, notes };
}

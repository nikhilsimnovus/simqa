// Config-Fidelity mapping — declarative-ish rules that locate each input
// parameter inside the generated ue.cfg and assert it was honoured.
//
// Transforms here were derived from a real input-config ↔ ue.cfg pair (the
// diag fixture: NR-SA n78, 256 UEs, UDP) and corrected against the live box.
// Each checker is independent and additive; unmapped input fields surface as
// `no-rule` in the report so coverage gaps are explicit.

import type { InputConfig, UeCfg, ParamResult, Criticality } from './types';
import { featureCriticality } from './features';

// ---------- small helpers ----------

const ci = (s: unknown) => String(s ?? '').toLowerCase();

function res(
  p: Omit<ParamResult, 'status'> & { status?: ParamResult['status'] },
): ParamResult {
  return { status: 'honoured', ...p };
}

/** Compare expected vs actual; produce honoured | missing | mismatch. */
function check(
  base: { inputPath: string; ueCfgPath?: string; label: string; feature: string; criticality: Criticality },
  expected: unknown,
  actual: unknown,
  opts: { eq?: (a: any, b: any) => boolean } = {},
): ParamResult {
  if (actual === undefined || actual === null) {
    return res({ ...base, status: 'missing', expected, actual, detail: 'not present in ue.cfg' });
  }
  const eq = opts.eq ?? ((a, b) => a === b);
  if (eq(expected, actual)) return res({ ...base, status: 'honoured', expected, actual });
  return res({ ...base, status: 'mismatch', expected, actual });
}

/** Flatten every cell across cell_groups, tagging its group_type + indices. */
function ueCells(ue: UeCfg): Array<{ cell: any; group: any; gi: number; ci: number }> {
  const out: Array<{ cell: any; group: any; gi: number; ci: number }> = [];
  const groups: any[] = Array.isArray(ue?.cell_groups) ? ue.cell_groups : [];
  groups.forEach((group, gi) => {
    const cells: any[] = Array.isArray(group?.cells) ? group.cells : [];
    cells.forEach((cell, ci2) => out.push({ cell, group, gi, ci: ci2 }));
  });
  return out;
}

/** Match an input cell to a ue.cfg cell by sync_id, else by ordinal index. */
function matchCell(inputCell: any, idx: number, ue: UeCfg) {
  const all = ueCells(ue);
  const bySync = all.find((c) => inputCell?.syncId !== undefined && c.cell?.sync_id === inputCell.syncId);
  return bySync ?? all[idx];
}

/** NR band "n78" → 78; LTE band "1"/1 → 1. */
function bandNum(band: unknown): number | undefined {
  if (band === undefined || band === null) return undefined;
  const m = String(band).match(/\d+/);
  return m ? Number(m[0]) : undefined;
}

/** ratType → expected ue.cfg group_type(s). */
function expectedGroupTypes(ratType: string | undefined): string[] {
  switch (ci(ratType)) {
    case 'sa': return ['nr'];
    case 'nsa': return ['lte', 'nr'];
    case 'smartphone': return ['lte'];
    case 'nbiot': return ['lte']; // NB-IoT rides an LTE group on this product
    case 'multirat': return ['nr', 'lte'];
    default: return [];
  }
}

/** ["nea0","nea1","nea2"] → 224 (each algo n sets bit (5+n)). Same scheme for nia. */
function algoBitmap(list: unknown): number | undefined {
  if (!Array.isArray(list)) return undefined;
  let bm = 0;
  for (const a of list) {
    const m = String(a).match(/(?:nea|nia|eea|eia)(\d)/i);
    if (m) bm |= 1 << (5 + Number(m[1]));
  }
  return bm;
}

// ---------- checkers ----------

export interface Checker {
  feature: string;
  run: (input: InputConfig, ue: UeCfg) => ParamResult[];
}

const cellsChecker: Checker = {
  feature: 'cell',
  run: (input, ue) => {
    const out: ParamResult[] = [];
    const cells = input.cellConfig?.cells ?? [];
    cells.forEach((c, i) => {
      const m = matchCell(c, i, ue);
      const path = `cellConfig.cells[${i}]`;
      const up = m ? `cell_groups[${m.gi}].cells[${m.ci}]` : undefined;
      const B = (label: string, crit: Criticality = 'critical') => ({ inputPath: `${path}`, ueCfgPath: up, label, feature: 'cell', criticality: crit });
      if (!m) {
        out.push(res({ ...B('cell present'), status: 'missing', expected: c.band, detail: 'no matching cell in ue.cfg' }));
        return;
      }
      const cell = m.cell;
      // NR cells carry a numeric `band`; LTE cells do NOT — the band is implied
      // by dl_earfcn (asserted separately below). Only check `band` when the
      // generated cell actually has the field (NR) or the input is NR (NRARFCN).
      if (cell.band !== undefined || c.NRARFCN) {
        out.push(check({ ...B('band'), inputPath: `${path}.band`, ueCfgPath: `${up}.band` }, bandNum(c.band), cell.band));
      }
      out.push(check({ ...B('bandwidth'), inputPath: `${path}.bandwidth`, ueCfgPath: `${up}.bandwidth` }, Number(c.bandwidth), cell.bandwidth));
      if (c.scs !== undefined)
        out.push(check({ ...B('scs'), inputPath: `${path}.scs`, ueCfgPath: `${up}.subcarrier_spacing` }, Number(c.scs), cell.subcarrier_spacing));
      if (c.antennas?.dl !== undefined)
        out.push(check({ ...B('antennas.dl'), inputPath: `${path}.antennas.dl`, ueCfgPath: `${up}.n_antenna_dl` }, Number(c.antennas.dl), cell.n_antenna_dl));
      if (c.antennas?.ul !== undefined)
        out.push(check({ ...B('antennas.ul'), inputPath: `${path}.antennas.ul`, ueCfgPath: `${up}.n_antenna_ul` }, Number(c.antennas.ul), cell.n_antenna_ul));
      if (c.prach !== undefined)
        out.push(check({ ...B('prach', 'normal'), inputPath: `${path}.prach`, ueCfgPath: `${up}.prach_delay` }, Number(c.prach), cell.prach_delay));
      // ARFCN (NR) / EARFCN (LTE)
      if (c.NRARFCN?.dl !== undefined)
        out.push(check({ ...B('NRARFCN.dl'), inputPath: `${path}.NRARFCN.dl`, ueCfgPath: `${up}.dl_nr_arfcn` }, Number(c.NRARFCN.dl), cell.dl_nr_arfcn));
      if (c.NRARFCN?.ssb !== undefined)
        out.push(check({ ...B('NRARFCN.ssb'), inputPath: `${path}.NRARFCN.ssb`, ueCfgPath: `${up}.ssb_nr_arfcn` }, Number(c.NRARFCN.ssb), cell.ssb_nr_arfcn));
      if (c.NRARFCN?.ul !== undefined)
        out.push(check({ ...B('NRARFCN.ul', 'normal'), inputPath: `${path}.NRARFCN.ul`, ueCfgPath: `${up}.ul_nr_arfcn` }, Number(c.NRARFCN.ul), cell.ul_nr_arfcn));
      if (c.EARFCN?.dl !== undefined)
        out.push(check({ ...B('EARFCN.dl'), inputPath: `${path}.EARFCN.dl`, ueCfgPath: `${up}.dl_earfcn` }, Number(c.EARFCN.dl), cell.dl_earfcn));
      if (c.EARFCN?.ul !== undefined)
        out.push(check({ ...B('EARFCN.ul', 'normal'), inputPath: `${path}.EARFCN.ul`, ueCfgPath: `${up}.ul_earfcn` }, Number(c.EARFCN.ul), cell.ul_earfcn));
    });
    return out;
  },
};

const ratTypeChecker: Checker = {
  feature: 'cell',
  run: (input, ue) => {
    const ratType = input.cellConfig?.master?.ratType;
    if (!ratType) return [];
    const want = expectedGroupTypes(ratType);
    const got = ueCells(ue).map((c) => c.group?.group_type).filter(Boolean);
    const ok = want.every((w) => got.includes(w));
    return [res({
      inputPath: 'cellConfig.master.ratType', ueCfgPath: 'cell_groups[].group_type',
      label: 'ratType → group_type', feature: 'cell', criticality: 'critical',
      status: ok ? 'honoured' : (got.length ? 'mismatch' : 'missing'),
      expected: want, actual: Array.from(new Set(got)),
    })];
  },
};

const ueCountChecker: Checker = {
  feature: 'subscriber',
  run: (input, ue) => {
    const subs = input.subsConfig?.subs ?? [];
    if (!subs.length) return [];
    const want = subs.reduce((n, s) => n + (Number(s.ueCount) || 0), 0);
    const got = Array.isArray(ue?.ue_list) ? ue.ue_list.length : undefined;
    return [check(
      { inputPath: 'subsConfig.subs[].ueCount', ueCfgPath: 'ue_list.length', label: 'total UE count', feature: 'subscriber', criticality: 'critical' },
      want, got,
    )];
  },
};

const subscriberChecker: Checker = {
  feature: 'subscriber',
  run: (input, ue) => {
    const out: ParamResult[] = [];
    const subs = input.subsConfig?.subs ?? [];
    const list: any[] = Array.isArray(ue?.ue_list) ? ue.ue_list : [];
    subs.forEach((s, i) => {
      // Representative UE for this group = first ue_list entry on its serving cell.
      const cellIdx = Number(s.servingCell ?? 0);
      const u = list.find((x) => x.cell_index === cellIdx) ?? list[0];
      const path = `subsConfig.subs[${i}]`;
      if (!u) {
        out.push(res({ inputPath: path, label: 'subscriber present', feature: 'subscriber', criticality: 'critical', status: 'missing' }));
        return;
      }
      const B = (field: string, label: string, crit: Criticality = 'normal') => ({ inputPath: `${path}.${field}`, ueCfgPath: `ue_list[].${label}`, label, feature: 'subscriber', criticality: crit });
      if (s.algorithm !== undefined) out.push(check({ ...B('algorithm', 'sim_algo', 'critical') }, ci(s.algorithm), ci(u.sim_algo), { eq: (a, b) => a === b }));
      if (s.asRelease !== undefined) out.push(check({ ...B('asRelease', 'as_release') }, Number(s.asRelease), u.as_release));
      if (s.ueCategory !== undefined) out.push(check({ ...B('ueCategory', 'ue_category') }, ci(s.ueCategory), ci(u.ue_category)));
      if (s.pdnType !== undefined) out.push(check({ ...B('pdnType', 'attach_pdn_type') }, ci(s.pdnType), ci(u.attach_pdn_type)));
      if (s.powerControl !== undefined) out.push(check({ ...B('powerControl', 'power_control_enabled') }, !!s.powerControl, !!u.power_control_enabled));
      if (s.imeisv) out.push(check({ ...B('imeisv', 'imeisv') }, String(s.imeisv), String(u.imeisv)));
      if (s.sharedKey) out.push(check({ ...B('sharedKey', 'K', 'critical') }, ci(s.sharedKey), ci(u.K)));
      if (Array.isArray(s.cipherAlgorithm)) out.push(check({ ...B('cipherAlgorithm', 'cipher_algo_bitmap') }, algoBitmap(s.cipherAlgorithm), u.cipher_algo_bitmap));
      if (Array.isArray(s.integrityAlgorithm)) out.push(check({ ...B('integrityAlgorithm', 'integ_algo_bitmap') }, algoBitmap(s.integrityAlgorithm), u.integ_algo_bitmap));
    });
    return out;
  },
};

const featureFlagChecker: Checker = {
  feature: 'feature-flag',
  run: (input, ue) => {
    const out: ParamResult[] = [];
    const subs = input.subsConfig?.subs ?? [];
    const list: any[] = Array.isArray(ue?.ue_list) ? ue.ue_list : [];
    const u0 = list[0];
    subs.slice(0, 1).forEach((s) => {
      // Network slicing: enable → expect nssai/snssai on the UE; disable → absent.
      if (s.networkSlicing !== undefined) {
        const enabled = ci(s.networkSlicing) === 'enable';
        const hasSlice = !!(u0 && (u0.nssai || u0.snssai || u0.slice || u0.s_nssai));
        out.push(res({
          inputPath: 'subsConfig.subs[0].networkSlicing', ueCfgPath: 'ue_list[].nssai',
          label: 'network slicing', feature: 'feature-flag', criticality: featureCriticality('networkSlicing'),
          status: enabled === hasSlice ? 'honoured' : 'mismatch',
          expected: enabled ? 'nssai present' : 'no nssai', actual: hasSlice ? 'nssai present' : 'no nssai',
        }));
      }
      // Unified Access Control: access_control_classes / uac_access_identities present → expect on UE.
      if (Array.isArray(s.access_control_classes) && s.access_control_classes.length) {
        const has = !!(u0 && (u0.access_control_classes || u0.uac || u0.acc));
        out.push(res({
          inputPath: 'subsConfig.subs[0].access_control_classes', ueCfgPath: 'ue_list[].access_control_classes',
          label: 'unified access control', feature: 'feature-flag', criticality: featureCriticality('uac'),
          status: has ? 'honoured' : 'missing', expected: s.access_control_classes, actual: has ? 'present' : 'absent',
        }));
      }
    });
    return out;
  },
};

const userPlaneChecker: Checker = {
  feature: 'user-plane',
  run: (input, ue) => {
    const out: ParamResult[] = [];
    const profiles = input.userPlaneConfig?.profiles ?? [];
    const gt = ue?.global_traffic ?? {};
    profiles.forEach((p, i) => {
      const path = `userPlaneConfig.profiles[${i}]`;
      if (ci(p.dataType) === 'no_data') return;
      // iperf profile in global_traffic.iperf[0].iperf<N>
      const iperfArr: any[] = Array.isArray(gt.iperf) ? gt.iperf : [];
      const prof = iperfArr.map((o) => o[Object.keys(o)[0]]).find(Boolean);
      if (!prof) {
        out.push(res({ inputPath: `${path}.dataType`, ueCfgPath: 'global_traffic.iperf', label: 'traffic profile', feature: 'user-plane', criticality: 'normal', status: 'missing', expected: p.dataType }));
        return;
      }
      if (p.transportProtocol) out.push(check({ inputPath: `${path}.transportProtocol`, ueCfgPath: 'global_traffic.iperf[].type', label: 'transport', feature: 'user-plane', criticality: 'normal' }, ci(p.transportProtocol), ci(prof.type)));
      if (p.serverIpAddress) out.push(check({ inputPath: `${path}.serverIpAddress`, ueCfgPath: 'global_traffic.iperf[].dest_ip', label: 'server IP', feature: 'user-plane', criticality: 'normal' }, p.serverIpAddress, prof.dest_ip));
      if (p.dataBitrate?.dl?.value !== undefined) out.push(check({ inputPath: `${path}.dataBitrate.dl`, ueCfgPath: 'global_traffic.iperf[].bitrate_dl', label: 'DL bitrate', feature: 'user-plane', criticality: 'normal' }, Number(p.dataBitrate.dl.value), prof.bitrate_dl));
      if (p.dataBitrate?.ul?.value !== undefined) out.push(check({ inputPath: `${path}.dataBitrate.ul`, ueCfgPath: 'global_traffic.iperf[].bitrate_ul', label: 'UL bitrate', feature: 'user-plane', criticality: 'normal' }, Number(p.dataBitrate.ul.value), prof.bitrate_ul));
    });
    return out;
  },
};

const settingsChecker: Checker = {
  feature: 'settings',
  run: (input, ue) => {
    const out: ParamResult[] = [];
    const s = input.settings ?? {};
    const name = s.test_name ?? s.testCaseName;
    if (name && ue?.log_filename) {
      const base = String(ue.log_filename).split('/').pop()?.replace(/\.log$/, '');
      out.push(check({ inputPath: 'settings.test_name', ueCfgPath: 'log_filename', label: 'test name → log_filename', feature: 'settings', criticality: 'normal' }, String(name), base));
    }
    if (s.loggingProfileName && typeof ue?.log_options === 'string') {
      // rrc_debug profile should turn rrc logging to debug.
      const wantRrcDebug = ci(s.loggingProfileName).includes('rrc');
      if (wantRrcDebug) {
        const has = /rrc\.level\s*=\s*debug/i.test(ue.log_options);
        out.push(res({ inputPath: 'settings.loggingProfileName', ueCfgPath: 'log_options', label: 'logging profile (rrc debug)', feature: 'settings', criticality: 'normal', status: has ? 'honoured' : 'mismatch', expected: 'rrc.level=debug', actual: has ? 'rrc.level=debug' : '(not set)' }));
      }
    }
    return out;
  },
};

export const CHECKERS: Checker[] = [
  cellsChecker, ratTypeChecker, ueCountChecker, subscriberChecker,
  featureFlagChecker, userPlaneChecker, settingsChecker,
];

// Exposed for unit tests.
export const _internals = { bandNum, algoBitmap, expectedGroupTypes, ueCells, matchCell };

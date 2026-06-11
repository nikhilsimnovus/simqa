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
    case 'nbiot': return ['nbiot']; // NB-IoT cell group reports its own 'nbiot' group_type (verified live on 192.168.10.202)
    case 'multirat': return ['nr', 'lte'];
    default: return [];
  }
}

/** Canonicalise an NB-IoT deployment/operation mode value (GUI or ue.cfg).
 *  GUI side: cellType / operation-mode-style values ("in-band", "guardBand",
 *  "standalone", ...). ue.cfg side: `operation_mode` — "standalone" matches
 *  the vetted master-all-rats.csv cfg snippets; the "same_pci"/"different_pci"
 *  (in-band) and "guardband" (guard-band) encodings are derived from eNB-SIDE
 *  callbox samples (callbox_configs/extracted/enb-nbiot.cfg.bak) and remain
 *  UNVERIFIED for ue.cfg until a live NB-IoT cfg is captured. Returns
 *  undefined for values that carry no mode information (e.g. cellType '4g'). */
function nbiotMode(v: unknown): 'standalone' | 'in-band' | 'guard-band' | undefined {
  const s = ci(v).replace(/[\s_-]/g, '');
  if (!s) return undefined;
  if (s.includes('standalone')) return 'standalone';
  if (s.includes('guard')) return 'guard-band';
  if (s.includes('samepci') || s.includes('differentpci') || s.includes('inband')) return 'in-band';
  return undefined;
}

/** First key on `obj` whose name looks like a deployment/operation mode.
 *  `operation_mode` is the conventional name (CSV snippets + the eNB-side
 *  callbox sample — like the mode encodings above, the ue.cfg key name
 *  remains UNVERIFIED until a live NB-IoT cfg is captured); scan for
 *  operation/deployment variants so a renamed key still matches. */
function modeEntry(obj: any): { key: string; value: unknown } | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj.operation_mode !== undefined) return { key: 'operation_mode', value: obj.operation_mode };
  for (const [k, v] of Object.entries(obj)) {
    if (/operation|deployment/i.test(k) && v !== undefined && v !== null) return { key: k, value: v };
  }
  return undefined;
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

// NB-IoT structural fidelity (SIM40-2311 / SIM40-2312).
//
// The generator shipped UNBOOTABLE NB-IoT ue.cfgs: it dropped the per-UE
// ue_category nb1/nb2 (SIM40-2311, asserted in subscriberChecker) and silently
// reset an in-band cell's deployment mode to standalone (SIM40-2312). This
// checker engages ONLY when master.ratType === 'nbiot', so NR/LTE cases are
// completely unaffected.
const nbiotChecker: Checker = {
  feature: 'cell',
  run: (input, ue) => {
    if (ci(input.cellConfig?.master?.ratType) !== 'nbiot') return [];
    const out: ParamResult[] = [];
    const cells = input.cellConfig?.cells ?? [];
    const groups = new Set(ueCells(ue).map((x) => x.group));

    cells.forEach((c, i) => {
      const m = matchCell(c, i, ue);
      if (!m) return; // cellsChecker already reports the missing cell.
      const path = `cellConfig.cells[${i}]`;
      const up = `cell_groups[${m.gi}].cells[${m.ci}]`;

      // Deployment / operation mode (SIM40-2312: in-band reset to standalone).
      // GUI side: the cellType carries the mode for NB-IoT (standalone /
      // in-band / guard-band); tolerate an operation/deployment-named field
      // too (same fuzzy contract as the apiTester completeness check).
      const guiModeRaw = nbiotMode(c.cellType) !== undefined
        ? { key: 'cellType', value: c.cellType }
        : modeEntry(c);
      const cfgMode = modeEntry(m.cell) ?? modeEntry(m.group);
      const want = guiModeRaw ? nbiotMode(guiModeRaw.value) : undefined;
      if (want) {
        out.push(res({
          inputPath: `${path}.${guiModeRaw!.key}`,
          ueCfgPath: `${up}.${cfgMode?.key ?? 'operation_mode'}`,
          label: 'NB-IoT deployment mode', feature: 'cell',
          // A dropped/reset mode on an in-band or guard-band cell IS the
          // unbootable-config bug; for standalone a missing key may just be
          // the generator relying on the default — surface, don't fail.
          criticality: want === 'standalone' ? 'normal' : 'critical',
          // Encoding-level disagreement is 'no-rule', NOT 'mismatch': the
          // ue.cfg mode encodings are eNB-side-derived and UNVERIFIED (see
          // nbiotMode doc), so it surfaces in the report without failing the
          // case on a guessed encoding until a live NB-IoT cfg is captured.
          status: cfgMode === undefined ? 'missing'
            : nbiotMode(cfgMode.value) === want ? 'honoured' : 'no-rule',
          expected: want, actual: cfgMode?.value,
          detail: cfgMode === undefined
            ? 'no operation/deployment mode in ue.cfg (SIM40-2312: mode dropped/reset → unbootable NB-IoT config, SIM40-2311)'
            : nbiotMode(cfgMode.value) === undefined
              ? `unrecognised mode value "${cfgMode.value}" — review encoding`
              : undefined,
        }));
      } else {
        // No GUI mode on this case (e.g. generic '4g' cellType) — still assert
        // the generated NB-IoT cell carries SOME mode, since the vetted master
        // CSV snippets always do. Reported, not case-failing ('normal'),
        // because we could not regenerate a live NB-IoT ue.cfg to confirm the
        // key is mandatory for standalone.
        out.push(res({
          inputPath: path, ueCfgPath: `${up}.operation_mode`,
          label: 'NB-IoT operation_mode present', feature: 'cell', criticality: 'normal',
          status: cfgMode !== undefined ? 'honoured' : 'missing',
          expected: '(any deployment mode)', actual: cfgMode?.value,
          detail: cfgMode === undefined ? 'NB-IoT cell has no operation/deployment mode key (SIM40-2312 signature)' : undefined,
        }));
      }

      // global_timing_advance must be present on an NB-IoT cell (SIM40-2311:
      // the unbootable cfgs also shipped without the NB-IoT group timing
      // fields). Presence-only — the GUI value (-1 = auto) encoding is not
      // re-checkable until the lab can generate a real NB-IoT ue.cfg.
      if (c.globalTimingAdvance !== undefined) {
        const gta = m.cell?.global_timing_advance ?? m.group?.global_timing_advance ?? (ue as any)?.global_timing_advance;
        out.push(res({
          inputPath: `${path}.globalTimingAdvance`, ueCfgPath: `${up}.global_timing_advance`,
          label: 'NB-IoT global_timing_advance present', feature: 'cell', criticality: 'normal',
          status: gta !== undefined && gta !== null ? 'honoured' : 'missing',
          expected: '(present)', actual: gta ?? undefined,
        }));
      }
    });

    // multi_ue must be true for the NB-IoT cell group (SIM40-2311: without it
    // the multi-UE NB-IoT config does not boot). Group-level per the
    // cell_groups convention; tolerate a root-level fallback. 'normal' (not
    // case-failing on absence) and an explicit `false` is downgraded to
    // 'no-rule' (reported, not case-failing) until a live NB-IoT ue.cfg
    // confirms the key name/placement.
    const g0 = [...groups].find((g) => ci(g?.group_type) === 'nbiot') ?? [...groups][0];
    const multiUe = g0?.multi_ue ?? (ue as any)?.multi_ue;
    out.push(res({
      inputPath: 'cellConfig.master.ratType', ueCfgPath: 'cell_groups[].multi_ue',
      label: 'NB-IoT multi_ue', feature: 'cell', criticality: 'normal',
      status: multiUe === undefined || multiUe === null ? 'missing' : multiUe === true ? 'honoured' : 'no-rule',
      expected: true, actual: multiUe ?? undefined,
    }));

    // multi_carrier only when non-anchor carriers are configured (SIM40-2311
    // family: spurious/missing carrier flags also yield non-booting configs).
    // "Configured" = any input cell carries a non-anchor list, or the
    // subscriber group enables multiCarrier. Like multi_ue, value-level
    // disagreement (either direction) is 'no-rule', not 'mismatch', until a
    // live NB-IoT ue.cfg confirms the key name/placement.
    const subs = input.subsConfig?.subs ?? [];
    const nonAnchor = cells.some((c) => Object.entries(c ?? {}).some(([k, v]) =>
      /non.?anchor/i.test(k) && (Array.isArray(v) ? v.length > 0 : !!v)));
    const wantMc = nonAnchor || subs.some((s) => s.multiCarrier === true);
    const list: any[] = Array.isArray(ue?.ue_list) ? ue.ue_list : [];
    const mc = g0?.multi_carrier ?? (ue as any)?.multi_carrier ?? list[0]?.multi_carrier;
    if (wantMc) {
      out.push(res({
        inputPath: nonAnchor ? 'cellConfig.cells[].nonAnchor' : 'subsConfig.subs[].multiCarrier',
        ueCfgPath: 'cell_groups[].multi_carrier',
        label: 'NB-IoT multi_carrier', feature: 'cell', criticality: 'normal',
        status: mc === undefined || mc === null ? 'missing' : mc === true ? 'honoured' : 'no-rule',
        expected: true, actual: mc ?? undefined,
      }));
    } else if (mc === true) {
      // Spurious multi_carrier with no non-anchor carriers configured.
      out.push(res({
        inputPath: 'subsConfig.subs[].multiCarrier', ueCfgPath: 'cell_groups[].multi_carrier',
        label: 'NB-IoT multi_carrier (unexpected)', feature: 'cell', criticality: 'normal',
        status: 'no-rule', expected: '(absent/false — no non-anchor carriers configured)', actual: mc,
        detail: 'ue.cfg enables multi_carrier but the testcase configures no non-anchor carriers',
      }));
    }

    return out;
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
      if (s.ueCategory !== undefined) {
        const cat = ci(s.ueCategory);
        if (cat.startsWith('nb')) {
          // NB-IoT: the box encodes the category as an Amarisoft numeric code
          // (Cat-NB1 -> -2), not the 'nbN' string. Compare against the verified
          // mapping; surface an unmapped-but-PRESENT NB-IoT category as a
          // coverage gap (no-rule) rather than a false mismatch — never guess
          // the encoding (Cat-NB2's code is unverified until the lab can
          // generate a live NB-IoT ue.cfg again).
          // A DROPPED ue_category is different: that is SIM40-2311 (generator
          // omitted ue_category nb1/nb2 entirely → unbootable NB-IoT config),
          // so absence is a CRITICAL miss for nb1 AND nb2 alike.
          const NBIOT_UE_CATEGORY: Record<string, string> = { nb1: '-2' }; // verified live on 192.168.10.202
          const exp = NBIOT_UE_CATEGORY[cat];
          if (u.ue_category === undefined || u.ue_category === null) {
            out.push(res({ ...B('ueCategory', 'ue_category', 'critical'), status: 'missing', expected: exp ?? cat, detail: 'ue_category dropped from ue.cfg — NB-IoT UE cannot boot (SIM40-2311)' }));
          } else if (exp !== undefined) {
            out.push(check({ ...B('ueCategory', 'ue_category', 'critical') }, exp, ci(u.ue_category)));
          } else {
            out.push(res({ ...B('ueCategory', 'ue_category'), status: 'no-rule', expected: cat, actual: ci(u.ue_category), detail: `NB-IoT ue_category "${cat}" encoding not yet mapped (box uses an Amarisoft numeric code)` }));
          }
        } else {
          out.push(check({ ...B('ueCategory', 'ue_category') }, ci(s.ueCategory), ci(u.ue_category)));
        }
      }
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
      // Network slicing is signaled via NAS/registration, not encoded as a
      // static ue.cfg field on the UE-sim — so it is NOT validatable from
      // ue.cfg. Surface it as informational (no-rule), never a pass/fail.
      if (s.networkSlicing !== undefined) {
        out.push(res({
          inputPath: 'subsConfig.subs[0].networkSlicing', ueCfgPath: '(n/a)',
          label: 'network slicing', feature: 'feature-flag', criticality: 'non-critical',
          status: 'no-rule',
          detail: 'slicing is NAS-signaled, not a static ue.cfg field — not validatable here',
          expected: ci(s.networkSlicing), actual: 'n/a',
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
  cellsChecker, ratTypeChecker, nbiotChecker, ueCountChecker, subscriberChecker,
  featureFlagChecker, userPlaneChecker, settingsChecker,
];

// Exposed for unit tests.
export const _internals = { bandNum, algoBitmap, expectedGroupTypes, ueCells, matchCell, nbiotMode, modeEntry };

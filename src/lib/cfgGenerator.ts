// Simnovus cfg generator. Translates a UESIM testDefinition (the JSON
// returned by /v2/testcases/{id}) into a bundle of cfg files that
// lteenb / ltemme / ltesim_server can consume.
//
// Strategy: template-fill for top-level boilerplate (#defines, log
// options, RF driver, AMF/MME addresses) + synthesis for the variable-
// length lists (nr_cell_list, cell_list, pdn_list, ue_db) so the size
// and shape match the testcase exactly.
//
// See ../docs/mapping.md for the field-to-knob mapping.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ---------- Templates loaded once at module init ----------
// Resolved relative to *this source file* so the package works from any cwd.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATES_DIR = path.join(__dirname, 'cfgTemplates');
const TPL = {
  gnbSa: fs.readFileSync(path.join(TEMPLATES_DIR, 'gnb-sa.cfg'), 'utf8'),
  enb:   fs.readFileSync(path.join(TEMPLATES_DIR, 'enb.cfg'),    'utf8'),
  mme:   fs.readFileSync(path.join(TEMPLATES_DIR, 'mme.cfg'),    'utf8'),
  ims:   fs.readFileSync(path.join(TEMPLATES_DIR, 'ims.cfg'),    'utf8'),
};

// ---------- Tables ----------

// LTE bandwidth (MHz, string) -> N_RB_DL
const LTE_NRB: Record<string, number> = {
  '1.4': 6, '3': 15, '5': 25, '10': 50, '15': 75, '20': 100,
};

const IMS_REALM_DEFAULT = 'ims.mnc001.mcc001.3gppnetwork.org';
const IMS_PCSCF_DEFAULT = '192.168.4.1';

// ---------- FLAT / NESTED field access ----------
// The box stores a testDefinition in TWO layouts and which one you get depends
// on how the testcase was written:
//   NESTED  subs[].subscriberProfileInfo.ueCount, cells[].cellRadioInfo.NRARFCN
//   FLAT    subs[].ueCount,                       cells[].NRARFCN
// FLAT is what the REST API writes, so most testcases on the box use it.
// Reading only NESTED silently fell back to defaults — every FLAT testcase
// previewed as "1 UE" with no traffic, and its generated ue_db held one
// subscriber instead of hundreds. Read both, nested first.

/** First non-nullish value among dotted paths. */
function pick<T = any>(obj: any, ...paths: string[]): T | undefined {
  for (const p of paths) {
    let cur: any = obj;
    for (const key of p.split('.')) {
      if (cur == null) break;
      cur = cur[key];
    }
    if (cur !== undefined && cur !== null) return cur as T;
  }
  return undefined;
}

/** UEs in one subscriber group, both layouts. */
function subUeCount(sg: any): number {
  return Math.max(0, Number(pick(sg, 'subscriberProfileInfo.ueCount', 'ueCount') ?? 0));
}

/** Total UEs across every subscriber group (0 when there are none). */
function totalUeCount(td: UesimTestDefinition): number {
  return (td.subsConfig?.subs ?? []).reduce((acc, s) => acc + subUeCount(s), 0);
}

/** Identity range start for a group, both layouts and both RAT families. */
function subStartId(sg: any): string | number | undefined {
  return pick(sg,
    'subscriberProfileInfo.startingSUPI', 'startingSUPI',
    'subscriberProfileInfo.startingIMSI', 'startingIMSI');
}

/** A userPlane profile's dataType / apnName, both layouts. */
function profileDataType(p: any): string | undefined { return pick(p, 'dataGeneralInfo.dataType', 'dataType'); }
function profileApn(p: any): string | undefined { return pick(p, 'dataGeneralInfo.apnName', 'apnName'); }

// ---------- Loose UESIM testDefinition types ----------
// We model only the fields the generator reads. Everything else is `any`
// so we don't fight the schema as it evolves.

export interface UesimCell {
  cellBandwidthInfo?: { bandwidth?: string | number };
  cellCarrierConfig?: {
    ScsInfo?: { scs?: number };
    gainInfo?: { rxGain?: number[] | number; txGain?: number[] | number };
  };
  cellConfig?: {
    NTN?: boolean;
    band?: string | number;
    cellType?: '4g' | '5g';
    duplexMode?: 'TDD' | 'FDD';
  };
  cellRadioInfo?: {
    EARFCN?: { dl?: number; ul?: number };
    NRARFCN?: { dl?: number; ssb?: number };
    antennas?: { dl?: number; ul?: number };
    rfInfo?: { rfCard?: number };
  };
  cellMobility?: any;
}

export interface UesimSnssai {
  /** Slice / Service Type. 1=eMBB, 2=URLLC, 3=MIoT, 4=V2X. */
  sst?: number;
  /** Slice differentiator (hex string, optional). */
  sd?: string | number;
}

export interface UesimSub {
  csiInfo?: { mncDigits?: number };
  /** UE-side requested S-NSSAI(s). When networkSlicing is enabled, the
   *  generator emits matching nssai[] entries on both gnb and mme. */
  pduSnssai?: { snssai?: UesimSnssai[]; defaultSnssai?: UesimSnssai } | UesimSnssai[] | any;
  subscriberAuthSecurity?: {
    cipherAlgorithm?: string[];
    integrityAlgorithm?: string[];
    resLength?: number;
  };
  subscriberDeviceConfig?: {
    asRelease?: number;
    ueCategory?: string;
    vonrSupport?: boolean;
    VoNRSupport?: boolean;
  };
  subscriberNetworkConfig?: {
    sharedKey?: string;
    networkSlicing?: string | null;
    pdnType?: string;
    routingIndicator?: number;
  };
  subscriberProfileInfo?: {
    algorithm?: 'xor' | 'milenage' | 'tuak';
    startingIMSI?: string | number;
    startingSUPI?: string | number;
    ueCount?: number;
    servingCell?: number;
  };
}

export interface UesimUserPlaneProfile {
  dataAuth?: { userName?: string; password?: string };
  dataCallMsgConfig?: { callDuration?: number; countryCode?: number };
  dataGeneralInfo?: { apnName?: string; dataType?: string; subscriberGroup?: number[] };
  dataNetworkConfig?: { pdnType?: string; pcscfIpAddress?: string; realm?: string };
  mediaConfig?: { codec?: string; videoCodec?: string };
  registrationConfig?: { authentication?: string };
}

export interface UesimTestDefinition {
  cellConfig?: {
    cells?: UesimCell[];
    master?: {
      ratType?: 'sa' | 'nsa' | 'smartphone';
      carrierAggregation?: boolean;
      channelSim?: boolean;
      product?: string;
    };
  };
  subsConfig?: { subs?: UesimSub[] };
  userPlaneConfig?: { profiles?: UesimUserPlaneProfile[] };
  mobilityConfig?: any;
  powerCycleConfig?: any;
  settings?: any;
}

// ---------- Output bundle ----------

export interface CfgBundle {
  /** Files keyed by destination filename (e.g. "gnb.cfg", "mme.cfg"). */
  files: Record<string, string>;
  /** Diagnostics + decisions for the UI. */
  summary: {
    testcaseId: string;
    testcaseName?: string;
    ratType: string;
    cells: number;
    cellTypes: string[];
    dataTypes: string[];
    ueCount: number;
    plmn: string;
    apns: string[];
    ims: boolean;
    realm: string;
    pcscf: string;
    notes: string[];
  };
}

// ---------- Helpers ----------

function setDefine(text: string, key: string, value: string | number): string {
  const re = new RegExp(`(^[ \\t]*#define[ \\t]+${escapeRe(key)}[ \\t]+)([^\\s/]+)(.*)$`, 'm');
  if (!re.test(text)) return text;
  return text.replace(re, `$1${value}$3`);
}

function setQuotedScalar(text: string, field: string, value: string): string {
  const re = new RegExp(`(^[ \\t]*${escapeRe(field)}[ \\t]*:[ \\t]*)"[^"]*"(.*)$`, 'm');
  return text.replace(re, `$1"${value}"$2`);
}

function setNumericScalar(text: string, field: string, value: string | number): string {
  const re = new RegExp(`(^[ \\t]*${escapeRe(field)}[ \\t]*:[ \\t]*)([^,\\r\\n]+)(\\s*,?.*)$`, 'm');
  return text.replace(re, `$1${value}$3`);
}

/** Replace `<name>: [ ... ]` block with new content, honoring nested brackets. */
function replaceListBlock(text: string, listName: string, newContent: string): string {
  const open = new RegExp(`${escapeRe(listName)}\\s*:\\s*\\[`);
  const m = open.exec(text);
  if (!m) return text;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  return text.slice(0, m.index) + `${listName}: [\n${newContent}\n  ]` + text.slice(i + 1);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "n78" -> 78, 78 -> 78, undefined -> 78 */
function toNrBand(b: any): number {
  if (b == null) return 78;
  const s = String(b);
  if (/^[nN]/.test(s)) return parseInt(s.slice(1), 10);
  return parseInt(s, 10);
}

/** Pad IMSI/SUPI to 15 digits to recover leading zeros lost in JSON-numeric form. */
function padImsi(v: any): string {
  if (v == null) return '';
  return String(v).padStart(15, '0');
}

function plmnFromImsi(imsi: any, mncDigits = 2): string {
  const padded = padImsi(imsi);
  if (!padded) return '00101';
  return padded.slice(0, 3 + mncDigits);
}

function firstGain(g: any, defaultVal: number): number {
  if (g == null) return defaultVal;
  if (Array.isArray(g)) return g.length > 0 ? Number(g[0]) : defaultVal;
  return Number(g);
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Return a shallow copy of td with cellConfig.cells replaced. Used for NSA splitting. */
function withCells(td: UesimTestDefinition, cells: UesimCell[]): UesimTestDefinition {
  return {
    ...td,
    cellConfig: {
      ...(td.cellConfig ?? {}),
      cells,
    },
  };
}

/**
 * Resolve the slice list for a testcase. Looks at every subscriber's
 * pduSnssai field. Returns a deduped list of S-NSSAIs only when at least
 * one subscriber has networkSlicing != "disable".
 */
function resolveSlices(td: UesimTestDefinition): UesimSnssai[] {
  const subs = td.subsConfig?.subs ?? [];
  const slicingEnabled = subs.some((s) => {
    const ns = pick<string>(s, 'subscriberNetworkConfig.networkSlicing', 'networkSlicing');
    return ns && ns !== 'disable';
  });
  if (!slicingEnabled) return [];

  const out = new Map<string, UesimSnssai>();
  const collect = (sn: UesimSnssai | undefined) => {
    if (!sn || sn.sst == null) return;
    const key = `${sn.sst}:${sn.sd ?? ''}`;
    if (!out.has(key)) out.set(key, { sst: Number(sn.sst), sd: sn.sd });
  };

  for (const s of subs) {
    const p = s.pduSnssai;
    if (!p) continue;
    if (Array.isArray(p)) p.forEach(collect);
    else {
      if (p.defaultSnssai) collect(p.defaultSnssai);
      if (Array.isArray(p.snssai)) p.snssai.forEach(collect);
      if (p.sst != null) collect(p as UesimSnssai);
    }
  }

  // Default slice when slicing was requested but no S-NSSAI was specified.
  if (out.size === 0) out.set('1:', { sst: 1 });
  return Array.from(out.values());
}

/** Render an `nssai: [ {sst:1, [sd:...]}, ... ]` block for libconfig. */
function renderNssaiBlock(slices: UesimSnssai[], indent = 4): string {
  if (slices.length === 0) return '';
  const pad = ' '.repeat(indent);
  const items = slices.map((s) => {
    const sd = s.sd != null && s.sd !== '' ? `, sd: 0x${String(s.sd).replace(/^0x/i, '')}` : '';
    return `${pad}  { sst: ${s.sst}${sd} }`;
  }).join(',\n');
  return `${pad}nssai: [\n${items}\n${pad}],\n`;
}

// ---------- gNB SA ----------

function buildNrCellList(cells: UesimCell[], fr2: boolean): string {
  return cells.map((c, i) => {
    const band     = toNrBand(pick(c, 'cellConfig.band', 'band'));
    const arfcnDl  = pick<number>(c, 'cellRadioInfo.NRARFCN.dl', 'NRARFCN.dl') ?? 632628;
    const arfcnSsb = pick<number>(c, 'cellRadioInfo.NRARFCN.ssb', 'NRARFCN.ssb') ?? 629952;
    const scs      = pick<number>(c, 'cellCarrierConfig.ScsInfo.scs', 'scs') ?? 30;
    const rfPort   = pick<number>(c, 'cellRadioInfo.rfInfo.rfCard', 'rfCard') ?? i;
    const cellId   = `0x${(i + 1).toString(16).padStart(2, '0').toUpperCase()}`;
    const nIdCell  = 500 + i;
    const ssbBitmap = fr2
      ? '0100000000000000000000000000000000000000000000000000000000000000'
      : '10000000';

    const peers = cells
      .map((_, j) => j)
      .filter((j) => j !== i)
      .map((j) => `{cell_id: ${j + 1}}`);
    const ncellLine = peers.length ? `    ncell_list: [ ${peers.join(', ')} ],\n` : '';

    return [
      '  {',
      `    rf_port: ${rfPort},`,
      `    cell_id: ${cellId},`,
      `    n_id_cell: ${nIdCell},`,
      ncellLine + `    band: ${band},`,
      `    dl_nr_arfcn: ${arfcnDl},`,
      `    ssb_nr_arfcn: ${arfcnSsb},`,
      `    subcarrier_spacing: ${scs},`,
      `    ssb_pos_bitmap: "${ssbBitmap}",`,
      '  },',
    ].join('\n');
  }).join('\n');
}

function buildGnbSa(td: UesimTestDefinition, testcaseId: string, opts: { nsa?: boolean } = {}): string {
  const cells = td.cellConfig?.cells ?? [];
  if (cells.length === 0) throw new Error('No NR cells for gnb (cellConfig.cells empty)');
  const c0 = cells[0];

  // Both schemas: the box serves cells FLAT (band/duplexMode at the top of the
  // cell) while older payloads nest them under cellConfig. Reading only the
  // nested path made every generated cfg fall back to n78/TDD regardless of the
  // testcase — the exact band mismatch that produces 0 attached UEs.
  const duplex  = String(pick(c0, 'cellConfig.duplexMode', 'duplexMode') ?? 'TDD');
  const bw      = Number(pick(c0, 'cellBandwidthInfo.bandwidth', 'bandwidth') ?? 100);
  const band    = toNrBand(pick(c0, 'cellConfig.band', 'band'));
  const antDl   = Number(pick(c0, 'cellRadioInfo.antennas.dl', 'antennas.dl') ?? 2);
  const antUl   = Number(pick(c0, 'cellRadioInfo.antennas.ul', 'antennas.ul') ?? 2);
  const fr2     = band >= 257;
  const tddFlag = duplex === 'TDD' ? 1 : 0;
  const txGain  = firstGain(pick(c0, 'cellCarrierConfig.gainInfo.txGain', 'txGain'), 80);
  const rxGain  = firstGain(pick(c0, 'cellCarrierConfig.gainInfo.rxGain', 'rxGain'), 10);

  let text = TPL.gnbSa;
  text = setDefine(text, 'NR_TDD',       tddFlag);
  text = setDefine(text, 'FR2',          fr2 ? 1 : 0);
  text = setDefine(text, 'N_ANTENNA_DL', antDl);
  text = setDefine(text, 'N_ANTENNA_UL', antUl);
  text = setDefine(text, 'NR_BANDWIDTH', bw);
  text = setNumericScalar(text, 'tx_gain', `${txGain}.0`);
  text = setNumericScalar(text, 'rx_gain', `${rxGain}.0`);

  text = replaceListBlock(text, 'nr_cell_list', buildNrCellList(cells, fr2));

  // NSA wiring: in EN-DC the gNB reaches the LTE eNB anchor over X2. The
  // template ships with `en_dc_support: true` already; we add x2_peers
  // pointing at the local eNB (same host in the standard callbox layout).
  if (opts.nsa) {
    if (!/(^|\n)\s*x2_peers\s*:/.test(text)) {
      text = text.replace(/(\n\s*gtp_addr\s*:\s*"[^"]+",?\s*\n)/, `$1  x2_peers: [ { addr: "127.0.1.1" } ],\n`);
    }
  }

  // Slicing: if requested, inject a plmn_list_5gc block before amf_list. The
  // gNB's plmn_list_5gc[].nssai advertises supported slices on the SIB/S1.
  const slices = resolveSlices(td);
  if (slices.length > 0) {
    const plmn = plmnFromImsi(subStartId(td.subsConfig?.subs?.[0]));
    const block = [
      '  plmn_list_5gc: [',
      '    {',
      `      tac: 10,`,
      `      plmn_ids: [{ plmn: "${plmn}", reserved: false }],`,
      renderNssaiBlock(slices, 6).replace(/\n$/, ''),
      '    },',
      '  ],',
    ].join('\n') + '\n';
    // Insert just before amf_list at root level. If a plmn_list_5gc is already
    // there, leave it (vendor template-specific concern); else inject.
    if (!/(^|\n)\s*plmn_list_5gc\s*:/.test(text)) {
      text = text.replace(/(\n\s*amf_list\s*:)/, `\n${block}$1`);
    }
  }

  return `/* GENERATED by cfgGenerator from testcase ${testcaseId} on ${timestamp()} */\n` + text;
}

// ---------- LTE eNB ----------

function buildLteCellList(cells: UesimCell[], plmn: string): string {
  return cells.map((c, i) => {
    const earfcnDl = pick<number>(c, 'cellRadioInfo.EARFCN.dl', 'EARFCN.dl') ?? 3350;
    const earfcnUl = pick<number>(c, 'cellRadioInfo.EARFCN.ul', 'EARFCN.ul');
    const tac      = `0x${(i + 1).toString(16).padStart(4, '0').toUpperCase()}`;
    const cellId   = `0x${(i + 1).toString(16).padStart(2, '0').toUpperCase()}`;
    const nIdCell  = i + 1;
    const ulLine   = earfcnUl ? `    ul_earfcn: ${earfcnUl},\n` : '';
    return [
      '  {',
      `    plmn_list: [ "${plmn}" ],`,
      `    dl_earfcn: ${earfcnDl},`,
      ulLine + `    n_id_cell: ${nIdCell},`,
      `    cell_id: ${cellId},`,
      `    tac: ${tac},`,
      `    root_sequence_index: ${204 + i * 8},`,
      '  },',
    ].join('\n');
  }).join('\n');
}

function buildLteEnb(td: UesimTestDefinition, testcaseId: string, plmn: string, opts: { nsa?: boolean } = {}): string {
  const cells = td.cellConfig?.cells ?? [];
  if (cells.length === 0) {
    if (opts.nsa) {
      // NSA testcase whose cells[] only contained NR entries. Fall back to a
      // single LTE anchor cell on band 7 so the eNB still comes up.
      cells.push({
        cellBandwidthInfo: { bandwidth: '20' },
        cellConfig: { band: '7', cellType: '4g', duplexMode: 'FDD' },
        cellRadioInfo: { antennas: { dl: 2, ul: 1 }, EARFCN: { dl: 3350, ul: 21350 } },
      } as any);
    } else {
      throw new Error('No LTE cells for enb (cellConfig.cells empty)');
    }
  }
  const c0 = cells[0];
  const duplex  = String(pick(c0, 'cellConfig.duplexMode', 'duplexMode') ?? 'FDD');
  const bwStr   = String(pick(c0, 'cellBandwidthInfo.bandwidth', 'bandwidth') ?? '20');
  const nRb     = LTE_NRB[bwStr] ?? 100;
  const antDl   = Number(pick(c0, 'cellRadioInfo.antennas.dl', 'antennas.dl') ?? 2);
  const antUl   = Number(pick(c0, 'cellRadioInfo.antennas.ul', 'antennas.ul') ?? 1);
  const tddFlag = duplex === 'TDD' ? 1 : 0;
  const channel = td.cellConfig?.master?.channelSim ? 1 : 0;

  let text = TPL.enb;
  text = setDefine(text, 'TDD',          tddFlag);
  text = setDefine(text, 'N_RB_DL',      nRb);
  text = setDefine(text, 'N_ANTENNA_DL', antDl);
  text = setDefine(text, 'N_ANTENNA_UL', antUl);
  text = setDefine(text, 'CHANNEL_SIM',  channel);

  text = replaceListBlock(text, 'cell_list', buildLteCellList(cells, plmn));

  // NSA wiring: tell the eNB it speaks NG to a co-located AMF (NG-eNB) AND
  // talks X2 to a 5G NR secondary. The template uses `#define NG_ENB` for
  // this; flipping it to 1 turns on the amf_list block.
  if (opts.nsa) {
    text = setDefine(text, 'NG_ENB', 1);
    if (!/(^|\n)\s*x2_peers\s*:/.test(text)) {
      text = text.replace(/(\n\s*gtp_addr\s*:\s*"[^"]+",?\s*\n)/, `$1  x2_peers: [ { addr: "127.0.1.1" } ],\n`);
    }
  }

  return `/* GENERATED by cfgGenerator from testcase ${testcaseId} on ${timestamp()} */\n` + text;
}

// ---------- MME (PDN list + ue_db) ----------

interface PdnSubnet { first: string; last: string; dns: string }

function pdnSubnet(apnIndex: number, ueCount: number): PdnSubnet {
  if (ueCount <= 252) {
    const base = 3 + apnIndex;
    return { first: `192.168.${base}.2`, last: `192.168.${base}.254`, dns: '8.8.8.8' };
  }
  const blocks = Math.min(255, Math.ceil(ueCount / 254));
  return { first: `10.${apnIndex}.0.2`, last: `10.${apnIndex}.${blocks}.254`, dns: '8.8.8.8' };
}

function buildPdnList(apns: string[], ueCount: number, imsRequired: boolean): string {
  let list = apns.length ? [...apns] : ['default'];
  if (imsRequired && !list.includes('ims')) list.push('ims');
  return list.map((apn, i) => {
    const { first, last, dns } = pdnSubnet(i, ueCount);
    const qci = apn === 'ims' ? 5 : 9;
    return [
      '    {',
      '      pdn_type: "ipv4",',
      `      access_point_name: "${apn}",`,
      `      first_ip_addr: "${first}",`,
      `      last_ip_addr: "${last}",`,
      '      ip_addr_shift: 2,',
      `      dns_addr: "${dns}",`,
      '      erabs: [',
      '        {',
      `          qci: ${qci},`,
      '          priority_level: 15,',
      '          pre_emption_capability: "shall_not_trigger_pre_emption",',
      '          pre_emption_vulnerability: "not_pre_emptable",',
      '        },',
      '      ],',
      '    },',
    ].join('\n');
  }).join('\n');
}

function buildUeDb(subs: UesimSub[], imsRequired: boolean, realm: string): string {
  const parts: string[] = [];
  let first = true;
  for (const sg of subs) {
    const algo  = pick<string>(sg, 'subscriberProfileInfo.algorithm', 'algorithm') ?? 'xor';
    const K     = pick<string>(sg, 'subscriberNetworkConfig.sharedKey', 'sharedKey') ?? '00112233445566778899aabbccddeeff';
    const start = subStartId(sg);
    const count = Math.max(1, subUeCount(sg));
    const startBig = BigInt(padImsi(start) || '0');

    for (let i = 0; i < count; i++) {
      const imsi = (startBig + BigInt(i)).toString().padStart(15, '0');
      const opcLine = algo === 'milenage'
        ? '      opc: "000102030405060708090A0B0C0D0E0F",\n' : '';
      const imsLines = imsRequired
        ? [
            `      impi: "${imsi}@${realm}",`,
            `      impu: [ "${imsi}" ],`,
            `      domain: "${realm}",`,
          ].join('\n') + '\n'
        : '';
      const sep = first ? '' : ',\n';
      first = false;
      parts.push(
        sep +
        '    {\n' +
        `      sim_algo: "${algo}",\n` +
        `      imsi: "${imsi}",\n` +
        '      amf: 0x9001,\n' +
        '      sqn: "000000000000",\n' +
        `      K: "${K}",\n` +
        opcLine +
        imsLines +
        '      multi_sim: true,\n' +
        '    }'
      );
    }
  }
  return parts.join('');
}

function buildMme(td: UesimTestDefinition, testcaseId: string, plmn: string, imsRequired: boolean, realm: string): string {
  const apns = Array.from(new Set(
    (td.userPlaneConfig?.profiles ?? [])
      .map((p) => profileApn(p))
      .filter((x): x is string => Boolean(x))
  )).sort();
  const ueCount = (td.subsConfig?.subs ?? [])
    .reduce((acc, s) => acc + subUeCount(s), 0) || 1;

  let text = TPL.mme;
  text = setQuotedScalar(text, 'plmn', plmn);
  text = replaceListBlock(text, 'pdn_list', buildPdnList(apns, ueCount, imsRequired));
  text = replaceListBlock(text, 'ue_db',    buildUeDb(td.subsConfig?.subs ?? [], imsRequired, realm));

  // Slicing: when the testcase requested networkSlicing, inject a top-level
  // nssai[] block. The mme template ships with a commented example; we replace
  // any existing nssai: [...] (commented or live) with a synthesized one.
  const slices = resolveSlices(td);
  if (slices.length > 0) {
    const nssaiBody = slices.map((s) => {
      const sd = s.sd != null && s.sd !== '' ? `, sd: 0x${String(s.sd).replace(/^0x/i, '')}` : '';
      return `    { sst: ${s.sst}${sd} }`;
    }).join(',\n');
    const block = `nssai: [\n${nssaiBody}\n  ]`;
    if (/(^|\n)\s*nssai\s*:\s*\[/.test(text)) {
      text = replaceListBlock(text, 'nssai', nssaiBody);
    } else {
      // Insert right after the "plmn:" line.
      text = text.replace(/(\n\s*plmn\s*:\s*"[^"]+",?\s*\n)/, `$1  ${block},\n`);
    }
  }

  return `/* GENERATED by cfgGenerator from testcase ${testcaseId} on ${timestamp()} */\n` + text;
}

// ---------- IMS ----------

function buildIms(_td: UesimTestDefinition, testcaseId: string, _realm: string, _pcscf: string): string {
  // IMS template is mostly static. The corpus default already binds at 192.168.4.1
  // (the canonical PCSCF), so unless the testcase pcscfIpAddress differs, we just
  // stamp a provenance comment and emit. If a future testcase pins a different
  // PCSCF/realm, extend setQuotedScalar calls here.
  return `/* GENERATED by cfgGenerator from testcase ${testcaseId} on ${timestamp()} */\n` + TPL.ims;
}

// ---------- Public entrypoint ----------

export function generateConfigs(
  td: UesimTestDefinition,
  testcaseId: string,
  opts: { testcaseName?: string } = {},
): CfgBundle {
  const ratType   = td.cellConfig?.master?.ratType ?? 'sa';
  const cells     = td.cellConfig?.cells ?? [];
  const cellTypes = Array.from(new Set(cells.map((c) => pick(c, 'cellConfig.cellType', 'cellType') ?? '5g'))).sort();
  const dataTypes = Array.from(new Set(
    (td.userPlaneConfig?.profiles ?? [])
      .map((p) => profileDataType(p))
      .filter((x): x is string => Boolean(x))
  )).sort();
  const ueCount   = (td.subsConfig?.subs ?? [])
    .reduce((acc, s) => acc + subUeCount(s), 0) || 1;

  const sub0 = td.subsConfig?.subs?.[0];
  const startImsi = subStartId(sub0);
  const mncDigits = pick<number>(sub0, 'csiInfo.mncDigits', 'mncDigits') ?? 2;
  const plmn      = plmnFromImsi(startImsi, mncDigits);

  const imsRequired = dataTypes.includes('volte') || dataTypes.includes('vonr');
  let realm = IMS_REALM_DEFAULT;
  let pcscf = IMS_PCSCF_DEFAULT;
  if (imsRequired) {
    for (const p of td.userPlaneConfig?.profiles ?? []) {
      const r = pick(p, 'dataNetworkConfig.realm', 'realm');
      const pc = pick(p, 'dataNetworkConfig.pcscfIpAddress', 'pcscfIpAddress');
      if (r)  realm = String(r);
      if (pc) pcscf = String(pc);
      break;
    }
  }

  const wantGnb = ratType === 'sa' || ratType === 'nsa';
  const wantEnb = ratType === 'smartphone' || ratType === 'nsa';
  const isNsa   = ratType === 'nsa';

  // NSA: split cells by cellType. LTE cells -> enb.cfg (anchor),
  // NR cells -> gnb.cfg (secondary). If a cellType is missing from the
  // testcase, fall back to all cells (for SA / smartphone the filter is
  // a no-op).
  const lteCells = isNsa ? cells.filter((c) => pick(c, 'cellConfig.cellType', 'cellType') === '4g') : cells;
  const nrCells  = isNsa ? cells.filter((c) => pick(c, 'cellConfig.cellType', 'cellType') === '5g') : cells;
  const tdEnb: UesimTestDefinition = isNsa ? withCells(td, lteCells) : td;
  const tdGnb: UesimTestDefinition = isNsa ? withCells(td, nrCells)  : td;

  const files: Record<string, string> = {};
  // The callbox loads ONE radio config, always at /root/enb/config/enb.cfg —
  // ots.cfg sets ENB_CONFIG_FILE="config/enb.cfg" whatever the RAT, and a 5G SA
  // run has lteenb-avx2 reading it. So the generated radio config is named
  // enb.cfg for both 5G and LTE: it is the file you would symlink. NSA is the
  // one case with two, since the LTE anchor and the NR cell are separate.
  if (wantGnb && isNsa) files['gnb.cfg'] = buildGnbSa(tdGnb, testcaseId, { nsa: true });
  else if (wantGnb)     files['enb.cfg'] = buildGnbSa(tdGnb, testcaseId, { nsa: false });
  if (wantEnb)          files['enb.cfg'] = buildLteEnb(tdEnb, testcaseId, plmn, { nsa: isNsa });
  files['mme.cfg']  = buildMme(td, testcaseId, plmn, imsRequired, realm);
  // Also emit the subscriber database on its own. mme.cfg embeds this same
  // data as a `ue_db: [...]` block (ltemme has no separate-file / #include
  // form for it, confirmed against cfgTemplates/mme.cfg) — this standalone
  // copy is for visibility/download ("the database file") and is NOT wired
  // into deploy.ts's SSH push, since there is no evidence anything on the
  // callbox reads a freestanding ue_db.cfg. If that changes, wire it in
  // deliberately rather than assuming.
  files['ue_db.cfg'] = `/* GENERATED by cfgGenerator from testcase ${testcaseId} on ${timestamp()} */\n`
    + `/* Subscriber database — the same data embedded in mme.cfg's ue_db block, shown standalone. */\n`
    + `{\n  ue_db: [\n${buildUeDb(td.subsConfig?.subs ?? [], imsRequired, realm)}\n  ],\n}\n`;
  // ims.cfg unconditionally: the callbox always starts lteims (IMS_CONFIG_FILE
  // is in ots.cfg beside the other two), so a run needs an ims.cfg whether or
  // not this testcase places calls. Withholding it left the default set
  // incomplete next to the live files.
  files['ims.cfg']  = buildIms(td, testcaseId, realm, pcscf);
  // Emit the testcase in the box's OWN download envelope, not a bare
  // testDefinition. The importer validates top-level Test_Name and rejects a
  // raw definition with "Test_Name must be a non-empty string", so a bare dump
  // could be diffed but never re-uploaded. This shape round-trips: it's what
  // the box's "Download testcase" button produces, and normalizeToTestDefinition
  // in lib/environment/parse.ts already reads it back.
  const tcName = opts.testcaseName
    ?? (td as any)?.settings?.test_name
    ?? (td as any)?.settings?.testCaseName
    ?? testcaseId;
  files['testcase.json'] = JSON.stringify({
    Test_Id: testcaseId,
    Test_Name: tcName,
    Test_Config_Intermediate_Object: td,
  }, null, 2);

  const apns = Array.from(new Set(
    (td.userPlaneConfig?.profiles ?? [])
      .map((p) => profileApn(p))
      .filter((x): x is string => Boolean(x))
  )).sort();

  const notes: string[] = [];
  if (td.cellConfig?.master?.carrierAggregation) {
    notes.push('carrier aggregation: cells emitted in same nr_cell_list (verify rf_port mapping matches lab wiring)');
  }
  if (td.mobilityConfig) {
    notes.push('mobility/HO present; cellMobility -> rf_ports[].channel_dl mapping not yet wired');
  }
  const slicing = pick<string>(sub0, 'subscriberNetworkConfig.networkSlicing', 'networkSlicing');
  if (slicing && slicing !== 'disable') {
    const slices = resolveSlices(td);
    notes.push(`slicing enabled; emitted ${slices.length} S-NSSAI(s) into gnb plmn_list_5gc + mme nssai`);
  }
  if (ratType === 'nsa') {
    const lteN = lteCells.length;
    const nrN  = nrCells.length;
    notes.push(`NSA: emitted enb.cfg (${lteN} LTE cell${lteN === 1 ? '' : 's'}, NG_ENB=1) + gnb.cfg (${nrN} NR cell${nrN === 1 ? '' : 's'}); X2 wired to 127.0.1.1`);
  }

  return {
    files,
    summary: {
      testcaseId,
      // Carried so summary.json / the run's Run context identify the testcase
      // by name, not just by an opaque id.
      testcaseName: tcName,
      ratType,
      cells: cells.length,
      cellTypes,
      dataTypes,
      ueCount,
      plmn,
      apns,
      ims: imsRequired,
      realm,
      pcscf,
      notes,
    },
  };
}

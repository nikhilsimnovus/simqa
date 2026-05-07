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
    const ns = s.subscriberNetworkConfig?.networkSlicing;
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
    const band     = toNrBand(c.cellConfig?.band);
    const arfcnDl  = c.cellRadioInfo?.NRARFCN?.dl ?? 632628;
    const arfcnSsb = c.cellRadioInfo?.NRARFCN?.ssb ?? 629952;
    const scs      = c.cellCarrierConfig?.ScsInfo?.scs ?? 30;
    const rfPort   = c.cellRadioInfo?.rfInfo?.rfCard ?? i;
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

  const duplex  = c0.cellConfig?.duplexMode ?? 'TDD';
  const bw      = Number(c0.cellBandwidthInfo?.bandwidth ?? 100);
  const band    = toNrBand(c0.cellConfig?.band);
  const antDl   = Number(c0.cellRadioInfo?.antennas?.dl ?? 2);
  const antUl   = Number(c0.cellRadioInfo?.antennas?.ul ?? 2);
  const fr2     = band >= 257;
  const tddFlag = duplex === 'TDD' ? 1 : 0;
  const txGain  = firstGain(c0.cellCarrierConfig?.gainInfo?.txGain, 80);
  const rxGain  = firstGain(c0.cellCarrierConfig?.gainInfo?.rxGain, 10);

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
    const plmn = plmnFromImsi(td.subsConfig?.subs?.[0]?.subscriberProfileInfo?.startingSUPI ?? td.subsConfig?.subs?.[0]?.subscriberProfileInfo?.startingIMSI);
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
    const earfcnDl = c.cellRadioInfo?.EARFCN?.dl ?? 3350;
    const earfcnUl = c.cellRadioInfo?.EARFCN?.ul;
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
  const duplex  = c0.cellConfig?.duplexMode ?? 'FDD';
  const bwStr   = String(c0.cellBandwidthInfo?.bandwidth ?? '20');
  const nRb     = LTE_NRB[bwStr] ?? 100;
  const antDl   = Number(c0.cellRadioInfo?.antennas?.dl ?? 2);
  const antUl   = Number(c0.cellRadioInfo?.antennas?.ul ?? 1);
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
    const algo  = sg.subscriberProfileInfo?.algorithm ?? 'xor';
    const K     = sg.subscriberNetworkConfig?.sharedKey ?? '00112233445566778899aabbccddeeff';
    const start = sg.subscriberProfileInfo?.startingSUPI ?? sg.subscriberProfileInfo?.startingIMSI;
    const count = Math.max(1, Number(sg.subscriberProfileInfo?.ueCount ?? 1));
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
      .map((p) => p.dataGeneralInfo?.apnName)
      .filter((x): x is string => Boolean(x))
  )).sort();
  const ueCount = (td.subsConfig?.subs ?? [])
    .reduce((acc, s) => acc + Math.max(0, Number(s.subscriberProfileInfo?.ueCount ?? 0)), 0) || 1;

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

export function generateConfigs(td: UesimTestDefinition, testcaseId: string): CfgBundle {
  const ratType   = td.cellConfig?.master?.ratType ?? 'sa';
  const cells     = td.cellConfig?.cells ?? [];
  const cellTypes = Array.from(new Set(cells.map((c) => c.cellConfig?.cellType ?? '5g'))).sort();
  const dataTypes = Array.from(new Set(
    (td.userPlaneConfig?.profiles ?? [])
      .map((p) => p.dataGeneralInfo?.dataType)
      .filter((x): x is string => Boolean(x))
  )).sort();
  const ueCount   = (td.subsConfig?.subs ?? [])
    .reduce((acc, s) => acc + Math.max(0, Number(s.subscriberProfileInfo?.ueCount ?? 0)), 0) || 1;

  const sub0 = td.subsConfig?.subs?.[0];
  const startImsi = sub0?.subscriberProfileInfo?.startingSUPI ?? sub0?.subscriberProfileInfo?.startingIMSI;
  const mncDigits = sub0?.csiInfo?.mncDigits ?? 2;
  const plmn      = plmnFromImsi(startImsi, mncDigits);

  const imsRequired = dataTypes.includes('volte') || dataTypes.includes('vonr');
  let realm = IMS_REALM_DEFAULT;
  let pcscf = IMS_PCSCF_DEFAULT;
  if (imsRequired) {
    for (const p of td.userPlaneConfig?.profiles ?? []) {
      if (p.dataNetworkConfig?.realm)         realm = String(p.dataNetworkConfig.realm);
      if (p.dataNetworkConfig?.pcscfIpAddress) pcscf = String(p.dataNetworkConfig.pcscfIpAddress);
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
  const lteCells = isNsa ? cells.filter((c) => c.cellConfig?.cellType === '4g') : cells;
  const nrCells  = isNsa ? cells.filter((c) => c.cellConfig?.cellType === '5g') : cells;
  const tdEnb: UesimTestDefinition = isNsa ? withCells(td, lteCells) : td;
  const tdGnb: UesimTestDefinition = isNsa ? withCells(td, nrCells)  : td;

  const files: Record<string, string> = {};
  if (wantGnb)      files['gnb.cfg'] = buildGnbSa(tdGnb, testcaseId, { nsa: isNsa });
  if (wantEnb)      files['enb.cfg'] = buildLteEnb(tdEnb, testcaseId, plmn, { nsa: isNsa });
  files['mme.cfg']  = buildMme(td, testcaseId, plmn, imsRequired, realm);
  if (imsRequired)  files['ims.cfg'] = buildIms(td, testcaseId, realm, pcscf);

  const apns = Array.from(new Set(
    (td.userPlaneConfig?.profiles ?? [])
      .map((p) => p.dataGeneralInfo?.apnName)
      .filter((x): x is string => Boolean(x))
  )).sort();

  const notes: string[] = [];
  if (td.cellConfig?.master?.carrierAggregation) {
    notes.push('carrier aggregation: cells emitted in same nr_cell_list (verify rf_port mapping matches lab wiring)');
  }
  if (td.mobilityConfig) {
    notes.push('mobility/HO present; cellMobility -> rf_ports[].channel_dl mapping not yet wired');
  }
  const slicing = sub0?.subscriberNetworkConfig?.networkSlicing;
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

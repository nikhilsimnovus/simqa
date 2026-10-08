// Is this config file actually a config file — and the RIGHT one?
//
// The Automation Suite lets an operator upload an enb/gnb, mme, ims, subscriber
// DB or ots config and symlink it into place on a callbox. Until now nothing
// looked inside the bytes: a truncated file, an ims.cfg dropped into the mme
// slot, or a DB with a 31-character K all uploaded happily, and the failure
// surfaced minutes later as "0 UEs attached" or a core that would not start —
// which sends the investigation to the radio.
//
// So: parse the file, then check it against what its ROLE requires. Two
// severities, because they mean different things to the person uploading:
//
//   error    the file cannot do the job — the upload is refused
//   warning  it parses and is plausibly right, but something is off or
//            depends on another file; the upload goes through and says so
//
// Deliberately NOT a schema of every key. The lab's configs carry hundreds of
// parameters across LTE, NR, NB-IoT and two-core builds, and a validator that
// insists on a key some real file omits is worse than none: it refuses work
// that would have run. Every rule here was checked against the files actually
// linked on 192.168.1.106 and 192.168.1.107 (scripts/probe-callbox-cfg-shapes.ts
// pulls them), which is why rf_driver is a warning and not an error — .106's
// enb.cfg brings it in through `include "rf_driver/config.cfg"` rather than
// declaring it.
//
// Pure: imports nothing, so node --test loads it directly and the browser runs
// the same checks the server does.

// ── What a verdict looks like ────────────────────────────────────────────

/** The config slots a suite can bind. 'testcase' is the Simnovator JSON. */
export type CfgRole = 'enb' | 'gnb' | 'mme' | 'ims' | 'db' | 'ots' | 'testcase';

export interface CfgIssue {
  severity: 'error' | 'warning';
  /** 1-based line in the uploaded file, when the issue has one. */
  line?: number;
  message: string;
  /** What to do about it, when that is not obvious from the message. */
  hint?: string;
}

export interface CfgVerdict {
  /** No errors. Warnings do not block an upload. */
  ok: boolean;
  /** The slot it was checked against. */
  role: CfgRole;
  /** What the contents look like, when that is confidently NOT `role` — the
   *  "you have put the IMS config in the MME box" case. */
  looksLike?: CfgRole;
  issues: CfgIssue[];
  /** One line for a toast: what it is, and whether it can be used. */
  summary: string;
  /** Worth showing beside the file: PLMN, cell count, UE count. */
  facts: Record<string, string | number>;
  /** Names this config pulls in with `include "…"` — the subscriber DB among
   *  them. The suite shows these, because a file that links fine and still
   *  fails is nearly always one whose includes are not on the box. */
  includes: string[];
}

const ROLE_ARTICLE: Record<CfgRole, string> = {
  enb: 'an', gnb: 'a', mme: 'an', ims: 'an', db: 'a', ots: 'an', testcase: 'a',
};

/** "an MME core config" — the label with its article, so generated sentences
 *  read as English. */
export const roleName = (r: CfgRole) => `${ROLE_ARTICLE[r]} ${ROLE_LABEL[r]}`;

export const ROLE_LABEL: Record<CfgRole, string> = {
  enb: 'eNB radio config',
  gnb: 'gNB radio config',
  mme: 'MME core config',
  ims: 'IMS config',
  db: 'subscriber database',
  ots: 'OTS service config',
  testcase: 'Simnovator test case',
};

// ── The config dialect ──────────────────────────────────────────────────
//
// Amarisoft/Simnovus configs are libconfig-ish objects — `key: value,` inside
// braces — run through the C preprocessor first. Strings are double quoted,
// numbers may be hex (0x9001) or negative, comments are block or line, and
// trailing commas are everywhere.

export type CfgValue = string | number | boolean | CfgObject | CfgValue[] | CfgRaw;
export interface CfgObject { [key: string]: CfgValue }

/** A value we could not reduce to a scalar — a macro name, an arithmetic
 *  expression, anything exotic. Kept as its source text so a parameter check
 *  can tell "not a number" from "a number I cannot see yet" and skip it
 *  instead of inventing an error. */
export interface CfgRaw { raw: string }

export const isRaw = (v: unknown): v is CfgRaw =>
  !!v && typeof v === 'object' && typeof (v as CfgRaw).raw === 'string' && Object.keys(v as object).length === 1;

/**
 * Resolve the preprocessor and strip comments, keeping every newline so a
 * reported line number still matches the file the operator uploaded.
 *
 * The preprocessor is deliberately small: `#define NAME value`, and the `#if`
 * forms it can actually decide (`NAME == 0`, a bare number, a defined name),
 * plus `#ifdef` / `#ifndef` / `#else` / `#elif` / `#endif`. Anything it cannot
 * decide takes the FIRST branch, which is what the file's own defaults intend:
 * ims.cfg guards the Rx interface with `#define USE_N5 0` and `#if USE_N5 == 0`,
 * so the Rx branch is the live one. Keeping both branches instead would invent
 * keys the box never sees and then check them.
 */
export function preprocess(src: string): { text: string; defines: Record<string, string>; issues: CfgIssue[] } {
  const issues: CfgIssue[] = [];
  const defines: Record<string, string> = {};
  const out: string[] = [];
  // One entry per open #if: whether this branch is live, and whether any
  // branch of the group has been taken yet.
  const stack: Array<{ live: boolean; taken: boolean }> = [];
  const live = () => stack.every((s) => s.live);

  const lines = src.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const directive = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
    if (directive) {
      const [, word, rest] = directive;
      const arg = rest.replace(/\/[*].*$/, '').replace(/\/\/.*$/, '').trim();
      if (word === 'define' && live()) {
        const m = /^([A-Za-z_]\w*)\s*(.*)$/.exec(arg);
        if (m) defines[m[1]] = m[2].trim();
      } else if (word === 'ifdef' || word === 'ifndef') {
        const has = Object.prototype.hasOwnProperty.call(defines, arg.split(/\s+/)[0]);
        const on = word === 'ifdef' ? has : !has;
        stack.push({ live: on, taken: on });
      } else if (word === 'if') {
        const on = evalCond(arg, defines);
        stack.push({ live: on, taken: on });
      } else if (word === 'elif') {
        const top = stack[stack.length - 1];
        if (!top) issues.push({ severity: 'error', line: ln + 1, message: '#elif without a matching #if' });
        else if (top.taken) top.live = false;
        else { const on = evalCond(arg, defines); top.live = on; top.taken = on; }
      } else if (word === 'else') {
        const top = stack[stack.length - 1];
        if (!top) issues.push({ severity: 'error', line: ln + 1, message: '#else without a matching #if' });
        else { top.live = !top.taken; top.taken = true; }
      } else if (word === 'endif') {
        if (!stack.pop()) issues.push({ severity: 'error', line: ln + 1, message: '#endif without a matching #if' });
      }
      out.push('');                       // the directive itself is not config
      continue;
    }
    out.push(live() ? line : '');
  }
  if (stack.length) {
    issues.push({
      severity: 'error',
      message: `${stack.length} #if block${stack.length === 1 ? '' : 's'} never closed with #endif`,
      hint: 'the file looks truncated',
    });
  }
  return { text: stripComments(out.join('\n'), issues), defines, issues };
}

/** `NAME == 0`, `NAME != 1`, `0`, `1`, `NAME`. Undecidable → true, so the
 *  first branch wins rather than the config losing a whole section. */
function evalCond(expr: string, defines: Record<string, string>): boolean {
  const e = expr.trim();
  if (/^\d+$/.test(e)) return Number(e) !== 0;
  const cmp = /^([A-Za-z_]\w*)\s*(==|!=)\s*(-?\d+)$/.exec(e);
  if (cmp) {
    const have = defines[cmp[1]];
    if (have === undefined) return cmp[2] === '!=';      // undefined behaves as 0
    const n = Number(have);
    if (Number.isNaN(n)) return true;
    return cmp[2] === '==' ? n === Number(cmp[3]) : n !== Number(cmp[3]);
  }
  const bare = /^([A-Za-z_]\w*)$/.exec(e);
  if (bare) {
    const have = defines[bare[1]];
    if (have === undefined) return false;
    const n = Number(have);
    return Number.isNaN(n) ? true : n !== 0;
  }
  return true;
}

/** Replace block and line comments with nothing, preserving newlines and
 *  leaving quoted strings alone — a log_filename may legitimately contain a
 *  double slash. */
function stripComments(src: string, issues: CfgIssue[]): string {
  let out = '';
  let line = 1;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '\n') { out += '\n'; line++; i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let buf = '"';
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\\' && j + 1 < src.length) { buf += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === '"') { closed = true; break; }
        if (src[j] === '\n') break;
        buf += src[j]; j++;
      }
      if (!closed) {
        issues.push({ severity: 'error', line, message: 'a quoted string is not closed before the end of the line' });
        // Swallow to end of line: one bad quote must not cascade into a
        // hundred bogus structural errors further down.
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      out += buf + '"'; i = j + 1; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '*' && src[j + 1] === '/') { closed = true; break; }
        if (src[j] === '\n') { out += '\n'; line++; }
        j++;
      }
      if (!closed) {
        issues.push({ severity: 'error', line, message: 'a block comment is never closed', hint: 'the file looks truncated' });
        return out;
      }
      i = j + 2; continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    out += c; i++;
  }
  return out;
}

interface Tok { kind: 'punct' | 'str' | 'num' | 'word'; text: string; num?: number; line: number }

function lex(text: string): Tok[] {
  const toks: Tok[] = [];
  let line = 1;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if ('{}[]:,'.includes(c)) { toks.push({ kind: 'punct', text: c, line }); i++; continue; }
    if (c === '"') {
      let j = i + 1; let buf = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) { buf += text[j + 1]; j += 2; continue; }
        buf += text[j]; j++;
      }
      toks.push({ kind: 'str', text: buf, line }); i = j + 1; continue;
    }
    const num = /^-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (num) {
      toks.push({ kind: 'num', text: num[0], num: Number(num[0]), line });
      i += num[0].length; continue;
    }
    const word = /^[A-Za-z_][\w.]*/.exec(text.slice(i));
    if (word) { toks.push({ kind: 'word', text: word[0], line }); i += word[0].length; continue; }
    // Anything else — an operator inside an expression, a stray character.
    // Kept as a one-character word so the tolerant value reader absorbs it.
    toks.push({ kind: 'word', text: c, line }); i++;
  }
  return toks;
}

export interface ParseResult {
  /** The top-level members, whether the file was a braced document or a bare
   *  `key: value,` fragment — which is how every subscriber DB on the boxes is
   *  written, since mme.cfg pulls them in with `include`. */
  doc: CfgObject;
  /** Line each top-level key was declared on, for pointed messages. */
  lineOf: Record<string, number>;
  includes: string[];
  issues: CfgIssue[];
  /** True when the file was wrapped in braces. */
  wrapped: boolean;
}

/**
 * Parse the cfg dialect.
 *
 * Structure is checked strictly — an unbalanced brace or a missing colon is
 * exactly the "wrong config" an operator needs told about — while VALUES are
 * read tolerantly, because the lab's configs are full of macros and
 * expressions and a parser that rejected `n_antenna_dl: N_ANTENNA_DL` would
 * refuse files that run perfectly today.
 */
export function parseCfg(src: string): ParseResult {
  const pre = preprocess(src);
  const issues = pre.issues;
  const toks = lex(pre.text);
  const includes: string[] = [];
  const lineOf: Record<string, number> = {};
  let i = 0;
  const at = (k: number) => toks[k];
  const lineHere = () => toks[Math.min(i, toks.length - 1)]?.line;

  /** Is the token after a scalar a separator? If not, the scalar is part of a
   *  bigger expression and the whole thing must be read raw. */
  const isScalarEnd = (k: number) => {
    const t = at(k);
    return !t || (t.kind === 'punct' && ',}]'.includes(t.text));
  };

  const readValue = (): CfgValue => {
    const t = at(i);
    if (!t) return '';
    if (t.kind === 'punct' && t.text === '{') { i++; return readMembers('}'); }
    if (t.kind === 'punct' && t.text === '[') { i++; return readArray(); }
    if (t.kind === 'str') { i++; return t.text; }
    if (t.kind === 'num' && isScalarEnd(i + 1)) { i++; return t.num as number; }
    if (t.kind === 'word' && (t.text === 'true' || t.text === 'false') && isScalarEnd(i + 1)) {
      i++; return t.text === 'true';
    }
    // Tolerant: swallow up to the next separator at this depth, hand it back
    // as raw source text.
    let raw = '';
    while (i < toks.length) {
      const k = at(i);
      if (k.kind === 'punct' && ',}]'.includes(k.text)) break;
      if (k.kind === 'punct' && '{['.includes(k.text)) { raw += (raw ? ' ' : '') + k.text; i++; continue; }
      raw += (raw ? ' ' : '') + k.text;
      i++;
    }
    return { raw };
  };

  const readArray = (): CfgValue[] => {
    const arr: CfgValue[] = [];
    for (;;) {
      const t = at(i);
      if (!t) {
        issues.push({ severity: 'error', line: lineHere(), message: 'a [ list is never closed with ]', hint: 'the file looks truncated' });
        break;
      }
      if (t.kind === 'punct' && t.text === ']') { i++; break; }
      if (t.kind === 'punct' && t.text === ',') { i++; continue; }
      if (t.kind === 'punct' && t.text === '}') {
        issues.push({ severity: 'error', line: t.line, message: 'a } closes a list that was opened with [' });
        i++; break;
      }
      arr.push(readValue());
    }
    return arr;
  };

  const readMembers = (stop: '}' | 'eof'): CfgObject => {
    const obj: CfgObject = {};
    for (;;) {
      const t = at(i);
      if (!t) {
        if (stop === '}') issues.push({ severity: 'error', message: 'a { block is never closed with }', hint: 'the file looks truncated' });
        break;
      }
      if (t.kind === 'punct' && t.text === '}') {
        if (stop === '}') { i++; break; }
        issues.push({ severity: 'error', line: t.line, message: 'a } with no matching {' });
        i++; continue;
      }
      if (t.kind === 'punct' && t.text === ',') { i++; continue; }
      if (t.kind === 'punct' && t.text === ']') {
        issues.push({ severity: 'error', line: t.line, message: 'a ] with no matching [' });
        i++; continue;
      }
      // include "name.cfg" — a statement, not a key.
      if (t.kind === 'word' && t.text === 'include' && at(i + 1)?.kind === 'str') {
        includes.push(String(at(i + 1).text));
        i += 2; continue;
      }
      if (t.kind !== 'word' && t.kind !== 'str') {
        issues.push({ severity: 'error', line: t.line, message: `expected a parameter name, found "${t.text}"` });
        i++; continue;
      }
      const key = t.text;
      const keyLine = t.line;
      i++;
      const colon = at(i);
      if (!colon || colon.kind !== 'punct' || colon.text !== ':') {
        issues.push({
          severity: 'error', line: keyLine,
          message: `"${key}" is not followed by ":"`,
          hint: 'a missing colon or comma is usually a hand edit that went wrong',
        });
        continue;
      }
      i++;
      obj[key] = readValue();
      if (lineOf[key] === undefined) lineOf[key] = keyLine;
    }
    return obj;
  };

  // A document is either braced (mme/ims/enb/gnb) or a bare fragment of
  // members — which is how every subscriber DB on the boxes is written.
  let wrapped = false;
  let doc: CfgObject;
  if (at(i)?.kind === 'punct' && at(i)!.text === '{') {
    wrapped = true; i++;
    doc = readMembers('}');
    // Content after the closing brace is a sure sign of a bad paste.
    const extra = toks.slice(i).filter((t) => !(t.kind === 'punct' && t.text === ','));
    if (extra.length) {
      issues.push({ severity: 'error', line: extra[0].line, message: 'there is configuration after the closing } of the file' });
    }
  } else {
    doc = readMembers('eof');
  }
  if (!toks.length) {
    issues.push({ severity: 'error', message: 'there is no configuration in this file — it is empty, or entirely comments' });
  }
  return { doc, lineOf, includes, issues, wrapped };
}

// ── The OTS config is a different language ──────────────────────────────
//
// /root/ots/config/ots.cfg is a SHELL fragment the lte service sources, not a
// libconfig document: `KEY="value"` with `#` comments, and the component list
// built up by appending (`COMPONENTS+=" MME"`). Parsing it as a cfg would
// reject every real one.

export interface OtsParse {
  vars: Record<string, string>;
  /** Component ids in COMPONENTS, in declaration order. */
  components: string[];
  issues: CfgIssue[];
}

export function parseOts(src: string): OtsParse {
  const vars: Record<string, string> = {};
  const components: string[] = [];
  const issues: CfgIssue[] = [];
  const lines = src.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].replace(/\r$/, '');
    const bare = line.replace(/^\s+/, '');
    if (!bare || bare.startsWith('#')) continue;
    const m = /^([A-Za-z_]\w*)(\+?=)(.*)$/.exec(bare);
    if (!m) {
      // `source ots.default.cfg` is the documented way to build on the stock
      // file, and `if`/`fi` shell bodies appear in a few of the lab's own.
      if (/^(source|\.|export|if|then|else|fi|for|do|done|case|esac|unset)\b/.test(bare)) continue;
      issues.push({
        severity: 'warning', line: ln + 1,
        message: `"${bare.slice(0, 40)}" is not a NAME=value assignment`,
        hint: 'ots.cfg is sourced by the shell — anything else runs as a command',
      });
      continue;
    }
    const [, name, op, rhsRaw] = m;
    const rhs = rhsRaw.replace(/\s+#.*$/, '').trim();
    const quoted = /^"([^"]*)"$/.exec(rhs) ?? /^'([^']*)'$/.exec(rhs);
    if (!quoted && /[\s"']/.test(rhs)) {
      issues.push({
        severity: 'error', line: ln + 1,
        message: `${name} has an unbalanced or unquoted value`,
        hint: 'the shell will not source this file',
      });
      continue;
    }
    const value = quoted ? quoted[1] : rhs;
    vars[name] = op === '+=' ? `${vars[name] ?? ''}${value}` : value;
  }
  for (const c of (vars.COMPONENTS ?? '').split(/\s+/).filter(Boolean)) {
    if (!components.includes(c)) components.push(c);
  }
  return { vars, components, issues };
}

// ── Role rules ──────────────────────────────────────────────────────────

/** Keys that identify each role, used both to require them and to work out
 *  what an uploaded file actually is. */
const SIGNATURE: Record<Exclude<CfgRole, 'testcase' | 'ots'>, string[]> = {
  mme: ['plmn', 'mme_code', 'mme_group_id', 'pdn_list', 'gtp_addr'],
  ims: ['sip_addr', 'cx_server_addr', 'cx_bind_addr', 'mms_server_bind_addr'],
  enb: ['cell_list', 'nr_cell_list', 'nb_cell_list', 'rf_driver', 'mme_list', 'amf_list', 'nr_cell_default'],
  gnb: ['nr_cell_list', 'amf_list', 'rf_driver', 'nr_cell_default'],
  db: ['ue_db'],
};

const has = (o: CfgObject, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const hasAny = (o: CfgObject, ks: string[]) => ks.some((k) => has(o, k));

/** Which role the CONTENT looks like, independent of the slot it was dropped
 *  into. Scored rather than first-match: an mme.cfg also carries ims_list, and
 *  an enb.cfg also carries plmn_list. */
export function detectRole(src: string, parsed?: ParseResult): CfgRole | undefined {
  // OTS first: shell, so it never parses as a cfg document.
  if (/^\s*COMPONENTS\s*\+?=/m.test(src) || /_CONFIG_FILE\s*=/.test(src)) return 'ots';
  const trimmed = src.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const j = JSON.parse(src);
      if (j && typeof j === 'object') return 'testcase';
    } catch { /* not JSON — a cfg document also starts with a brace */ }
  }
  const p = parsed ?? parseCfg(src);
  const doc = p.doc;
  // A DB is unmistakable: ue_db and essentially nothing else.
  if (has(doc, 'ue_db')) return 'db';
  const score = (ks: string[]) => ks.filter((k) => has(doc, k)).length;
  const ranked: Array<[CfgRole, number]> = [
    ['mme', score(SIGNATURE.mme)],
    ['ims', score(SIGNATURE.ims)],
    // enb and gnb share a format and are told apart below, so they compete as one.
    ['enb', score(SIGNATURE.enb)],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] === 0) return undefined;
  // A tie says nothing — better to stay quiet than accuse the operator wrongly.
  if (ranked[0][1] === ranked[1][1]) return undefined;
  if (ranked[0][0] === 'enb') return has(doc, 'nr_cell_list') && !has(doc, 'cell_list') ? 'gnb' : 'enb';
  return ranked[0][0];
}

/** enb and gnb are the same file format in two symlink slots, so a file in the
 *  wrong one of those two is not an error. */
const INTERCHANGEABLE: CfgRole[][] = [['enb', 'gnb']];
const sameFamily = (a: CfgRole, b: CfgRole) =>
  a === b || INTERCHANGEABLE.some((fam) => fam.includes(a) && fam.includes(b));

const PLMN = /^\d{5,6}$/;
const HEX32 = /^[0-9a-fA-F]{32}$/;
const IMSI = /^\d{14,16}$/;

/** A number we can actually check, or undefined when the value is a macro or
 *  an expression the preprocessor could not reduce. */
function numOf(v: CfgValue | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return undefined;
}

function strOf(v: CfgValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** `host:port`, a bare IPv4/IPv6 address, or `[::]:9000`. Checked loosely: the
 *  configs use interface names and hostnames here too. */
function addrLooksWrong(v: CfgValue | undefined): boolean {
  const s = strOf(v);
  if (s === undefined) return false;                 // macro or structure — not ours to judge
  if (!s.trim()) return true;
  return /\s/.test(s.trim());
}

function arrayOf(v: CfgValue | undefined): CfgValue[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function objOf(v: CfgValue | undefined): CfgObject | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) && !isRaw(v) ? (v as CfgObject) : undefined;
}

// ── The checks, per role ────────────────────────────────────────────────

function checkMme(doc: CfgObject, lineOf: Record<string, number>, out: CfgIssue[], facts: Record<string, string | number>) {
  for (const k of ['plmn', 'gtp_addr', 'com_addr']) {
    if (!has(doc, k)) {
      out.push({ severity: 'error', message: `an MME config must set ${k} — this one does not`, hint: 'is this really the mme.cfg?' });
    }
  }
  const plmn = strOf(doc.plmn);
  if (plmn !== undefined && !PLMN.test(plmn)) {
    out.push({ severity: 'error', line: lineOf.plmn, message: `plmn "${plmn}" is not 5 or 6 digits (MCC+MNC)` });
  }
  if (plmn) facts.PLMN = plmn;
  for (const k of ['gtp_addr', 'com_addr']) {
    if (addrLooksWrong(doc[k])) out.push({ severity: 'error', line: lineOf[k], message: `${k} is not an address` });
  }
  const code = numOf(doc.mme_code);
  if (code !== undefined && (code < 0 || code > 255)) {
    out.push({ severity: 'error', line: lineOf.mme_code, message: `mme_code ${code} is outside 0–255` });
  }
  const grp = numOf(doc.mme_group_id);
  if (grp !== undefined && (grp < 0 || grp > 65535)) {
    out.push({ severity: 'error', line: lineOf.mme_group_id, message: `mme_group_id ${grp} is outside 0–65535` });
  }
  const pdn = arrayOf(doc.pdn_list);
  if (!has(doc, 'pdn_list')) {
    out.push({ severity: 'warning', message: 'no pdn_list — UEs will attach with no bearer to use' });
  } else if (pdn && pdn.length === 0) {
    out.push({ severity: 'error', line: lineOf.pdn_list, message: 'pdn_list is empty' });
  } else if (pdn) {
    facts['PDNs'] = pdn.length;
    pdn.forEach((p, idx) => {
      const o = objOf(p);
      if (o && !has(o, 'access_point_name')) {
        out.push({ severity: 'warning', line: lineOf.pdn_list, message: `pdn_list[${idx}] has no access_point_name` });
      }
    });
  }
  // The subscriber DB. An MME with no ue_db and no include has nobody to let on.
  if (!has(doc, 'ue_db')) {
    facts['Subscribers'] = 'from include';
  }
}

function checkIms(doc: CfgObject, lineOf: Record<string, number>, out: CfgIssue[], facts: Record<string, string | number>) {
  for (const k of ['sip_addr', 'com_addr']) {
    if (!has(doc, k)) {
      out.push({ severity: 'error', message: `an IMS config must set ${k} — this one does not`, hint: 'is this really the ims.cfg?' });
    }
  }
  const sip = arrayOf(doc.sip_addr);
  if (sip && sip.length === 0) out.push({ severity: 'error', line: lineOf.sip_addr, message: 'sip_addr is an empty list — IMS has nothing to bind to' });
  if (sip) facts['SIP binds'] = sip.length;
  if (!has(doc, 'cx_server_addr')) {
    out.push({ severity: 'warning', message: 'no cx_server_addr — IMS will not reach the MME for Cx' });
  }
  const dom = strOf(doc.domain);
  if (dom) facts.Domain = dom;
  if (addrLooksWrong(doc.com_addr)) out.push({ severity: 'error', line: lineOf.com_addr, message: 'com_addr is not an address' });
}

function checkRadio(role: 'enb' | 'gnb', doc: CfgObject, lineOf: Record<string, number>, includes: string[], out: CfgIssue[], facts: Record<string, string | number>) {
  if (!has(doc, 'com_addr')) {
    out.push({ severity: 'error', message: 'a radio config must set com_addr — this one does not', hint: 'is this really an enb/gnb cfg?' });
  }
  const lte = arrayOf(doc.cell_list);
  const nr = arrayOf(doc.nr_cell_list);
  // NB-IoT standalone keeps its cells in nb_cell_list and leaves cell_list
  // deliberately empty — .106's live enb.cfg is exactly that, so counting only
  // LTE and NR cells called a working config "no cells defined".
  const nb = arrayOf(doc.nb_cell_list);
  const cells = (lte?.length ?? 0) + (nr?.length ?? 0) + (nb?.length ?? 0);
  if (!hasAny(doc, ['cell_list', 'nr_cell_list', 'nb_cell_list'])) {
    out.push({
      severity: 'error',
      message: 'no cell_list and no nr_cell_list — this config defines no cells, so no UE can attach',
      hint: 'is this really an enb/gnb cfg?',
    });
  }
  if (lte?.length) facts['LTE cells'] = lte.length;
  if (nr?.length) facts['NR cells'] = nr.length;
  if (nb?.length) facts['NB-IoT cells'] = nb.length;
  if (cells === 0) {
    out.push({
      severity: 'error', line: lineOf.cell_list ?? lineOf.nr_cell_list ?? lineOf.nb_cell_list,
      message: 'every cell list in this config is empty — no UE could attach',
    });
  }
  if (!hasAny(doc, ['mme_list', 'amf_list'])) {
    out.push({
      severity: 'error',
      message: 'no mme_list and no amf_list — the radio has no core to connect to',
      hint: 'LTE configs use mme_list, NR configs amf_list',
    });
  }
  // rf_driver is a WARNING, not an error: .106's enb.cfg pulls it in through
  // `include "rf_driver/config.cfg"` rather than declaring it inline.
  if (!has(doc, 'rf_driver') && !includes.some((n) => /rf_driver/i.test(n))) {
    out.push({
      severity: 'warning',
      message: 'no rf_driver — the radio will come up with no RF front end unless the box supplies one',
    });
  }
  if (role === 'gnb' && !nr?.length && (lte?.length || nb?.length)) {
    out.push({ severity: 'warning', message: 'this config defines no NR cells, and it is going into the gNB slot' });
  }
  // Each cell needs an identity and a carrier.
  const checkCells = (list: CfgValue[] | undefined, label: string, idKeys: string[], freqKeys: string[]) => {
    (list ?? []).forEach((c, idx) => {
      const o = objOf(c);
      if (!o) return;
      if (!hasAny(o, idKeys)) out.push({ severity: 'warning', message: `${label}[${idx}] has no ${idKeys.join(' or ')}` });
      if (!hasAny(o, freqKeys)) out.push({ severity: 'warning', message: `${label}[${idx}] has no ${freqKeys.join(' or ')} — no carrier frequency` });
    });
  };
  checkCells(lte, 'cell_list', ['cell_id', 'n_id_cell'], ['dl_earfcn', 'band', 'dl_freq']);
  checkCells(nr, 'nr_cell_list', ['cell_id', 'n_id_cell'], ['dl_nr_arfcn', 'band', 'ssb_nr_arfcn']);
  checkCells(nb, 'nb_cell_list', ['cell_id', 'n_id_cell'], ['dl_earfcn', 'band', 'dl_freq']);
}

function checkDb(doc: CfgObject, lineOf: Record<string, number>, out: CfgIssue[], facts: Record<string, string | number>) {
  if (!has(doc, 'ue_db')) {
    out.push({
      severity: 'error',
      message: 'a subscriber database must define ue_db — this file does not',
      hint: 'the DB files on the callboxes all start with `ue_db: [`',
    });
    return;
  }
  const list = arrayOf(doc.ue_db);
  if (!list) {
    out.push({ severity: 'error', line: lineOf.ue_db, message: 'ue_db is not a list' });
    return;
  }
  if (list.length === 0) {
    out.push({ severity: 'error', line: lineOf.ue_db, message: 'ue_db is empty — no UE could attach with this database' });
    return;
  }
  facts['Subscribers'] = list.length;
  const seen = new Map<string, number>();
  // One message per KIND of problem, naming the first few rows: a 1000-UE DB
  // with a systematic mistake would otherwise produce a thousand lines.
  const bad = { imsi: [] as number[], algo: [] as number[], k: [] as number[], opc: [] as number[], dup: [] as string[] };
  list.forEach((e, idx) => {
    const o = objOf(e);
    if (!o) { bad.imsi.push(idx); return; }
    const imsi = strOf(o.imsi) ?? (typeof o.imsi === 'number' ? String(o.imsi) : undefined);
    if (!imsi || !IMSI.test(imsi)) bad.imsi.push(idx);
    else {
      const prev = seen.get(imsi);
      if (prev !== undefined) bad.dup.push(imsi);
      else seen.set(imsi, idx);
    }
    const algo = strOf(o.sim_algo);
    if (algo !== undefined && !['xor', 'milenage', 'tuak'].includes(algo)) bad.algo.push(idx);
    const k = strOf(o.K) ?? strOf(o.k);
    if (k !== undefined && !HEX32.test(k)) bad.k.push(idx);
    // milenage and tuak need the operator key; xor does not.
    if (algo && algo !== 'xor' && !hasAny(o, ['opc', 'op', 'OPc', 'OP'])) bad.opc.push(idx);
  });
  const few = (ns: Array<number | string>) => ns.slice(0, 5).join(', ') + (ns.length > 5 ? `, …(${ns.length} total)` : '');
  if (bad.imsi.length) {
    out.push({
      severity: 'error', line: lineOf.ue_db,
      message: `${bad.imsi.length} subscriber${bad.imsi.length === 1 ? '' : 's'} have no usable imsi (entries ${few(bad.imsi)})`,
      hint: 'an IMSI is 14–16 digits, quoted',
    });
  }
  if (bad.algo.length) {
    out.push({ severity: 'error', line: lineOf.ue_db, message: `sim_algo must be xor, milenage or tuak — wrong in entries ${few(bad.algo)}` });
  }
  if (bad.k.length) {
    out.push({ severity: 'error', line: lineOf.ue_db, message: `K must be 32 hex characters — wrong in entries ${few(bad.k)}` });
  }
  if (bad.opc.length) {
    out.push({
      severity: 'error', line: lineOf.ue_db,
      message: `milenage/tuak subscribers need opc or op — missing in entries ${few(bad.opc)}`,
    });
  }
  if (bad.dup.length) {
    out.push({
      severity: 'error', line: lineOf.ue_db,
      message: `${bad.dup.length} duplicate IMSI${bad.dup.length === 1 ? '' : 's'} (${few([...new Set(bad.dup)])})`,
      hint: 'the core keeps one subscriber per IMSI, so the later entries never take effect',
    });
  }
}

function checkOts(src: string, out: CfgIssue[], facts: Record<string, string | number>) {
  if (src.includes('\r\n')) {
    out.push({
      severity: 'error',
      message: 'this file has Windows line endings — the shell cannot source it',
      hint: 'save it with Unix (LF) line endings',
    });
  }
  const { vars, components, issues } = parseOts(src);
  out.push(...issues);
  const sourced = /^\s*(source|\.)\s+\S+/m.test(src);
  if (!components.length) {
    if (sourced) {
      // The documented "build on the stock file" form: `source ots.default.cfg`
      // and then override. The component list comes from the file it sources.
      out.push({ severity: 'warning', message: 'COMPONENTS is not set here — it comes from the file this one sources' });
    } else {
      out.push({
        severity: 'error',
        message: 'COMPONENTS is empty — the lte service would start no components at all',
        hint: 'an OTS config lists its components as COMPONENTS+=" MME" and so on',
      });
    }
  } else {
    facts.Components = components.join(' ');
  }
  for (const c of components) {
    if (!vars[`${c}_TYPE`]) out.push({ severity: 'error', message: `component ${c} is listed in COMPONENTS but has no ${c}_TYPE` });
    const cfg = vars[`${c}_CONFIG_FILE`];
    // LICENSE and a few helper components legitimately have no config file.
    if (!cfg && !['LICENSE'].includes(vars[`${c}_TYPE`] ?? '')) {
      out.push({ severity: 'warning', message: `component ${c} has no ${c}_CONFIG_FILE — it will use the component's default` });
    }
    if (cfg) facts[`${c} config`] = cfg;
  }
}

function checkTestcase(src: string, out: CfgIssue[], facts: Record<string, string | number>) {
  let j: unknown;
  try { j = JSON.parse(src); }
  catch (e: unknown) {
    out.push({
      severity: 'error',
      message: `this is not valid JSON: ${(e as Error)?.message ?? 'parse failed'}`,
      hint: 'a test case is the Simnovator’s own Export output',
    });
    return;
  }
  if (!j || typeof j !== 'object') {
    out.push({ severity: 'error', message: 'the JSON is not an object' });
    return;
  }
  const o = j as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name : undefined;
  if (name) facts.Name = name;
  // The Simnovator's export wraps the definition; both shapes are accepted by
  // definitionFromPack, so only say something when neither is there.
  const def = (o.definition ?? o.testCase ?? o.testcase ?? o.data ?? (o.cells || o.ueGroups ? o : undefined));
  if (!def) {
    out.push({
      severity: 'error',
      message: 'no test definition in this file',
      hint: 'use the Export button on the Simnovator, not a hand-written file',
    });
  }
}

// ── The entry point ─────────────────────────────────────────────────────

/**
 * Check one uploaded file against the slot it is going into.
 *
 * `name` is only used in messages. Nothing here touches a box: this runs on the
 * bytes, in the browser as the file is picked and again on the server before
 * the runner pushes it, so a file that cannot work is refused at the point the
 * operator can still do something about it.
 */
export function validateCfg(role: CfgRole, name: string, text: string): CfgVerdict {
  const issues: CfgIssue[] = [];
  const facts: Record<string, string | number> = {};

  if (!text.trim()) {
    return {
      ok: false, role, issues: [{ severity: 'error', message: 'the file is empty' }],
      summary: `${name} is empty`, facts, includes: [],
    };
  }
  // A binary blob dropped in by accident: NUL bytes are never in a config.
  if (text.includes('\u0000')) {
    return {
      ok: false, role, issues: [{ severity: 'error', message: 'this is a binary file, not a text config' }],
      summary: `${name} is not a text config`, facts, includes: [],
    };
  }

  if (role === 'testcase') {
    checkTestcase(text, issues, facts);
    return verdict(role, name, issues, facts, [], undefined);
  }
  if (role === 'ots') {
    checkOts(text, issues, facts);
    const guess = detectRole(text);
    return verdict(role, name, issues, facts, [], guess && !sameFamily(guess, role) ? guess : undefined);
  }

  const parsed = parseCfg(text);
  issues.push(...parsed.issues);
  const guess = detectRole(text, parsed);

  // Wrong slot. Reported as an error, because linking it would start a
  // component against a config for a different one — and said before the
  // structural griping, which is the wrong thing to read in that case.
  if (guess && !sameFamily(guess, role)) {
    issues.unshift({
      severity: 'error',
      message: `this looks like ${roleName(guess)}, not ${roleName(role)}`,
      hint: `upload it in the ${guess.toUpperCase()} slot instead`,
    });
  }

  // Only run the role's own checks when the file at least parsed, and when it
  // is not plainly a different role: a pile of "an MME config must set plmn"
  // on top of "this is the IMS config" is noise.
  const structurallyBroken = parsed.issues.some((i) => i.severity === 'error');
  if (!structurallyBroken && (!guess || sameFamily(guess, role))) {
    if (role === 'mme') checkMme(parsed.doc, parsed.lineOf, issues, facts);
    else if (role === 'ims') checkIms(parsed.doc, parsed.lineOf, issues, facts);
    else if (role === 'enb' || role === 'gnb') checkRadio(role, parsed.doc, parsed.lineOf, parsed.includes, issues, facts);
    else if (role === 'db') checkDb(parsed.doc, parsed.lineOf, issues, facts);
  }

  return verdict(role, name, issues, facts, parsed.includes, guess && !sameFamily(guess, role) ? guess : undefined);
}

function verdict(
  role: CfgRole, name: string, issues: CfgIssue[],
  facts: Record<string, string | number>, includes: string[], looksLike: CfgRole | undefined,
): CfgVerdict {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const ok = errors.length === 0;
  const bits = Object.entries(facts).map(([k, v]) => `${k} ${v}`);
  const summary = ok
    ? `${name} checks out as ${roleName(role)}${bits.length ? ` — ${bits.join(', ')}` : ''}`
      + (warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : '')
    : `${name} cannot be used as ${roleName(role)}: ${errors[0].message}`;
  return { ok, role, looksLike, issues, summary, facts, includes };
}

/**
 * The same MME config, pointed at a different subscriber database.
 *
 * There is no ue_db.cfg symlink on the callboxes — every MME config names its
 * database in an `include` line, and the lab has twelve different ones — so
 * this is the only way a DB can be chosen independently of the core config.
 * The caller writes the result to a file of its own and links mme.cfg at that,
 * which leaves the original exactly as it was for every other setup using it.
 *
 * Commented-out includes are left alone: the configs on the boxes carry
 * several of those as history, and uncommenting one would load a second
 * database. A config that includes more than one live DB — none in the lab
 * does, but the format allows it — keeps the first and has the rest commented
 * out, because two databases loaded at once is not what was asked for.
 */
export function withDbInclude(mmeText: string, db: string): { text: string; changed: boolean; replaced: string[] } {
  const replaced: string[] = [];
  const lines = mmeText.split('\n');
  const out = [...lines];
  let done = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\s*)include\s+"([^"]+)"(\s*,?)(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, name, comma, tail] = m;
    const base = name.split('/').pop() as string;
    if (!dbIncludesOf([base]).length) continue;        // a fragment, not the DB
    if (base === db && !done) { done = true; return { text: mmeText, changed: false, replaced: [] }; }
    if (!done) {
      out[i] = `${indent}include "${db}"${comma || ','}${tail}`;
      replaced.push(base);
      done = true;
    } else {
      // A second live database would be loaded on top of the first.
      out[i] = `${indent}//include "${name}"${comma}${tail}   // disabled by SimQA: ${db} is this row's database`;
      replaced.push(base);
    }
  }

  if (done) return { text: out.join('\n'), changed: true, replaced };

  // No database included at all — add one. Before the final closing brace of
  // the document, which is where the configs on the boxes keep theirs.
  const close = out.map((l, i) => [l, i] as const).reverse().find(([l]) => l.trim().startsWith('}'));
  const insertAt = close ? close[1] : out.length;
  out.splice(insertAt, 0, `  include "${db}",   // added by SimQA: this row's database`);
  return { text: out.join('\n'), changed: true, replaced };
}

/** The subscriber DB a config pulls in, if it names one.
 *
 *  The same rule the callbox pickers use (labCfgLink.ueDbFor): of everything an
 *  MME config includes, the DB is the one whose name says so. Here it works on
 *  the bytes rather than over SSH, so an mme.cfg that has only just been
 *  uploaded can still say which DB it brings — which is what makes the DB field
 *  fill itself in the moment you pick the MME config. */
export function dbIncludesOf(includes: string[]): string[] {
  return includes
    .map((n) => n.split('/').pop() as string)
    .filter((n) => /db|subscriber|ue/i.test(n));
}

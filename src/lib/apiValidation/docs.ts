// Replacing the API document from the page: check, preview, apply, roll back.
//
// Ported from docs.py. The point of the preview is that nothing changes until
// someone has seen what would change — which sections and APIs appear or
// disappear, which status codes and schemas move, and whether the tool's own
// Simnovator wiring still fits. Applying is refused while a run is going.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { METHODS, placeholders, Spec, type Json } from './spec.ts';
import * as testplan from './testplan.ts';
import { ACTIVE, HISTORY_DIR, SAVED_NAME, ensureDirs, readActiveText, invalidateSpec } from './store.ts';

const PENDING = () => path.join(HISTORY_DIR, '_pending.yaml');
const MAX_BYTES = 20 * 1024 * 1024;

export function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

export function summary(spec: Spec): Json {
  return {
    title: spec.title, version: spec.version,
    apis: spec.ops.length, sections: spec.sections.length,
    fingerprint: spec.fingerprint,
  };
}

function refsOf(node: Json, found: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) refsOf(v, found);
  } else if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') found.add(node.$ref);
    for (const v of Object.values(node)) refsOf(v, found);
  }
  return found;
}

function resolves(raw: Json, ref: string): boolean {
  let node = raw;
  for (const part of ref.replace(/^#\//, '').split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object' || !(key in node)) return false;
    node = node[key];
  }
  return true;
}

/** The parsed document and a Spec built from it, or an Error a person can act on. */
export function check(text: string): { raw: Json; spec: Spec } {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('the file is larger than 20 MB');
  let raw: Json;
  try {
    raw = parseYaml(text, { maxAliasCount: -1 });
  } catch (e: Json) {
    throw new Error(`not valid YAML: ${e?.message ?? e}`);
  }
  if (!raw || typeof raw !== 'object' || !String(raw.openapi ?? '').startsWith('3.')) {
    throw new Error("not an OpenAPI 3 document (the file has no 'openapi: 3.x' line)");
  }
  for (const key of ['info', 'servers', 'paths']) {
    if (!raw[key]) throw new Error(`the document has no '${key}' section`);
  }
  const broken = [...refsOf(raw, new Set())].filter(r => !r.startsWith('#/') || !resolves(raw, r)).sort();
  if (broken.length) {
    throw new Error(`${broken.length} reference(s) point to nothing: ${broken.slice(0, 8).join(', ')}`);
  }
  let spec: Spec;
  try {
    spec = new Spec(text);
  } catch (e: Json) {
    throw new Error(`the tool could not load it: ${e?.name ?? 'Error'}: ${e?.message ?? e}`);
  }
  if (!spec.ops.length) throw new Error('the document contains no API operations');
  return { raw, spec };
}

function opsOf(raw: Json): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [p, item] of Object.entries<Json>(raw.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const [m, op] of Object.entries<Json>(item)) {
      if ((METHODS as readonly string[]).includes(m)) out[`${m.toUpperCase()} ${p}`] = op;
    }
  }
  return out;
}

function same(a: Json, b: Json): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(v: Json): string {
  const walk = (x: Json): Json => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const out: Json = {};
      for (const k of Object.keys(x).sort()) out[k] = walk(x[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

/** API label → every component it uses, directly or through others. */
function usesOf(raw: Json): Record<string, Set<string>> {
  const comps: Record<string, Json> = {};
  for (const [kind, group] of Object.entries<Json>(raw.components ?? {})) {
    if (!group || typeof group !== 'object') continue;
    for (const [name, node] of Object.entries<Json>(group)) comps[`#/components/${kind}/${name}`] = node;
  }
  const direct: Record<string, Set<string>> = {};
  for (const [ref, node] of Object.entries(comps)) direct[ref] = refsOf(node, new Set());
  const uses: Record<string, Set<string>> = {};
  for (const [label, op] of Object.entries(opsOf(raw))) {
    const seen = new Set<string>();
    const todo = [...refsOf(op, new Set())];
    while (todo.length) {
      const ref = todo.pop()!;
      if (seen.has(ref)) continue;
      seen.add(ref);
      todo.push(...(direct[ref] ?? []));
    }
    uses[label] = seen;
  }
  return uses;
}

/** What changes when the new document replaces the old one. */
export function diff(oldRaw: Json, oldSpec: Spec, newRaw: Json, newSpec: Spec): Json {
  const oldOps = opsOf(oldRaw);
  const newOps = opsOf(newRaw);
  const section: Record<string, string> = {};
  for (const o of newSpec.ops) section[`${o.method.toUpperCase()} ${o.path}`] = o.section;
  const oldSection: Record<string, string> = {};
  for (const o of oldSpec.ops) oldSection[`${o.method.toUpperCase()} ${o.path}`] = o.section;

  const added = Object.keys(newOps).filter(k => !(k in oldOps))
    .map(k => ({ api: k, section: section[k], summary: newOps[k].summary ?? '' }));
  const removed = Object.keys(oldOps).filter(k => !(k in newOps))
    .map(k => ({ api: k, section: oldSection[k], summary: oldOps[k].summary ?? '' }));
  const changed: Json[] = [];
  for (const k of Object.keys(newOps)) {
    if (!(k in oldOps) || same(oldOps[k], newOps[k])) continue;
    const fields = [...new Set([...Object.keys(oldOps[k]), ...Object.keys(newOps[k])])]
      .filter(f => !same(oldOps[k][f], newOps[k][f])).sort();
    const codesOld = new Set(Object.keys(oldOps[k].responses ?? {}).map(String));
    const codesNew = new Set(Object.keys(newOps[k].responses ?? {}).map(String));
    changed.push({
      api: k, section: section[k], parts: fields,
      codes_added: [...codesNew].filter(c => !codesOld.has(c)).sort(),
      codes_removed: [...codesOld].filter(c => !codesNew.has(c)).sort(),
    });
  }
  const uses = usesOf(newRaw);
  const oldUses = usesOf(oldRaw);
  const components: Json[] = [];
  const kinds = new Set([...Object.keys(oldRaw.components ?? {}), ...Object.keys(newRaw.components ?? {})]);
  for (const kind of [...kinds].sort()) {
    const a = (oldRaw.components ?? {})[kind] ?? {};
    const b = (newRaw.components ?? {})[kind] ?? {};
    for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const state = !(name in a) ? 'added' : !(name in b) ? 'removed' : same(a[name], b[name]) ? null : 'changed';
      if (!state) continue;
      const ref = `#/components/${kind}/${name}`;
      const pool = state === 'removed' ? oldUses : uses;
      const usedBy = Object.entries(pool).filter(([, refs]) => refs.has(ref)).map(([api]) => api).sort();
      components.push({ name, kind, state, used_by: usedBy });
    }
  }
  return {
    sections_added: newSpec.sections.filter(s => !oldSpec.sections.includes(s)),
    sections_removed: oldSpec.sections.filter(s => !newSpec.sections.includes(s)),
    added, removed, changed, components,
    same: !added.length && !removed.length && !changed.length && !components.length && same(oldRaw, newRaw),
  };
}

/** Does the tool's own Simnovator wiring still fit this document? */
export function wiring(spec: Spec): Json {
  const named = new Set<string>([
    ...testplan.CREATORS, ...testplan.CLEANUP_ORDER, ...Object.keys(testplan.CAPTURES),
    ...Object.keys(testplan.BODY_DEFAULTS), ...testplan.PROTECTED, ...Object.keys(testplan.FLOW),
    ...testplan.TESTCASE_LISTS, ...testplan.NO_DUPLICATE_CHECK,
    ...Object.keys(testplan.CLEANUP_FOR), ...Object.values(testplan.CLEANUP_FOR),
    ...testplan.WAIT_READY, ...testplan.SLOW_OPS, ...testplan.NEGATIVES_FIRST,
  ]);
  const unknown = [...named].filter(i => !(i in spec.byId)).sort();
  const unlinked: Json[] = [];
  const suggestions: string[] = [];
  for (const op of spec.ops) {
    const d = testplan.defaults(spec, op);
    const needs = [...placeholders([d.params, d.bodies])]
      .filter(v => !testplan.BUILTIN_VARS.has(v))
      .filter(v => {
        const producer = testplan.producerOf(v);
        return !producer || !(producer in spec.byId);
      })
      .sort();
    const label = `${op.method.toUpperCase()} ${op.path}`;
    if (needs.length) unlinked.push({ api: label, needs });
    const okCode = Object.keys(op.responses).find(c => c.startsWith('2'));
    const okBody = okCode ? spec.resolve(op.responses[okCode].content?.['application/json'] ?? {}) ?? {} : {};
    if (op.method === 'post' && !op.path.includes('{') && !(op.id in testplan.CAPTURES) && 'id' in (okBody.properties ?? {})) {
      suggestions.push(`${label} looks like a create API (its response has an “id”). To feed that ID to other APIs, add it to CREATORS and CAPTURES in testplan.ts.`);
    }
  }
  return { unknown, unlinked, suggestions };
}

/** Check an uploaded document and describe what applying it would change. */
export function preview(text: string, current: Spec): Json {
  ensureDirs();
  const { raw, spec } = check(text);
  fs.writeFileSync(PENDING(), text, 'utf8');
  return {
    token: spec.fingerprint,
    current: summary(current),
    new: summary(spec),
    diff: diff(current.raw, current, raw, spec),
    wiring: wiring(spec),
  };
}

/** Keep the active document before it is replaced, so nothing is ever lost. */
function archive(current: Spec): void {
  ensureDirs();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const target = path.join(HISTORY_DIR, `openapi-${stamp}.yaml`);
  fs.writeFileSync(target, readActiveText(), 'utf8');
  const meta = { ...summary(current), replaced_at: `${d.toISOString().slice(0, 10)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` };
  fs.writeFileSync(target.replace(/\.yaml$/, '.json'), JSON.stringify(meta), 'utf8');
}

/** Make the previewed document active. */
export function apply(token: string, current: Spec): Spec {
  const pending = PENDING();
  if (!fs.existsSync(pending) || fingerprint(fs.readFileSync(pending, 'utf8')) !== token) {
    throw new Error('that preview is no longer available; upload the file again');
  }
  archive(current);
  fs.copyFileSync(pending, ACTIVE);
  fs.rmSync(pending, { force: true });
  invalidateSpec();
  return new Spec(fs.readFileSync(ACTIVE, 'utf8'));
}

export function history(): Json[] {
  ensureDirs();
  const items: Json[] = [];
  const files = fs.readdirSync(HISTORY_DIR).filter(f => SAVED_NAME.test(f)).sort().reverse();
  for (const f of files) {
    const metaFile = path.join(HISTORY_DIR, f.replace(/\.yaml$/, '.json'));
    let meta: Json = {};
    try {
      if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch { /* a missing sidecar just means fewer details */ }
    items.push({ file: f, ...meta });
  }
  return items;
}

/** Make an archived document active again; the current one is archived first. */
export function rollback(name: string, current: Spec): Spec {
  const file = path.join(HISTORY_DIR, name);
  if (!SAVED_NAME.test(name) || !fs.existsSync(file)) throw new Error('no such saved document');
  const text = fs.readFileSync(file, 'utf8');
  check(text);
  fs.rmSync(PENDING(), { force: true });
  archive(current);
  fs.writeFileSync(ACTIVE, text, 'utf8');
  invalidateSpec();
  return new Spec(text);
}

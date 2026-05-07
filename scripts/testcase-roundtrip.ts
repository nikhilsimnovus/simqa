// Round-trip QA for /testcases on the live box.
//
// Pulls a real testcase, pushes it back under a different name/id, and probes
// edge cases (collision, empty name, special chars, long names, unicode, deep
// diff). Each probe records request + response so the failures are reviewable.
//
// Usage:
//   tsx scripts/testcase-roundtrip.ts
// Optional env:
//   UESIM_HOST     (default 192.168.1.95)
//   UESIM_USER     (default admin)
//   UESIM_PASS     (default admin)
//   SEED_ID        (default: first testcase from /testcases list)
//   OUT            (default: scripts/.out/roundtrip-<ts>.json)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const HOST = process.env.UESIM_HOST ?? '192.168.1.95';
const USER = process.env.UESIM_USER ?? 'admin';
const PASS = process.env.UESIM_PASS ?? 'admin';
const SEED_ID_OVERRIDE = process.env.SEED_ID;
const RUN_ID = `qa-rt-${Date.now().toString(36)}`;
const OUT = process.env.OUT ?? resolve(process.cwd(), `scripts/.out/roundtrip-${RUN_ID}.json`);

const base = `http://${HOST}/v2`;

interface Probe {
  name: string;
  category: 'baseline' | 'roundtrip' | 'collision' | 'edge-name' | 'integrity' | 'mutation';
  request: { method: string; url: string; headers?: Record<string, string>; body?: unknown };
  response?: { status: number; statusText: string; headers: Record<string, string>; body: unknown; durationMs: number };
  ok: boolean;
  expected: string;
  observation: string;
  bug?: 'YES' | 'NO' | 'INVESTIGATE';
}

const probes: Probe[] = [];

function recordProbe(p: Probe) {
  probes.push(p);
  const tag = p.ok ? 'PASS' : (p.bug === 'YES' ? 'BUG ' : 'FAIL');
  console.log(`[${tag}] ${p.category.padEnd(10)} ${p.name}`);
  if (!p.ok) console.log(`         expected: ${p.expected}\n         got:      ${p.observation}`);
}

async function login(): Promise<string> {
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!r.ok) throw new Error(`login ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  return j.access_token as string;
}

function redact(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase() === 'authorization' ? 'Bearer <REDACTED>' : v;
  }
  return out;
}

async function readBody(r: Response): Promise<unknown> {
  const txt = await r.text().catch(() => '');
  try { return txt ? JSON.parse(txt) : ''; } catch { return txt; }
}

function headersToObj(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

async function call(
  method: string,
  url: string,
  init: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: BodyInit } = {},
): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: unknown; durationMs: number; sentHeaders: Record<string, string>; sentBody: unknown }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers['Authorization'] = `Bearer ${init.token}`;
  if (init.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const t0 = Date.now();
  const res = await fetch(url, {
    method,
    headers,
    body: init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const ms = Date.now() - t0;
  const body = await readBody(res);
  return {
    status: res.status,
    statusText: res.statusText,
    headers: headersToObj(res.headers),
    body,
    durationMs: ms,
    sentHeaders: redact(headers),
    sentBody: init.rawBody ? '<multipart>' : init.body,
  };
}

async function importTestcase(token: string, pack: any): Promise<{ status: number; body: any; durationMs: number; landedIds: string[] }> {
  const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
  const form = new FormData();
  form.append('file', blob, 'pack.json');
  const t0 = Date.now();
  const res = await fetch(`${base}/testcases/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const ms = Date.now() - t0;
  const body = await readBody(res);
  const arr: any[] = (body as any)?.testCases ?? (body as any)?.imported ?? [];
  const landedIds = arr.map((x) => x?.id ?? x?.testCaseId).filter(Boolean) as string[];
  return { status: res.status, body, durationMs: ms, landedIds };
}

function deepDiff(a: any, b: any, path = ''): string[] {
  const diffs: string[] = [];
  if (a === b) return diffs;
  if (typeof a !== typeof b) {
    diffs.push(`${path}: type ${typeof a} -> ${typeof b}`);
    return diffs;
  }
  if (a === null || b === null || typeof a !== 'object') {
    if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    return diffs;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    diffs.push(`${path}: array<->object`);
    return diffs;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) diffs.push(`${path}: array len ${a.length} -> ${b.length}`);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diffs.push(...deepDiff(a[i], b[i], `${path}[${i}]`));
    return diffs;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) { diffs.push(`${path}.${k}: <missing> -> ${JSON.stringify(b[k]).slice(0, 80)}`); continue; }
    if (!(k in b)) { diffs.push(`${path}.${k}: ${JSON.stringify(a[k]).slice(0, 80)} -> <missing>`); continue; }
    diffs.push(...deepDiff(a[k], b[k], `${path}.${k}`));
  }
  return diffs;
}

async function main() {
  console.log(`run-id=${RUN_ID}  host=${HOST}  user=${USER}\n`);

  const token = await login();
  console.log('login ok\n');

  // ---------- Baseline: list and pick a seed ----------
  const list = await call('GET', `${base}/testcases?limit=50&offset=0`, { token });
  recordProbe({
    name: 'GET /testcases?limit=50',
    category: 'baseline',
    request: { method: 'GET', url: `${base}/testcases?limit=50&offset=0` },
    response: list,
    ok: list.status === 200,
    expected: '200 with items array',
    observation: `${list.status}, ${(list.body as any)?.items?.length ?? 0} items`,
  });
  const items: any[] = (list.body as any)?.items ?? [];
  if (items.length === 0) {
    console.log('no testcases on box; cannot proceed');
    return;
  }
  const seedId = SEED_ID_OVERRIDE ?? items[0].id;
  const initialCount = items.length;

  const seedFetch = await call('GET', `${base}/testcases/${encodeURIComponent(seedId)}`, { token });
  recordProbe({
    name: `GET /testcases/${seedId} (seed)`,
    category: 'baseline',
    request: { method: 'GET', url: `${base}/testcases/${seedId}` },
    response: seedFetch,
    ok: seedFetch.status === 200 && !!(seedFetch.body as any)?.testDefinition,
    expected: '200 with testDefinition body',
    observation: `${seedFetch.status}; testDefinition=${!!(seedFetch.body as any)?.testDefinition}`,
  });
  if (seedFetch.status !== 200) { console.log('seed fetch failed; abort'); return; }
  const seed = seedFetch.body as any;
  const seedTd = seed.testDefinition;
  const seedName = seed.name ?? seedId;

  // ---------- T1: Basic round-trip with new id + new name ----------
  const newId1 = `${RUN_ID}_T1`;
  const newName1 = `${RUN_ID}_T1_renamed`;
  const imp1 = await importTestcase(token, { id: newId1, name: newName1, testDefinition: seedTd });
  recordProbe({
    name: 'T1 import {newId, newName}',
    category: 'roundtrip',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { id: newId1, name: newName1, testDefinition: '<seed>' } },
    response: { status: imp1.status, statusText: '', headers: {}, body: imp1.body, durationMs: imp1.durationMs },
    ok: imp1.status >= 200 && imp1.status < 300,
    expected: '200 with importedCount>=1, testCases[0].id reflecting the requested id (or a documented rename)',
    observation: `${imp1.status}; landedIds=${JSON.stringify(imp1.landedIds)}`,
  });

  // What id did it actually land under?
  const landed1 = imp1.landedIds[0] ?? newId1;

  // GET it back
  const get1 = await call('GET', `${base}/testcases/${encodeURIComponent(landed1)}`, { token });
  recordProbe({
    name: `T1 GET after import (${landed1})`,
    category: 'roundtrip',
    request: { method: 'GET', url: `${base}/testcases/${landed1}` },
    response: get1,
    ok: get1.status === 200,
    expected: '200; the freshly-imported testcase must be retrievable by the id reported in the import response',
    observation: `${get1.status}`,
  });

  const got1 = get1.body as any;
  recordProbe({
    name: 'T1 name preserved on round-trip',
    category: 'roundtrip',
    request: { method: 'compare', url: '(local)' },
    ok: got1?.name === newName1,
    expected: `name === "${newName1}" (the name we sent on import)`,
    observation: `name="${got1?.name}"`,
  });

  // ---------- T2: List should now include the new entry ----------
  const list2 = await call('GET', `${base}/testcases?limit=200&offset=0`, { token });
  const items2: any[] = (list2.body as any)?.items ?? [];
  const found = items2.find((x) => x.id === landed1);
  recordProbe({
    name: 'T2 new testcase appears in list',
    category: 'roundtrip',
    request: { method: 'GET', url: `${base}/testcases?limit=200` },
    response: list2,
    ok: !!found,
    expected: 'imported testcase visible in /testcases listing immediately after import (no eventual-consistency gap)',
    observation: found ? `present, name="${found.name}"` : `NOT FOUND (count went ${initialCount} -> ${items2.length})`,
  });

  // ---------- T3: Deep equality of testDefinition ----------
  const diffs = deepDiff(seedTd, got1?.testDefinition, 'testDefinition');
  recordProbe({
    name: 'T3 testDefinition deep-equal after round-trip',
    category: 'integrity',
    request: { method: 'compare', url: '(local)' },
    ok: diffs.length === 0,
    expected: 'every field of testDefinition that we uploaded comes back byte-identical when re-fetched',
    observation: diffs.length === 0 ? 'identical' : `${diffs.length} diffs, e.g. ${diffs.slice(0, 3).join(' | ')}`,
  });

  // ---------- T4: Same name as seed (collision on name) ----------
  const newId4 = `${RUN_ID}_T4`;
  const imp4 = await importTestcase(token, { id: newId4, name: seedName, testDefinition: seedTd });
  recordProbe({
    name: `T4 import with name="${seedName}" (collides with seed name)`,
    category: 'collision',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { id: newId4, name: seedName } },
    response: { status: imp4.status, statusText: '', headers: {}, body: imp4.body, durationMs: imp4.durationMs },
    ok: imp4.status === 409 || imp4.status === 400 || (imp4.status >= 200 && imp4.status < 300),
    expected: 'either 409 CONFLICT (names must be unique) or 200 with documented behavior (e.g. auto-suffix). Document one.',
    observation: `${imp4.status}; landed=${JSON.stringify(imp4.landedIds)}`,
    bug: imp4.status >= 500 ? 'YES' : 'INVESTIGATE',
  });
  const landed4 = imp4.landedIds[0];

  // ---------- T5: Same id as existing (collision on id) ----------
  const imp5 = await importTestcase(token, { id: seedId, name: `${RUN_ID}_T5_overwrite_attempt`, testDefinition: seedTd });
  recordProbe({
    name: `T5 import with id="${seedId}" (collides with seed id)`,
    category: 'collision',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { id: seedId, name: `${RUN_ID}_T5_overwrite_attempt` } },
    response: { status: imp5.status, statusText: '', headers: {}, body: imp5.body, durationMs: imp5.durationMs },
    ok: imp5.status === 409 || imp5.status === 400 || (imp5.status >= 200 && imp5.status < 300),
    expected: '409 CONFLICT (id reserved) OR 200 with auto-rename (then verify seed id is still untouched). Silent overwrite would be a critical data-loss bug.',
    observation: `${imp5.status}; landed=${JSON.stringify(imp5.landedIds)}`,
    bug: imp5.status >= 500 ? 'YES' : 'INVESTIGATE',
  });
  // If T5 didn't error, verify the seed is still intact
  if (imp5.status >= 200 && imp5.status < 300) {
    const seedRecheck = await call('GET', `${base}/testcases/${encodeURIComponent(seedId)}`, { token });
    const stillSeedName = (seedRecheck.body as any)?.name === seedName;
    recordProbe({
      name: 'T5b after id-collision import, seed must still be untouched',
      category: 'collision',
      request: { method: 'GET', url: `${base}/testcases/${seedId}` },
      response: seedRecheck,
      ok: stillSeedName,
      expected: `seed (id=${seedId}) name still "${seedName}" — must NOT have been overwritten by T5`,
      observation: `name now="${(seedRecheck.body as any)?.name}"`,
      bug: stillSeedName ? 'NO' : 'YES',
    });
  }
  const landed5 = imp5.landedIds[0];

  // ---------- T6: Empty name ----------
  const imp6 = await importTestcase(token, { id: `${RUN_ID}_T6`, name: '', testDefinition: seedTd });
  recordProbe({
    name: 'T6 import with empty name ""',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { id: `${RUN_ID}_T6`, name: '' } },
    response: { status: imp6.status, statusText: '', headers: {}, body: imp6.body, durationMs: imp6.durationMs },
    ok: imp6.status >= 400 && imp6.status < 500,
    expected: '400 BAD_REQUEST: name is required, must be non-empty string',
    observation: `${imp6.status}; landed=${JSON.stringify(imp6.landedIds)}`,
    bug: imp6.status >= 200 && imp6.status < 300 ? 'YES' : (imp6.status >= 500 ? 'YES' : 'NO'),
  });
  const landed6 = imp6.landedIds[0];

  // ---------- T7: Whitespace-only name ----------
  const imp7 = await importTestcase(token, { id: `${RUN_ID}_T7`, name: '   ', testDefinition: seedTd });
  recordProbe({
    name: 'T7 import with whitespace-only name "   "',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { id: `${RUN_ID}_T7`, name: '   ' } },
    response: { status: imp7.status, statusText: '', headers: {}, body: imp7.body, durationMs: imp7.durationMs },
    ok: imp7.status >= 400 && imp7.status < 500,
    expected: '400 BAD_REQUEST: name must contain non-whitespace characters',
    observation: `${imp7.status}; landed=${JSON.stringify(imp7.landedIds)}`,
    bug: imp7.status >= 200 && imp7.status < 300 ? 'INVESTIGATE' : 'NO',
  });
  const landed7 = imp7.landedIds[0];

  // ---------- T8: Very long name (1000 chars) ----------
  const longName = 'A'.repeat(1000);
  const imp8 = await importTestcase(token, { id: `${RUN_ID}_T8`, name: longName, testDefinition: seedTd });
  recordProbe({
    name: 'T8 import with 1000-char name',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { id: `${RUN_ID}_T8`, name: '<1000 As>' } },
    response: { status: imp8.status, statusText: '', headers: {}, body: imp8.body, durationMs: imp8.durationMs },
    ok: imp8.status === 400 || (imp8.status >= 200 && imp8.status < 300),
    expected: 'either 400 BAD_REQUEST (name length cap, e.g. 256) OR 200 with the full string preserved. 5xx = crash',
    observation: `${imp8.status}; landed=${JSON.stringify(imp8.landedIds)}`,
    bug: imp8.status >= 500 ? 'YES' : 'INVESTIGATE',
  });
  const landed8 = imp8.landedIds[0];
  if (landed8) {
    const get8 = await call('GET', `${base}/testcases/${encodeURIComponent(landed8)}`, { token });
    const got8Name = (get8.body as any)?.name ?? '';
    recordProbe({
      name: 'T8b 1000-char name preserved on round-trip',
      category: 'edge-name',
      request: { method: 'GET', url: `${base}/testcases/${landed8}` },
      response: get8,
      ok: got8Name === longName,
      expected: `if T8 returned 200, name on GET must equal the 1000 As we sent`,
      observation: `length=${got8Name.length}, equal=${got8Name === longName}`,
      bug: got8Name === longName ? 'NO' : 'INVESTIGATE',
    });
  }

  // ---------- T9: Special characters (path traversal flavored) ----------
  const specialName = '../../etc/passwd<script>alert(1)</script>';
  const imp9 = await importTestcase(token, { id: `${RUN_ID}_T9`, name: specialName, testDefinition: seedTd });
  recordProbe({
    name: 'T9 import with special chars / path-traversal-flavored name',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { id: `${RUN_ID}_T9`, name: specialName } },
    response: { status: imp9.status, statusText: '', headers: {}, body: imp9.body, durationMs: imp9.durationMs },
    ok: imp9.status === 400 || (imp9.status >= 200 && imp9.status < 300),
    expected: 'name is a label, not a filesystem path. Either accept it as a literal string OR 400 with explicit char rules. 5xx = crash, 200 with literal path components in any filename = critical',
    observation: `${imp9.status}`,
    bug: imp9.status >= 500 ? 'YES' : 'INVESTIGATE',
  });
  const landed9 = imp9.landedIds[0];

  // ---------- T10: Unicode name ----------
  const unicodeName = '测试用例-🚀-αβγ';
  const imp10 = await importTestcase(token, { id: `${RUN_ID}_T10`, name: unicodeName, testDefinition: seedTd });
  recordProbe({
    name: 'T10 import with unicode name',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { id: `${RUN_ID}_T10`, name: unicodeName } },
    response: { status: imp10.status, statusText: '', headers: {}, body: imp10.body, durationMs: imp10.durationMs },
    ok: imp10.status >= 200 && imp10.status < 300,
    expected: '200 with name preserved verbatim; modern services should be UTF-8 clean',
    observation: `${imp10.status}`,
    bug: imp10.status >= 500 ? 'YES' : 'INVESTIGATE',
  });
  const landed10 = imp10.landedIds[0];
  if (landed10) {
    const get10 = await call('GET', `${base}/testcases/${encodeURIComponent(landed10)}`, { token });
    const got10Name = (get10.body as any)?.name ?? '';
    recordProbe({
      name: 'T10b unicode name preserved on round-trip',
      category: 'edge-name',
      request: { method: 'GET', url: `${base}/testcases/${landed10}` },
      response: get10,
      ok: got10Name === unicodeName,
      expected: `name on GET must equal "${unicodeName}" exactly`,
      observation: `name="${got10Name}"`,
      bug: got10Name === unicodeName ? 'NO' : 'YES',
    });
  }

  // ---------- T11: Mutate a field, upload, verify it persists ----------
  // Pick a known scalar in testDefinition that's safe to tweak. Most tdefs
  // have master.label / cellConfig.cells[0].cellId / .... Try description if
  // present, else master.label.
  const mutated = JSON.parse(JSON.stringify(seedTd));
  let mutationPath = '(none)';
  let mutationOldVal: any = null;
  let mutationNewVal: any = null;
  if (mutated?.master && typeof mutated.master.label === 'string') {
    mutationPath = 'testDefinition.master.label';
    mutationOldVal = mutated.master.label;
    mutationNewVal = `qa-mutated-${Date.now()}`;
    mutated.master.label = mutationNewVal;
  } else if (mutated?.cellConfig?.cells?.[0]?.cellId !== undefined) {
    mutationPath = 'testDefinition.cellConfig.cells[0].cellId';
    mutationOldVal = mutated.cellConfig.cells[0].cellId;
    mutationNewVal = (typeof mutationOldVal === 'number' ? mutationOldVal + 99 : `${mutationOldVal}-mut`);
    mutated.cellConfig.cells[0].cellId = mutationNewVal;
  }

  const imp11 = await importTestcase(token, { id: `${RUN_ID}_T11`, name: `${RUN_ID}_T11_mutated`, testDefinition: mutated });
  const landed11 = imp11.landedIds[0];
  if (landed11) {
    const get11 = await call('GET', `${base}/testcases/${encodeURIComponent(landed11)}`, { token });
    const td11 = (get11.body as any)?.testDefinition;
    let backVal: any = '(unset)';
    if (mutationPath === 'testDefinition.master.label') backVal = td11?.master?.label;
    else if (mutationPath === 'testDefinition.cellConfig.cells[0].cellId') backVal = td11?.cellConfig?.cells?.[0]?.cellId;
    recordProbe({
      name: `T11 mutate ${mutationPath} -> upload -> verify`,
      category: 'mutation',
      request: { method: 'POST', url: `${base}/testcases/import`, body: { id: `${RUN_ID}_T11`, name: `${RUN_ID}_T11_mutated`, mutation: { path: mutationPath, old: mutationOldVal, new: mutationNewVal } } },
      response: { status: imp11.status, statusText: '', headers: {}, body: imp11.body, durationMs: imp11.durationMs },
      ok: backVal === mutationNewVal,
      expected: `after import + GET, ${mutationPath} === ${JSON.stringify(mutationNewVal)} (mutation must persist; server must accept user-supplied tdef)`,
      observation: `import=${imp11.status}, GET-back-value=${JSON.stringify(backVal)}`,
      bug: backVal === mutationNewVal ? 'NO' : 'INVESTIGATE',
    });
  } else {
    recordProbe({
      name: `T11 mutate ${mutationPath} -> upload -> verify`,
      category: 'mutation',
      request: { method: 'POST', url: `${base}/testcases/import`, body: { id: `${RUN_ID}_T11` } },
      response: { status: imp11.status, statusText: '', headers: {}, body: imp11.body, durationMs: imp11.durationMs },
      ok: false,
      expected: 'import must accept the mutated payload and return the new id',
      observation: `import returned ${imp11.status}, no landed id`,
      bug: 'INVESTIGATE',
    });
  }

  // ---------- Final list count ----------
  const list3 = await call('GET', `${base}/testcases?limit=500&offset=0`, { token });
  const items3: any[] = (list3.body as any)?.items ?? [];
  console.log(`\n--- list count: before=${initialCount}  after=${items3.length}  delta=${items3.length - initialCount}`);

  const leakedIds = [landed1, landed4, landed5, landed6, landed7, landed8, landed9, landed10, landed11].filter(Boolean) as string[];
  console.log(`\n--- LEAKED ids (DELETE is broken, manual cleanup needed):`);
  for (const id of leakedIds) console.log(`     ${id}`);

  const summary = {
    runId: RUN_ID,
    host: HOST,
    seedId,
    seedName,
    initialCount,
    finalCount: items3.length,
    leakedIds,
    counts: {
      total: probes.length,
      pass: probes.filter((p) => p.ok).length,
      fail: probes.filter((p) => !p.ok).length,
      bugs: probes.filter((p) => p.bug === 'YES').length,
      investigate: probes.filter((p) => p.bug === 'INVESTIGATE').length,
    },
    probes,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\n--- summary: ${summary.counts.pass}/${summary.counts.total} pass, ${summary.counts.fail} fail (${summary.counts.bugs} confirmed bugs, ${summary.counts.investigate} to investigate)`);
  console.log(`--- evidence written to: ${OUT}\n`);

  // Print the failures distinctly
  const failures = probes.filter((p) => !p.ok);
  if (failures.length) {
    console.log('--- FAILURES & ANOMALIES ---');
    for (const f of failures) {
      console.log(`\n[${f.category}] ${f.name}`);
      console.log(`  expected: ${f.expected}`);
      console.log(`  got:      ${f.observation}`);
      if (f.bug) console.log(`  bug:      ${f.bug}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

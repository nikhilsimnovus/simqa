// Round-trip QA v2: use the actual export -> import wire format the box uses.
//
// The shape is:  { test_case_details: [{ Test_Id, Test_Name, Test_Config_Intermediate_Object, Config_File, ... }] }
//
// Probes:
//   T1 vanilla rename (new id + new name)
//   T2 list shows the new entry
//   T3 GET deep-equal with original Test_Config_Intermediate_Object
//   T4 collision: existing name (same Test_Id new)
//   T5 collision: existing id (would-be overwrite)
//   T6 empty Test_Name
//   T7 whitespace-only Test_Name
//   T8 1000-char Test_Name
//   T9 special-chars Test_Name (path-traversal flavored)
//   T10 unicode Test_Name
//   T11 mutate a value, upload, verify it persists
//   T12 upload SAME Test_Id twice in a row -> second should fail or auto-rename
//   T13 omit Test_Name entirely (only Test_Id present)
//   T14 omit Test_Id entirely (only Test_Name present)
//   T15 both missing entirely

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const HOST = process.env.UESIM_HOST ?? '192.168.1.95';
const USER = process.env.UESIM_USER ?? 'admin';
const PASS = process.env.UESIM_PASS ?? 'admin';
const RUN = `qart2-${Date.now().toString(36)}`;
const OUT = process.env.OUT ?? resolve(process.cwd(), `scripts/.out/roundtrip-v2-${RUN}.json`);
const base = `http://${HOST}/v2`;

interface Probe {
  name: string;
  category: string;
  request: any;
  response?: any;
  ok: boolean;
  expected: string;
  observation: string;
  bug?: 'YES' | 'NO' | 'INVESTIGATE';
}

const probes: Probe[] = [];
function record(p: Probe) {
  probes.push(p);
  const tag = p.ok ? 'PASS' : (p.bug === 'YES' ? 'BUG ' : 'FAIL');
  console.log(`[${tag}] ${p.category.padEnd(10)} ${p.name}`);
  if (!p.ok) console.log(`         expected: ${p.expected}\n         got:      ${p.observation}`);
}

async function login(): Promise<string> {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  return (await r.json() as any).access_token;
}

function headersToObj(h: Headers) { const o: any = {}; h.forEach((v, k) => { o[k] = v; }); return o; }
async function readBody(r: Response) { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } }

async function call(method: string, url: string, init: { token?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const t0 = Date.now();
  const r = await fetch(url, { method, headers, body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined) });
  const ms = Date.now() - t0;
  return { status: r.status, statusText: r.statusText, headers: headersToObj(r.headers), body: await readBody(r), durationMs: ms };
}

async function importPack(token: string, pack: any) {
  const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
  const form = new FormData();
  form.append('file', blob, 'pack.json');
  const t0 = Date.now();
  const r = await fetch(`${base}/testcases/import`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const ms = Date.now() - t0;
  const body = await readBody(r);
  const arr: any[] = (body as any)?.testCases ?? (body as any)?.imported ?? (body as any)?.test_case_details ?? [];
  const landedIds: string[] = arr.map((x: any) => x?.id ?? x?.Test_Id ?? x?.testCaseId).filter(Boolean);
  return { status: r.status, body, durationMs: ms, landedIds };
}

async function exportTc(token: string, ids: string[]): Promise<{ status: number; body: any; durationMs: number }> {
  const t0 = Date.now();
  const r = await fetch(`${base}/testcases/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ testCaseIds: ids, output: { type: 'json' } }),
  });
  return { status: r.status, body: await readBody(r), durationMs: Date.now() - t0 };
}

function deepDiff(a: any, b: any, p = ''): string[] {
  const d: string[] = [];
  if (a === b) return d;
  if (typeof a !== typeof b) { d.push(`${p}: type ${typeof a}->${typeof b}`); return d; }
  if (a === null || b === null || typeof a !== 'object') { if (a !== b) d.push(`${p}: ${JSON.stringify(a)?.slice(0, 80)} -> ${JSON.stringify(b)?.slice(0, 80)}`); return d; }
  if (Array.isArray(a) !== Array.isArray(b)) { d.push(`${p}: array<->object`); return d; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) d.push(`${p}: array len ${a.length}->${b.length}`);
    for (let i = 0; i < Math.max(a.length, b.length); i++) d.push(...deepDiff(a[i], b[i], `${p}[${i}]`));
    return d;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) { d.push(`${p}.${k}: <missing> -> ${JSON.stringify(b[k]).slice(0, 80)}`); continue; }
    if (!(k in b)) { d.push(`${p}.${k}: ${JSON.stringify(a[k]).slice(0, 80)} -> <missing>`); continue; }
    d.push(...deepDiff(a[k], b[k], `${p}.${k}`));
  }
  return d;
}

function clonePack(seed: any, overrides: Record<string, any> = {}, deletes: string[] = []) {
  const cloned = JSON.parse(JSON.stringify(seed));
  const detail = cloned.test_case_details[0];
  // Clear server-managed fields the API may reject if echoed back
  delete detail.Created_Date;
  delete detail.Modified_Date;
  delete detail.Deleted_Date;
  // Apply overrides
  for (const [k, v] of Object.entries(overrides)) detail[k] = v;
  for (const k of deletes) delete detail[k];
  return cloned;
}

async function main() {
  console.log(`run=${RUN}  host=${HOST}\n`);
  const token = await login();
  console.log('login ok\n');

  // 1. Pick a seed
  const list = await call('GET', `${base}/testcases?limit=50&offset=0`, { token });
  const items: any[] = (list.body as any)?.items ?? [];
  if (!items.length) { console.log('no testcases; abort'); return; }
  const seedId = items[0].id;
  const seedName = items[0].name;
  const initialCount = items.length;
  console.log(`seed: id=${seedId} name=${seedName}`);

  // 2. Export it (this is the wire format we need)
  const exp = await exportTc(token, [seedId]);
  record({
    name: 'baseline export of seed',
    category: 'baseline',
    request: { method: 'POST', url: `${base}/testcases/export`, body: { testCaseIds: [seedId] } },
    response: exp,
    ok: exp.status === 200 && Array.isArray((exp.body as any)?.test_case_details) && (exp.body as any).test_case_details.length === 1,
    expected: '200 with { test_case_details: [<one entry>] }',
    observation: `${exp.status}; entries=${(exp.body as any)?.test_case_details?.length ?? 0}`,
  });
  if (exp.status !== 200) { console.log('export failed; abort'); return; }
  const seedPack = exp.body;

  // ---------- T1: vanilla rename ----------
  const id1 = `${RUN}_T1`;
  const name1 = `${RUN}_T1_renamed`;
  const pack1 = clonePack(seedPack, { Test_Id: id1, Test_Name: name1 });
  const imp1 = await importPack(token, pack1);
  record({
    name: 'T1 import vanilla rename',
    category: 'roundtrip',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { Test_Id: id1, Test_Name: name1 } },
    response: { status: imp1.status, body: imp1.body, durationMs: imp1.durationMs },
    ok: imp1.status >= 200 && imp1.status < 300,
    expected: '200 with the new testcase reported in the response',
    observation: `${imp1.status}; landed=${JSON.stringify(imp1.landedIds)}`,
  });

  const landed1 = imp1.landedIds[0] ?? id1;

  // GET back
  const get1 = await call('GET', `${base}/testcases/${encodeURIComponent(landed1)}`, { token });
  record({
    name: `T1 GET ${landed1}`,
    category: 'roundtrip',
    request: { method: 'GET', url: `${base}/testcases/${landed1}` },
    response: get1,
    ok: get1.status === 200,
    expected: '200 (imported testcase retrievable by reported id)',
    observation: `${get1.status}`,
  });
  record({
    name: 'T1 GET .name === sent Test_Name',
    category: 'roundtrip',
    request: { method: 'compare', url: '(local)' },
    ok: (get1.body as any)?.name === name1,
    expected: `name === "${name1}"`,
    observation: `name="${(get1.body as any)?.name}"`,
  });

  // ---------- T2: list shows new entry ----------
  const list2 = await call('GET', `${base}/testcases?limit=500&offset=0`, { token });
  const items2: any[] = (list2.body as any)?.items ?? [];
  const found = items2.find((x) => x.id === landed1);
  record({
    name: 'T2 new testcase appears in /testcases listing',
    category: 'roundtrip',
    request: { method: 'GET', url: `${base}/testcases?limit=500` },
    response: list2,
    ok: !!found,
    expected: 'imported testcase visible in list immediately after import',
    observation: found ? `present, name="${found.name}"` : 'NOT FOUND',
  });

  // ---------- T3: deep-equal of Test_Config_Intermediate_Object ----------
  const expBack = await exportTc(token, [landed1]);
  const detailBack = (expBack.body as any)?.test_case_details?.[0];
  const detailSent = (pack1 as any).test_case_details[0];
  const tdDiffs = deepDiff(detailSent.Test_Config_Intermediate_Object, detailBack?.Test_Config_Intermediate_Object, 'Test_Config_Intermediate_Object');
  record({
    name: 'T3 Test_Config_Intermediate_Object deep-equal after round-trip',
    category: 'integrity',
    request: { method: 'compare', url: '(local)' },
    ok: tdDiffs.length === 0,
    expected: 'every field of Test_Config_Intermediate_Object that we uploaded comes back byte-identical when re-exported',
    observation: tdDiffs.length === 0 ? 'identical' : `${tdDiffs.length} diffs, e.g. ${tdDiffs.slice(0, 3).join(' | ')}`,
  });
  const cfDiffs = deepDiff(detailSent.Config_File, detailBack?.Config_File, 'Config_File');
  record({
    name: 'T3b Config_File deep-equal after round-trip',
    category: 'integrity',
    request: { method: 'compare', url: '(local)' },
    ok: cfDiffs.length === 0,
    expected: 'Config_File comes back byte-identical (the legacy raw enb-config-style block)',
    observation: cfDiffs.length === 0 ? 'identical' : `${cfDiffs.length} diffs, e.g. ${cfDiffs.slice(0, 3).join(' | ')}`,
  });

  // ---------- T4: name collision ----------
  const id4 = `${RUN}_T4`;
  const pack4 = clonePack(seedPack, { Test_Id: id4, Test_Name: seedName });
  const imp4 = await importPack(token, pack4);
  record({
    name: `T4 import {Test_Id=new, Test_Name="${seedName}" already-taken}`,
    category: 'collision',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { Test_Id: id4, Test_Name: seedName } },
    response: { status: imp4.status, body: imp4.body, durationMs: imp4.durationMs },
    ok: imp4.status === 409 || imp4.status === 400 || (imp4.status >= 200 && imp4.status < 300),
    expected: '409 CONFLICT (names must be unique) or 400 with explicit error or 200 with documented auto-rename. NOT 5xx, NOT silent overwrite of the existing same-named testcase.',
    observation: `${imp4.status}: ${JSON.stringify(imp4.body).slice(0, 200)}`,
    bug: imp4.status >= 500 ? 'YES' : 'INVESTIGATE',
  });

  // ---------- T5: id collision (overwrite attempt) ----------
  const pack5 = clonePack(seedPack, { Test_Id: seedId, Test_Name: `${RUN}_T5_overwrite_attempt` });
  const imp5 = await importPack(token, pack5);
  record({
    name: `T5 import {Test_Id="${seedId}" already-taken, Test_Name=new}`,
    category: 'collision',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { Test_Id: seedId, Test_Name: `${RUN}_T5_overwrite_attempt` } },
    response: { status: imp5.status, body: imp5.body, durationMs: imp5.durationMs },
    ok: imp5.status === 409 || imp5.status === 400,
    expected: '409 CONFLICT — Test_Id must be unique. Silent overwrite of the existing testcase would be data loss.',
    observation: `${imp5.status}: ${JSON.stringify(imp5.body).slice(0, 200)}`,
    bug: imp5.status >= 500 ? 'YES' : (imp5.status >= 200 && imp5.status < 300 ? 'INVESTIGATE' : 'NO'),
  });
  // Verify seed still intact regardless of T5 outcome
  const seedRecheck = await call('GET', `${base}/testcases/${encodeURIComponent(seedId)}`, { token });
  record({
    name: 'T5b seed still intact after id-collision import attempt',
    category: 'collision',
    request: { method: 'GET', url: `${base}/testcases/${seedId}` },
    response: seedRecheck,
    ok: (seedRecheck.body as any)?.name === seedName,
    expected: `seed (id=${seedId}) name still "${seedName}" — must NOT be overwritten by an import collision`,
    observation: `name="${(seedRecheck.body as any)?.name}"`,
    bug: (seedRecheck.body as any)?.name === seedName ? 'NO' : 'YES',
  });

  // ---------- T6: empty Test_Name ----------
  const pack6 = clonePack(seedPack, { Test_Id: `${RUN}_T6`, Test_Name: '' });
  const imp6 = await importPack(token, pack6);
  record({
    name: 'T6 import with Test_Name=""',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { Test_Id: `${RUN}_T6`, Test_Name: '' } },
    response: { status: imp6.status, body: imp6.body, durationMs: imp6.durationMs },
    ok: imp6.status >= 400 && imp6.status < 500,
    expected: '400 BAD_REQUEST: Test_Name is required, must be non-empty string',
    observation: `${imp6.status}: ${JSON.stringify(imp6.body).slice(0, 200)}`,
    bug: imp6.status >= 200 && imp6.status < 300 ? 'YES' : (imp6.status >= 500 ? 'YES' : 'NO'),
  });

  // ---------- T7: whitespace-only ----------
  const pack7 = clonePack(seedPack, { Test_Id: `${RUN}_T7`, Test_Name: '   ' });
  const imp7 = await importPack(token, pack7);
  record({
    name: 'T7 import with Test_Name="   "',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { Test_Id: `${RUN}_T7`, Test_Name: '   ' } },
    response: { status: imp7.status, body: imp7.body, durationMs: imp7.durationMs },
    ok: imp7.status >= 400 && imp7.status < 500,
    expected: '400 BAD_REQUEST: Test_Name must contain non-whitespace characters',
    observation: `${imp7.status}: ${JSON.stringify(imp7.body).slice(0, 200)}`,
    bug: imp7.status >= 200 && imp7.status < 300 ? 'INVESTIGATE' : (imp7.status >= 500 ? 'YES' : 'NO'),
  });

  // ---------- T8: 1000-char name ----------
  const longName = 'A'.repeat(1000);
  const pack8 = clonePack(seedPack, { Test_Id: `${RUN}_T8`, Test_Name: longName });
  const imp8 = await importPack(token, pack8);
  record({
    name: 'T8 import with 1000-char Test_Name',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { Test_Id: `${RUN}_T8`, Test_Name: '<1000 As>' } },
    response: { status: imp8.status, body: imp8.body, durationMs: imp8.durationMs },
    ok: imp8.status === 400 || (imp8.status >= 200 && imp8.status < 300),
    expected: '400 BAD_REQUEST (length cap, e.g. 256) OR 200 with full string preserved. 5xx = crash',
    observation: `${imp8.status}: ${JSON.stringify(imp8.body).slice(0, 200)}`,
    bug: imp8.status >= 500 ? 'YES' : 'INVESTIGATE',
  });

  // ---------- T9: special chars (path-traversal / XSS flavored) ----------
  const specialName = '../../etc/passwd<script>alert(1)</script>';
  const pack9 = clonePack(seedPack, { Test_Id: `${RUN}_T9`, Test_Name: specialName });
  const imp9 = await importPack(token, pack9);
  record({
    name: 'T9 import with path-traversal/XSS Test_Name',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { Test_Id: `${RUN}_T9`, Test_Name: specialName } },
    response: { status: imp9.status, body: imp9.body, durationMs: imp9.durationMs },
    ok: imp9.status === 400 || (imp9.status >= 200 && imp9.status < 300),
    expected: 'either accept verbatim (it is a label, not a path) or 400 with explicit char rules. 5xx = crash. If accepted, GET response must NOT render unescaped HTML.',
    observation: `${imp9.status}: ${JSON.stringify(imp9.body).slice(0, 200)}`,
    bug: imp9.status >= 500 ? 'YES' : 'INVESTIGATE',
  });

  // ---------- T10: unicode ----------
  const unicodeName = '测试用例-🚀-αβγ';
  const pack10 = clonePack(seedPack, { Test_Id: `${RUN}_T10`, Test_Name: unicodeName });
  const imp10 = await importPack(token, pack10);
  record({
    name: 'T10 import with unicode Test_Name',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { Test_Id: `${RUN}_T10`, Test_Name: unicodeName } },
    response: { status: imp10.status, body: imp10.body, durationMs: imp10.durationMs },
    ok: imp10.status >= 200 && imp10.status < 300,
    expected: '200 with name preserved verbatim (UTF-8 clean)',
    observation: `${imp10.status}: ${JSON.stringify(imp10.body).slice(0, 200)}`,
    bug: imp10.status >= 500 ? 'YES' : 'INVESTIGATE',
  });
  const landed10 = imp10.landedIds[0];
  if (landed10) {
    const exp10 = await exportTc(token, [landed10]);
    const back = (exp10.body as any)?.test_case_details?.[0];
    record({
      name: 'T10b unicode Test_Name preserved on round-trip (export back)',
      category: 'edge-name',
      request: { method: 'POST', url: `${base}/testcases/export`, body: { testCaseIds: [landed10] } },
      response: exp10,
      ok: back?.Test_Name === unicodeName,
      expected: `Test_Name on export must equal "${unicodeName}" exactly`,
      observation: `Test_Name="${back?.Test_Name}"`,
      bug: back?.Test_Name === unicodeName ? 'NO' : 'YES',
    });
  }

  // ---------- T11: mutate a value, upload, verify ----------
  let mutPath = '(none)';
  let mutOld: any = null;
  let mutNew: any = null;
  const mutated = JSON.parse(JSON.stringify(seedPack));
  const md = mutated.test_case_details[0];
  const tcio = md.Test_Config_Intermediate_Object;
  if (tcio?.cellConfig?.master?.label !== undefined) {
    mutPath = 'Test_Config_Intermediate_Object.cellConfig.master.label';
    mutOld = tcio.cellConfig.master.label;
    mutNew = `qa-mut-${Date.now()}`;
    tcio.cellConfig.master.label = mutNew;
  } else if (tcio?.subsConfig?.subs?.[0]?.tac !== undefined) {
    mutPath = 'Test_Config_Intermediate_Object.subsConfig.subs[0].tac';
    mutOld = tcio.subsConfig.subs[0].tac;
    mutNew = (typeof mutOld === 'number' ? mutOld + 7 : `${mutOld}-mut`);
    tcio.subsConfig.subs[0].tac = mutNew;
  }
  md.Test_Id = `${RUN}_T11`;
  md.Test_Name = `${RUN}_T11_mutated`;
  delete md.Created_Date; delete md.Modified_Date; delete md.Deleted_Date;
  const imp11 = await importPack(token, mutated);
  const landed11 = imp11.landedIds[0];
  let backVal: any = '(unset)';
  if (landed11) {
    const exp11 = await exportTc(token, [landed11]);
    const tcio2 = (exp11.body as any)?.test_case_details?.[0]?.Test_Config_Intermediate_Object;
    if (mutPath === 'Test_Config_Intermediate_Object.cellConfig.master.label') backVal = tcio2?.cellConfig?.master?.label;
    else if (mutPath === 'Test_Config_Intermediate_Object.subsConfig.subs[0].tac') backVal = tcio2?.subsConfig?.subs?.[0]?.tac;
  }
  record({
    name: `T11 mutate ${mutPath} -> import -> verify`,
    category: 'mutation',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { mutation: { path: mutPath, old: mutOld, new: mutNew } } },
    response: { status: imp11.status, body: imp11.body, durationMs: imp11.durationMs },
    ok: backVal === mutNew,
    expected: `after import + re-export, ${mutPath} === ${JSON.stringify(mutNew)} (user-supplied tdef accepted, value persists)`,
    observation: `import=${imp11.status} landed=${landed11 ?? 'none'} back=${JSON.stringify(backVal)}`,
    bug: backVal === mutNew ? 'NO' : 'INVESTIGATE',
  });

  // ---------- T12: same Test_Id imported twice in a row ----------
  const id12 = `${RUN}_T12_dup`;
  const pack12a = clonePack(seedPack, { Test_Id: id12, Test_Name: `${id12}_first` });
  const imp12a = await importPack(token, pack12a);
  const pack12b = clonePack(seedPack, { Test_Id: id12, Test_Name: `${id12}_second` });
  const imp12b = await importPack(token, pack12b);
  record({
    name: 'T12 import same Test_Id twice in a row',
    category: 'collision',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { Test_Id: id12, twiceInARow: true } },
    response: { status: imp12b.status, body: imp12b.body, durationMs: imp12b.durationMs },
    ok: imp12a.status >= 200 && imp12a.status < 300 && (imp12b.status === 409 || imp12b.status === 400),
    expected: 'first import 200; second 409 CONFLICT (Test_Id already exists)',
    observation: `first=${imp12a.status}, second=${imp12b.status}: ${JSON.stringify(imp12b.body).slice(0, 160)}`,
    bug: imp12b.status >= 500 ? 'YES' : (imp12b.status >= 200 && imp12b.status < 300 ? 'INVESTIGATE' : 'NO'),
  });

  // ---------- T13: omit Test_Name ----------
  const pack13 = clonePack(seedPack, { Test_Id: `${RUN}_T13` }, ['Test_Name']);
  const imp13 = await importPack(token, pack13);
  record({
    name: 'T13 import without Test_Name field',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { Test_Id: `${RUN}_T13` } },
    response: { status: imp13.status, body: imp13.body, durationMs: imp13.durationMs },
    ok: imp13.status === 400,
    expected: '400 BAD_REQUEST: Test_Name is required',
    observation: `${imp13.status}: ${JSON.stringify(imp13.body).slice(0, 200)}`,
    bug: imp13.status >= 500 ? 'YES' : (imp13.status >= 200 && imp13.status < 300 ? 'INVESTIGATE' : 'NO'),
  });

  // ---------- T14: omit Test_Id ----------
  const pack14 = clonePack(seedPack, { Test_Name: `${RUN}_T14_no_id` }, ['Test_Id']);
  const imp14 = await importPack(token, pack14);
  record({
    name: 'T14 import without Test_Id field',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { Test_Name: `${RUN}_T14_no_id` } },
    response: { status: imp14.status, body: imp14.body, durationMs: imp14.durationMs },
    ok: imp14.status === 400 || (imp14.status >= 200 && imp14.status < 300),
    expected: 'either 400 (Test_Id required) or 200 (server auto-generates id) — needs documenting either way',
    observation: `${imp14.status}: ${JSON.stringify(imp14.body).slice(0, 200)}`,
    bug: imp14.status >= 500 ? 'YES' : 'INVESTIGATE',
  });

  // ---------- T15: omit both ----------
  const pack15 = clonePack(seedPack, {}, ['Test_Id', 'Test_Name']);
  const imp15 = await importPack(token, pack15);
  record({
    name: 'T15 import without Test_Id AND Test_Name',
    category: 'edge-name',
    request: { method: 'POST', url: `${base}/testcases/import`, body: { both_omitted: true } },
    response: { status: imp15.status, body: imp15.body, durationMs: imp15.durationMs },
    ok: imp15.status === 400,
    expected: '400 BAD_REQUEST: at least one of Test_Id / Test_Name must be present',
    observation: `${imp15.status}: ${JSON.stringify(imp15.body).slice(0, 200)}`,
    bug: imp15.status >= 500 ? 'YES' : (imp15.status >= 200 && imp15.status < 300 ? 'YES' : 'NO'),
  });

  // ---------- Final list ----------
  const list3 = await call('GET', `${base}/testcases?limit=500&offset=0`, { token });
  const items3: any[] = (list3.body as any)?.items ?? [];

  const leakedIds: string[] = [
    landed1, imp4.landedIds[0], imp6.landedIds[0], imp7.landedIds[0], imp8.landedIds[0], imp9.landedIds[0], landed10, landed11,
    imp12a.landedIds[0], imp12b.landedIds[0], imp13.landedIds[0], imp14.landedIds[0], imp15.landedIds[0],
  ].filter(Boolean) as string[];
  console.log(`\n--- list count before=${initialCount}, after=${items3.length}`);
  console.log(`--- LEAKED ids (DELETE broken, manual cleanup):`);
  for (const id of leakedIds) console.log(`     ${id}`);

  const summary = {
    runId: RUN, host: HOST, seedId, seedName,
    initialCount, finalCount: items3.length, leakedIds,
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
  console.log(`\n--- ${summary.counts.pass}/${summary.counts.total} pass, ${summary.counts.fail} fail (${summary.counts.bugs} bugs, ${summary.counts.investigate} investigate)`);
  console.log(`--- evidence: ${OUT}\n`);

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

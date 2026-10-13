// Is the deployed SimQA actually running the code in HEAD?
//
// Checks a behaviour marker per feature rather than a version string, because
// a version string can be stale while the code is not -- and the other way
// round. Read-only: nothing here starts an execution.
//
//   npx tsx scripts/probe-deployed-features.ts [baseUrl]
const BASE = process.argv[2] ?? 'http://192.168.1.36:4100';

const get = async (path: string) => {
  const r = await fetch(BASE + path, { cache: 'no-store' as RequestCache });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

const say = (name: string, ok: boolean, detail: string) =>
  console.log(`  ${ok ? 'LIVE ' : 'MISSING'}  ${name.padEnd(42)} ${detail}`);

console.log(`${BASE}\n`);

// 1 -- licence remembered per suite and per callbox
{
  const { body } = await get('/api/automation/suites/suite-muv1v6k6-4c/licences');
  const ok = !!body?.ok && 'callboxHost' in body && 'saved' in body;
  say('licence: remembered per callbox', ok,
    ok ? `callboxHost=${body.callboxHost} saved=${JSON.stringify(body.saved)}` : JSON.stringify(body).slice(0, 120));
}

// 2 -- the licence-tag writer for the saved copies
{
  const r = await fetch(BASE + '/api/automation/suites/suite-muv1v6k6-4c/files', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const b: any = await r.json().catch(() => null);
  const ok = r.status === 400 && /row and file are required/.test(String(b?.error));
  say('licence: writer for saved configs', ok, ok ? 'POST .../files validates its input' : `HTTP ${r.status} ${JSON.stringify(b).slice(0, 90)}`);
}

// 3 -- radio-card pre-flight, reported when a test case is picked
{
  const { body } = await get('/api/automation/uesim-testcases/power-on'
    + '?systemId=sys-5&boxUserId=bu-akefumo&id=01a1207d-1947-7a4c-98ef-f5ea8ef61d80');
  const ok = !!body?.ok && 'cardFit' in body && 'cells' in body;
  say('rf cards: pre-flight on pick', ok,
    ok ? `${body.cells} cells, cards ${JSON.stringify(body.cards)}, fits=${body.cardFit?.ok}` : JSON.stringify(body).slice(0, 120));
}

// 4 -- History: one row per test case, and no bookkeeping among them
{
  const { body } = await get('/api/automation/history?limit=8');
  const runs: any[] = body?.runs ?? [];
  const perTestcase = runs.some((r) => Array.isArray(r.rows) && r.rows.length > 0);
  const notes = runs.flatMap((r) => r.rows ?? []).filter((x: any) => x.name === 'licence-restore');
  say('history: a row per test case', !!body?.ok && perTestcase,
    `${runs.length} runs, ${runs.reduce((t, r) => t + (r.rows?.length ?? 0), 0)} test-case rows`);
  say('history: bookkeeping kept out', notes.length === 0,
    notes.length === 0 ? 'no licence-restore rows' : `${notes.length} phantom rows`);
  // 5 -- requested rows, so a row that never got its turn still shows
  const withNotExec = runs.find((r) => (r.rows ?? []).some((x: any) => x.status === 'Not Executed'));
  say('history: rows that never ran', !!withNotExec,
    withNotExec ? `e.g. ${withNotExec.suiteName}: ${(withNotExec.rows ?? []).filter((x: any) => x.status === 'Not Executed').length} Not Executed` : 'none in this window');
}

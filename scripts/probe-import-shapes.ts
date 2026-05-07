// Probe what the import endpoint accepts. Try several payload shapes to find
// the one the server actually wants. Then verify by GETting the result.

const HOST = process.env.UESIM_HOST ?? '192.168.1.95';
const USER = process.env.UESIM_USER ?? 'admin';
const PASS = process.env.UESIM_PASS ?? 'admin';
const RUN = `qa-shape-${Date.now().toString(36)}`;
const base = `http://${HOST}/v2`;

async function login(): Promise<string> {
  const r = await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const j: any = await r.json();
  return j.access_token as string;
}

async function tryImport(token: string, label: string, payload: any) {
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const form = new FormData();
  form.append('file', blob, 'pack.json');
  const t0 = Date.now();
  const res = await fetch(`${base}/testcases/import`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const ms = Date.now() - t0;
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  console.log(`\n[${label}] status=${res.status} (${ms}ms)`);
  console.log(`  payload-keys: ${Array.isArray(payload) ? '<array>' : Object.keys(payload).join(',')}`);
  console.log(`  body: ${JSON.stringify(body).slice(0, 400)}`);
  return { status: res.status, body };
}

async function tryExport(token: string, ids: string[]) {
  const r = await fetch(`${base}/testcases/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ testCaseIds: ids, output: { type: 'json' } }),
  });
  const ct = r.headers.get('content-type') ?? '';
  const text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  console.log(`\n[EXPORT ${ids.length} ids] status=${r.status}  content-type=${ct}`);
  console.log(`  body-shape: ${typeof body === 'string' ? 'string' : Array.isArray(body) ? `array len=${body.length}` : Object.keys(body).join(',')}`);
  if (typeof body === 'object' && !Array.isArray(body)) {
    for (const k of Object.keys(body)) console.log(`     .${k}: ${typeof body[k]}${Array.isArray(body[k]) ? ` (len=${body[k].length})` : ''}`);
  }
  if (Array.isArray(body) && body.length > 0) {
    console.log(`  first-item keys: ${Object.keys(body[0]).join(',')}`);
  }
  return body;
}

async function main() {
  const token = await login();
  console.log(`token ok\nrun=${RUN}`);

  // 1. Get a real seed
  const list = await fetch(`${base}/testcases?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
  const lj: any = await list.json();
  const seedId = lj.items[0].id;
  const seedName = lj.items[0].name;
  console.log(`seed: id=${seedId} name=${seedName}`);

  // 2. Get the full record
  const seedR = await fetch(`${base}/testcases/${encodeURIComponent(seedId)}`, { headers: { Authorization: `Bearer ${token}` } });
  const seed: any = await seedR.json();
  console.log(`seed record top-level keys: ${Object.keys(seed).join(',')}`);

  // 3. Export 1 id, see what shape comes back
  const exp1 = await tryExport(token, [seedId]);

  // 4. Try the various import shapes
  const td = seed.testDefinition;

  await tryImport(token, 'A: bare {id, name, testDefinition}', {
    id: `${RUN}_A`, name: `${RUN}_A`, testDefinition: td,
  });

  await tryImport(token, 'B: array of {id, name, testDefinition}', [
    { id: `${RUN}_B`, name: `${RUN}_B`, testDefinition: td },
  ]);

  await tryImport(token, 'C: { testCases: [...] }', {
    testCases: [{ id: `${RUN}_C`, name: `${RUN}_C`, testDefinition: td }],
  });

  await tryImport(token, 'D: { items: [...] }', {
    items: [{ id: `${RUN}_D`, name: `${RUN}_D`, testDefinition: td }],
  });

  // E: pass through what /export gave us, but rename id+name in any items
  if (Array.isArray(exp1)) {
    const cloned = JSON.parse(JSON.stringify(exp1));
    if (cloned[0]) {
      cloned[0].id = `${RUN}_E`;
      cloned[0].name = `${RUN}_E`;
      if (cloned[0].Test_Id) cloned[0].Test_Id = `${RUN}_E`;
      if (cloned[0].Test_Name) cloned[0].Test_Name = `${RUN}_E`;
    }
    await tryImport(token, 'E: replay export array verbatim with renamed first item', cloned);
  } else if (exp1 && typeof exp1 === 'object') {
    // maybe it's { testCases: [...] } shape; try it
    const cloned = JSON.parse(JSON.stringify(exp1));
    if (Array.isArray(cloned.testCases) && cloned.testCases[0]) {
      cloned.testCases[0].id = `${RUN}_E`;
      cloned.testCases[0].name = `${RUN}_E`;
    }
    await tryImport(token, 'E: replay export object verbatim with renamed', cloned);
  }

  // F: maybe the seed full-record itself works as a pack
  const fPack = { ...seed, id: `${RUN}_F`, name: `${RUN}_F` };
  delete (fPack as any).metadata;
  await tryImport(token, 'F: full seed record with renamed id', fPack);

  // G: maybe key names are different (Test_Id, Test_Name, TestDefinition)
  await tryImport(token, 'G: PascalCase keys', {
    Test_Id: `${RUN}_G`, Test_Name: `${RUN}_G`, TestDefinition: td,
  });

  // H: array with PascalCase
  await tryImport(token, 'H: array of PascalCase', [
    { Test_Id: `${RUN}_H`, Test_Name: `${RUN}_H`, TestDefinition: td },
  ]);

  // I: testcases (plural lowercase)
  await tryImport(token, 'I: { testcases: [...] } lowercase plural', {
    testcases: [{ id: `${RUN}_I`, name: `${RUN}_I`, testDefinition: td }],
  });

  console.log('\n--- done. Look for any non-400 response above. ---');
}

main().catch((e) => { console.error(e); process.exit(1); });

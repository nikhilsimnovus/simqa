// Confirm: can the empty-name testcase be retrieved via GET? Does it appear in
// the list? Is the empty-id (T14) also a ghost?

const HOST = process.env.UESIM_HOST ?? '192.168.1.95';
const USER = process.env.UESIM_USER ?? 'admin';
const PASS = process.env.UESIM_PASS ?? 'admin';
const base = `http://${HOST}/v2`;

async function main() {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const token = (await r.json() as any).access_token;
  const auth = { Authorization: `Bearer ${token}` };

  const probes = [
    'qart2-mos1lv5d_T6',  // empty name
    'qart2-mos1lv5d_T7',  // whitespace name
    'qart2-mos1lv5d_T9',  // XSS name
  ];

  for (const id of probes) {
    const g = await fetch(`${base}/testcases/${encodeURIComponent(id)}`, { headers: auth });
    const j: any = await g.json().catch(() => null);
    console.log(`GET /testcases/${id}  ->  ${g.status}  name=${JSON.stringify(j?.name)}`);
  }

  // Find them in the full list
  const list = await fetch(`${base}/testcases?limit=500&offset=0`, { headers: auth });
  const items: any[] = (await list.json() as any).items ?? [];
  console.log(`\ntotal in list = ${items.length}`);
  for (const id of probes) {
    const e = items.find((x) => x.id === id);
    console.log(`  list-contains ${id}: ${e ? `YES name=${JSON.stringify(e.name)}` : 'NO'}`);
  }

  // Empty-id testcase from T14
  const t14 = items.filter((x) => x.id === '' || x.name === 'qart2-mos1lv5d_T14_no_id');
  console.log(`\nT14 (empty-id) candidates in list: ${t14.length}`);
  for (const e of t14) console.log(`  id=${JSON.stringify(e.id)} name=${JSON.stringify(e.name)}`);

  // Search for the empty-name testcase
  const search = await fetch(`${base}/testcases/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ pageNumber: 1, pageSize: 100, filters: { name: '' } }),
  });
  console.log(`\nsearch name="" -> ${search.status}`);
  const sj: any = await search.json();
  console.log(`  results: ${sj?.items?.length ?? sj?.testCases?.length ?? '?'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

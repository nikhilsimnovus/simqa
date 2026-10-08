// Probe: how does the box page and order GET /testcases, and does it agree
// with what the Simnovator's own UI shows?
//   node probe-testcase-order.mjs <host> <user> <pass>
const HOST = process.argv[2] ?? '192.168.1.95';
const USER = process.argv[3] ?? process.env.BOX_USER;
const PASS = process.argv[4] ?? process.env.BOX_PASS;
if (!USER || !PASS) {
  console.error('usage: node probe-testcase-order.mjs <host> <user> <pass>  (or BOX_USER / BOX_PASS)');
  process.exit(2);
}
const base = `http://${HOST}/v2`;

const login = await fetch(`${base}/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
}).then(r => r.json());
if (!login.access_token) { console.error('login failed:', JSON.stringify(login).slice(0, 200)); process.exit(1); }
const H = { Authorization: `Bearer ${login.access_token}` };

const get = async (qs) => {
  const r = await fetch(`${base}/testcases${qs}`, { headers: H });
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, total: j.total, n: (j.items ?? []).length, items: j.items ?? [], raw: text.slice(0, 160) };
};

const show = (label, r) => {
  console.log(`${label.padEnd(42)} http=${r.status} total=${r.total ?? '—'} rows=${r.n}`);
  for (const t of r.items.slice(0, 5)) {
    const m = t.metadata ?? {};
    console.log(`     ${String(t.id).slice(0, 10).padEnd(12)} ${String(t.name).slice(0, 28).padEnd(30)} created=${m.createdOn ?? '—'}`);
  }
};

console.log(`\n== ${HOST} as ${USER} ==\n`);
show('?limit=5&offset=0        (SimQA today)', await get('?limit=5&offset=0'));
show('?pageSize=5&pageNumber=1 (documented)', await get('?pageSize=5&pageNumber=1'));
show('?pageSize=5&pageNumber=2 (documented)', await get('?pageSize=5&pageNumber=2'));
show('(no parameters at all)', await get(''));

// Is limit/offset honoured at all, or silently ignored?
const a = await get('?limit=3&offset=0');
const b = await get('?pageSize=3&pageNumber=1');
console.log(`\nlimit=3 returned ${a.n} row(s); pageSize=3 returned ${b.n} row(s)`);

// What does search offer, and in what order?
const search = await fetch(`${base}/testcases/search`, {
  method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ pageNumber: 1, pageSize: 5 }),
}).then(async r => ({ status: r.status, body: await r.text() }));
console.log(`\nPOST /testcases/search (no sort) http=${search.status}`);
try {
  const j = JSON.parse(search.body);
  for (const t of (j.items ?? j.testCases ?? []).slice(0, 5)) {
    console.log(`     ${String(t.id).slice(0, 10).padEnd(12)} ${String(t.name).slice(0, 28).padEnd(30)} created=${(t.metadata ?? {}).createdOn ?? '—'}`);
  }
} catch { console.log('   ', search.body.slice(0, 200)); }

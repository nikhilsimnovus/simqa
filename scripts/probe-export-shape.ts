// Get a clear view of the export response shape so we know what import wants.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const HOST = process.env.UESIM_HOST ?? '192.168.1.95';
const USER = process.env.UESIM_USER ?? 'admin';
const PASS = process.env.UESIM_PASS ?? 'admin';
const base = `http://${HOST}/v2`;
const OUT = resolve(process.cwd(), `scripts/.out/export-shape-${Date.now().toString(36)}.json`);

async function main() {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const token = (await r.json() as any).access_token;

  const list = await fetch(`${base}/testcases?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
  const seedId = (await list.json() as any).items[0].id;

  const exp = await fetch(`${base}/testcases/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ testCaseIds: [seedId], output: { type: 'json' } }),
  });
  const body: any = await exp.json();

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(body, null, 2));
  console.log(`status=${exp.status}`);
  console.log(`top-level keys: ${Object.keys(body).join(',')}`);

  // Walk the structure
  function describe(v: any, path: string, depth = 0) {
    if (depth > 4) return;
    if (v === null || v === undefined) { console.log(`${path}: ${v}`); return; }
    if (Array.isArray(v)) {
      console.log(`${path}: array len=${v.length}`);
      if (v.length > 0) describe(v[0], `${path}[0]`, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      console.log(`${path}: { ${keys.join(', ')} }`);
      for (const k of keys) {
        const child = v[k];
        if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
          console.log(`${path}.${k}: ${typeof child} = ${JSON.stringify(child).slice(0, 60)}`);
        } else {
          describe(child, `${path}.${k}`, depth + 1);
        }
      }
      return;
    }
    console.log(`${path}: ${typeof v} = ${JSON.stringify(v).slice(0, 60)}`);
  }

  describe(body, 'export');
  console.log(`\nfull export body written to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

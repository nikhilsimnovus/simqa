// Confirm the log_filename derivation: does the server build it from
// Test_Name without sanitizing path components? If yes -> filesystem attack
// surface.

const HOST = process.env.UESIM_HOST ?? '192.168.1.95';
const USER = process.env.UESIM_USER ?? 'admin';
const PASS = process.env.UESIM_PASS ?? 'admin';
const base = `http://${HOST}/v2`;

async function main() {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const token = (await r.json() as any).access_token;

  // Re-export the testcases we just created with weird names
  const ids = [
    'qart2-mos1lv5d_T6',  // empty name
    'qart2-mos1lv5d_T7',  // whitespace
    'qart2-mos1lv5d_T9',  // path traversal + XSS
    'qart2-mos1lv5d_T10', // unicode
    'qart2-mos1lv5d_T1',  // vanilla rename
  ];

  for (const id of ids) {
    const exp = await fetch(`${base}/testcases/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ testCaseIds: [id], output: { type: 'json' } }),
    });
    const body: any = await exp.json();
    const detail = body?.test_case_details?.[0];
    if (!detail) {
      console.log(`${id}: NOT FOUND on export`);
      continue;
    }
    const cf = detail.Config_File?.config ?? {};
    console.log(`\n=== id=${id} ===`);
    console.log(`Test_Name = ${JSON.stringify(detail.Test_Name)}`);
    console.log(`Config_File.config.log_filename = ${JSON.stringify(cf.log_filename)}`);
    console.log(`Config_File.config.com_addr     = ${JSON.stringify(cf.com_addr)}`);
    // Check if any other path-shaped field uses the name
    for (const [k, v] of Object.entries(cf)) {
      if (typeof v === 'string' && (v.includes(detail.Test_Name) || v.includes('/tmp'))) {
        if (k !== 'log_filename') console.log(`  potentially-derived field .${k} = ${JSON.stringify(v).slice(0, 120)}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

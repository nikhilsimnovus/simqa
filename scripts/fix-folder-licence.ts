// Put a licence tag back into the saved copies in /root/automation_configs.
//
// Needed once, to repair what a verification run contaminated before
// syncRowToServer learned to keep the folder's own licence: one run of
// User_Plane with ENB oran-enb left all ten rows' saved enb.cfg asking for
// oran-enb, nine of which had said rnd-enb.
//
// Only the quoted tag changes -- every other byte is left exactly as it is.
// Prints what it would do unless --write is passed.
//
//   npx tsx scripts/fix-folder-licence.ts <suiteId> <file> <tag> [--write]
const [, , suiteId, file, tag, write] = process.argv;
const BASE = process.env.SIMQA_BASE ?? 'http://192.168.1.36:4100';

const { licenceTagOf } = await import('../src/lib/automation/licenceTag');

const suite: any = await fetch(`${BASE}/api/automation/suites/${suiteId}`).then(r => r.json());
const rows: any[] = (suite.suite ?? suite).items ?? [];
console.log(`${(suite.suite ?? suite).name}: ${rows.length} rows, fixing ${file} -> "${tag}"`
  + (write === '--write' ? '' : '  (dry run — pass --write to apply)'));

for (const row of rows) {
  const got: any = await fetch(
    `${BASE}/api/automation/suites/${suiteId}/files?row=${encodeURIComponent(row.name)}&file=${encodeURIComponent(file)}`,
  ).then(r => r.json());
  if (!got?.ok || typeof got.text !== 'string') { console.log(`  ${row.name.slice(0, 44).padEnd(46)} no ${file}`); continue; }
  const now = licenceTagOf(got.text);
  if (now === tag) { console.log(`  ${row.name.slice(0, 44).padEnd(46)} already "${tag}"`); continue; }
  if (write !== '--write') {
    console.log(`  ${row.name.slice(0, 44).padEnd(46)} "${now}" -> "${tag}"`);
    continue;
  }
  const r: any = await fetch(`${BASE}/api/automation/suites/${suiteId}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ row: row.name, file, tag }),
  }).then(x => x.json()).catch((e) => ({ ok: false, error: String(e.message) }));
  console.log(`  ${row.name.slice(0, 44).padEnd(46)} "${now}" -> "${tag}"  ${r?.ok ? 'written' : 'FAILED ' + (r?.error ?? '?')}`);
}

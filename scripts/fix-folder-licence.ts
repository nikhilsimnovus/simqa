// Put a licence tag back into the saved copies in /root/automation_configs.
//
// Needed once, to repair what a verification run contaminated before
// syncRowToServer learned to keep the folder's own licence: a run of
// User_Plane with ENB oran-enb / MME oru-mme left the saved enb.cfg, mme.cfg
// and ims.cfg of rows that had never asked for those licences asking for them.
//
// Only the quoted tag changes -- every other byte is left exactly as it is,
// because POST .../files applies withLicenceTag and nothing else.
//
// `--from=<tag>` restricts the repair to rows whose saved config currently
// asks for that tag, so rows that were never contaminated are left alone.
// Without `--write` it only says what it would do.
//
//   npx tsx scripts/fix-folder-licence.ts <suiteId> <file> <tag> [--from=<tag>] [--write]
import { licenceTagOf } from '../src/lib/automation/licenceTag';

const [, , suiteId, file, tag, ...rest] = process.argv;
const write = rest.includes('--write');
const fromArg = rest.find((a) => a.startsWith('--from='));
const only = fromArg ? fromArg.slice('--from='.length) : undefined;
const BASE = process.env.SIMQA_BASE ?? 'http://192.168.1.36:4100';

const suiteRes: any = await fetch(`${BASE}/api/automation/suites/${suiteId}`).then((r) => r.json());
const suite = suiteRes.suite ?? suiteRes;
const rows: any[] = suite.items ?? [];

console.log(`${suite.name}: ${rows.length} rows, ${file} -> "${tag}"`
  + (only !== undefined ? `, only rows currently "${only}"` : '')
  + (write ? '' : '   (dry run — pass --write to apply)'));

for (const row of rows) {
  const label = String(row.name).slice(0, 44).padEnd(46);
  const got: any = await fetch(
    `${BASE}/api/automation/suites/${suiteId}/files`
    + `?row=${encodeURIComponent(row.name)}&file=${encodeURIComponent(file)}`,
  ).then((r) => r.json()).catch(() => null);

  if (!got?.ok || typeof got.text !== 'string') { console.log(`  ${label} no ${file} saved`); continue; }

  const now = licenceTagOf(got.text);
  if (now === tag) { console.log(`  ${label} already "${tag}"`); continue; }
  if (only !== undefined && now !== only) { console.log(`  ${label} left alone ("${now}")`); continue; }
  if (!write) { console.log(`  ${label} "${now}" -> "${tag}"`); continue; }

  const r: any = await fetch(`${BASE}/api/automation/suites/${suiteId}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ row: row.name, file, tag }),
  }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));

  console.log(`  ${label} "${now}" -> "${tag}"  ${r?.ok ? 'written' : 'FAILED ' + (r?.error ?? '?')}`);
}

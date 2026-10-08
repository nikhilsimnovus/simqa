// Does the validator accept the configs the lab is ACTUALLY running?
//
// A validator that rejects a file which is live on a callbox right now is worse
// than no validator, so this runs every file scripts/probe-callbox-cfg-shapes.ts
// pulled through validateCfg in its own role, and then in a wrong role to check
// the mismatch detection fires.
//
//   npx tsx scripts/probe-cfg-validate.ts <dirOfPulledFiles>
import * as fs from 'fs';
import * as path from 'path';
import { validateCfg, withDbInclude, type CfgRole } from '../src/lib/cfgValidate';

const dir = process.argv[2];
const roleOf = (f: string): CfgRole | undefined => {
  if (/\.ots\.cfg$/.test(f)) return 'ots';
  if (/\.(db|include)\./.test(f)) return 'db';
  if (/\.mme\.cfg$/.test(f)) return 'mme';
  if (/\.ims\.cfg$/.test(f)) return 'ims';
  if (/\.gnb\.cfg$/.test(f)) return 'gnb';
  if (/\.enb\.cfg$/.test(f)) return 'enb';
  return undefined;
};

let pass = 0, fail = 0;
for (const f of fs.readdirSync(dir).sort()) {
  const role = roleOf(f);
  if (!role) continue;
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const v = validateCfg(role, f, text);
  const warn = v.issues.filter((i) => i.severity === 'warning');
  console.log(`${v.ok ? 'OK  ' : 'FAIL'} ${role.padEnd(5)} ${f.padEnd(50)} ${v.ok ? '' : '<<<'}`);
  for (const i of v.issues) {
    console.log(`        ${i.severity === 'error' ? 'E' : 'w'} ${i.line ? 'L' + i.line + ' ' : ''}${i.message}`);
  }
  if (v.includes.length) console.log(`        includes: ${v.includes.join(', ')}`);
  if (Object.keys(v.facts).length) console.log(`        facts: ${JSON.stringify(v.facts).slice(0, 160)}`);
  void warn;
  if (v.ok) pass++; else fail++;
}
console.log(`\nreal files: ${pass} accepted, ${fail} REJECTED`);

// Cross-role: each file in a role it is not.
console.log('\n--- wrong-slot detection ---');
const cases: Array<[string, CfgRole]> = [
  ['192.168.1.107.ims.cfg', 'mme'],
  ['192.168.1.107.mme.cfg', 'ims'],
  ['192.168.1.107.enb.cfg', 'mme'],
  ['192.168.1.107.ots.cfg', 'mme'],
  ['192.168.1.106.db.ue_db-ims-slice-single.cfg', 'mme'],
  ['192.168.1.107.mme.cfg', 'db'],
];
for (const [f, role] of cases) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) { console.log(`(missing ${f})`); continue; }
  const v = validateCfg(role, f, fs.readFileSync(p, 'utf8'));
  console.log(`${v.ok ? 'NOT CAUGHT' : 'caught    '} ${f} as ${role}: ${v.issues[0]?.message ?? '(no issue)'}`);
}

// Rewriting the DB include on the REAL mme configs: the result must still be a
// valid mme config, and must include exactly the database asked for.
console.log('\n--- db include rewrite on real mme configs ---');
for (const f of fs.readdirSync(dir).filter((n) => /\.mme\.cfg$/.test(n))) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const before = validateCfg('mme', f, src);
  const r = withDbInclude(src, 'chosen-ue_db.cfg');
  const after = validateCfg('mme', f, r.text);
  console.log(`${f}`);
  console.log(`   before: ok=${before.ok} includes=[${before.includes.join(', ')}]`);
  console.log(`   after : ok=${after.ok} includes=[${after.includes.join(', ')}] changed=${r.changed} replaced=[${r.replaced.join(', ')}]`);
  if (!after.ok) for (const i of after.issues) console.log(`      ${i.severity} ${i.message}`);
}

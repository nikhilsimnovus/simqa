// What licence do the callbox's live configs actually ask for right now?
//
// Reads the three files the stack loads -- /root/enb/config/enb.cfg and
// /root/mme/config/{mme,ims}.cfg, following their symlinks -- and reports each
// one's tag, plus whether a *.simqa-licence-backup is sitting beside it.
//
// A backup still present after a run means the licence was NOT put back, which
// is the leak this is here to catch.
//
//   npx tsx scripts/probe-callbox-licences.ts <systemId>
import { loadInventory } from '../src/lib/inventory';
import { readCommand } from '../src/lib/configFidelity/ssh';
import { licenceTagOf } from '../src/lib/automation/licenceTag';

const [, , id] = process.argv;
const sys: any = (loadInventory().systems ?? []).find((s: any) => s.id === id);
if (!sys) { console.error(`no system "${id}"`); process.exit(1); }
console.log(`callbox ${sys.host}`);

for (const [dir, link] of [
  ['/root/enb/config', 'enb.cfg'],
  ['/root/mme/config', 'mme.cfg'],
  ['/root/mme/config', 'ims.cfg'],
] as const) {
  const target = (await readCommand(sys, `cd ${dir} && readlink ${link} 2>/dev/null || echo "(not a link)"`)).trim();
  const text = await readCommand(sys, `sudo -n cat ${dir}/${link} 2>/dev/null || cat ${dir}/${link}`);
  const tag = licenceTagOf(text);
  console.log(`  ${link.padEnd(8)} -> ${target.padEnd(28)} tag=${tag === undefined ? '(no licence_server)' : JSON.stringify(tag)}`);
}

const left = (await readCommand(sys,
  'ls -1 /root/enb/config/*.simqa-licence-backup /root/mme/config/*.simqa-licence-backup 2>/dev/null || true')).trim();
console.log(left ? '\n  licence backups still on the box:\n' + left.split('\n').map(l => '    ' + l).join('\n')
                 : '\n  no licence backups left behind');

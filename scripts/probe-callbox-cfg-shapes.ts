// Probe: what do the callbox config files ACTUALLY look like?
//
// Pulls one of each role (enb/gnb, mme, ims, the subscriber DB an mme includes,
// and ots) off every callbox in inventory and writes them to a scratch dir, so
// the cfg validator is written against real files rather than the templates in
// src/lib/cfgTemplates.
//
//   npx tsx scripts/probe-callbox-cfg-shapes.ts <outDir>
import * as fs from 'fs';
import * as path from 'path';
import { loadInventory } from '../src/lib/inventory';
import { readCommand, readRemoteFile } from '../src/lib/configFidelity/ssh';

const out = process.argv[2] ?? 'cfg-probe';
fs.mkdirSync(out, { recursive: true });

const inv = loadInventory();
const boxes = inv.systems.filter((s) => s.type === 'CALLBOX');
console.log('callboxes:', boxes.map((b) => `${b.id} ${b.host}`).join(', '));

for (const box of boxes) {
  console.log(`\n===== ${box.host} =====`);
  try {
    for (const dir of ['/root/enb/config', '/root/mme/config', '/root/ots/config']) {
      const ls = await readCommand(box, `sudo -n ls -la ${dir} 2>/dev/null || ls -la ${dir} 2>/dev/null || true`);
      fs.writeFileSync(path.join(out, `${box.host}.ls.${dir.split('/')[2]}.txt`), ls);
      console.log(`${dir}: ${ls.split('\n').filter(Boolean).length} entries`);
    }
    // What is linked right now — those are files known to work.
    const links = await readCommand(box,
      `for p in /root/enb/config/enb.cfg /root/enb/config/gnb.cfg /root/mme/config/mme.cfg /root/mme/config/ims.cfg /root/ots/config/ots.cfg; do `
      + `echo -n "$p -> "; (sudo -n readlink "$p" 2>/dev/null || readlink "$p" 2>/dev/null || echo "(plain file)"); done`);
    console.log(links.trim());
    fs.writeFileSync(path.join(out, `${box.host}.links.txt`), links);

    const grab = async (remote: string, label: string) => {
      const body = await readCommand(box, `sudo -n cat ${remote} 2>/dev/null || cat ${remote} 2>/dev/null || true`).catch(() => '');
      if (!body || body.length < 20) { console.log(`  ${label}: (empty/unreadable)`); return ''; }
      fs.writeFileSync(path.join(out, `${box.host}.${label}`), body);
      console.log(`  ${label}: ${body.length}B`);
      return body;
    };
    await grab('/root/enb/config/enb.cfg', 'enb.cfg');
    await grab('/root/enb/config/gnb.cfg', 'gnb.cfg');
    const mme = await grab('/root/mme/config/mme.cfg', 'mme.cfg');
    await grab('/root/mme/config/ims.cfg', 'ims.cfg');
    await grab('/root/ots/config/ots.cfg', 'ots.cfg');
    // Every include the live mme.cfg pulls in — that is where the DB lives.
    for (const m of mme.matchAll(/^[^\/\n]*?include\s+"([^"]+)"/gm)) {
      await grab(`/root/mme/config/${m[1]}`, `include.${m[1]}`);
    }
    // A couple of other DB-looking files, to see the spread of shapes.
    const dbs = await readCommand(box,
      `sudo -n ls /root/mme/config 2>/dev/null || ls /root/mme/config 2>/dev/null || true`);
    const names = dbs.split(/\s+/).filter((n) => /db|subscriber|ue/i.test(n) && /\.cfg/.test(n)).slice(0, 4);
    console.log('  db-ish names:', names.join(', ') || '(none)');
    for (const n of names) await grab(`/root/mme/config/${n}`, `db.${n}`);
  } catch (e: any) {
    console.log('  FAILED:', e?.message ?? e);
  }
}
console.log('\nwrote to', path.resolve(out));

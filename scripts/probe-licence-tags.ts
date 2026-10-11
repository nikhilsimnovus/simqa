// The licence tag in every config the lab is actually running, read and
// rewritten, to check the scanner against real files rather than miniatures.
//
//   npx tsx scripts/probe-licence-tags.ts <dirOfPulledConfigs>
import * as fs from 'fs';
import * as path from 'path';
import { licenceTagOf, withLicenceTag } from '../src/lib/automation/licenceTag';

const dir = process.argv[2];
let seen = 0, bad = 0;
for (const f of fs.readdirSync(dir).sort()) {
  if (!/\.(cfg|json)$/.test(f)) continue;
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const tag = licenceTagOf(text);
  if (!tag) continue;
  seen++;
  const r = withLicenceTag(text, 'probe-tag');
  const back = withLicenceTag(r.text, tag);
  const roundTripped = back.text === text;
  const onlyTagChanged = r.text.length - text.length === 'probe-tag'.length - tag.length;
  const ok = r.changed && licenceTagOf(r.text) === 'probe-tag' && roundTripped && onlyTagChanged;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f.padEnd(46)} tag=${tag.padEnd(12)} rewritten=${licenceTagOf(r.text)} roundTrip=${roundTripped} onlyTagChanged=${onlyTagChanged}`);
}
console.log(`\n${seen} config(s) name a licence tag, ${bad} mishandled`);

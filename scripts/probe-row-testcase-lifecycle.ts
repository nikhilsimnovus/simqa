// A suite row owns ONE testcase on the Simnovator. This proves the four
// things that has to mean, against a real box:
//
//   1. first run      creates it under the display name
//   2. second run     executes that same one — same id, no _2
//   3. edited on the  rebuilt from the automation server's copy, same name
//      Simnovator
//   4. duration       rebuilt at the new power-on duration, same name
//      changed
//
// Creates and deletes one testcase named simqa_lifecycle_<stamp>. Nothing is
// executed, so no hardware time is spent and no radio is touched.
//
//   npx tsx scripts/probe-row-testcase-lifecycle.ts <host> <user> <pass> <sourceName>
import { ensureToken, getTestcase, listTestcases, type ApiOpts } from '../src/lib/uesimClient';
import { duplicateTestcase, updateTestcaseInPlace } from '../src/lib/automation/duplicateTestcase';
import { deleteTestCase } from '../src/lib/configFidelity/testCreator';
import { powerOnOf } from '../src/lib/automation/durationFit';

const [, , host, username, password, sourceName] = process.argv;
const opts: ApiOpts = { host, username, password } as ApiOpts;
await ensureToken(host, username, password);

const page = await listTestcases(opts, 1000, 0);
const src = (page.items ?? []).find((t: any) => t.name === sourceName);
if (!src) { console.error(`no testcase named "${sourceName}" on ${host}`); process.exit(1); }
/** Stands in for /root/automation_configs/<suite>/<row>/test.json. */
const server: any = (await getTestcase(opts, src.id)).testDefinition;

const name = `simqa_lifecycle_${Date.now().toString(36)}`;
let made = '';
const show = async (label: string, r: any) => {
  const back: any = r.testCaseId ? await getTestcase(opts, r.testCaseId) : null;
  console.log(
    `${label.padEnd(34)} id=${String(r.testCaseId).slice(0, 8)} name="${r.name}" reused=${!!r.reused}`
    + ` powerOn=${back ? powerOnOf(back.testDefinition).powerOnTime : '-'}`);
  if (r.warning) console.log(`${' '.repeat(36)}${r.warning.slice(0, 150)}`);
  if (r.error) console.log(`${' '.repeat(36)}ERROR ${r.error.slice(0, 150)}`);
  return r.testCaseId as string;
};

try {
  console.log(`source "${sourceName}" on ${host}, row named "${name}"\n`);

  // 1 — first run
  const a = await duplicateTestcase(opts, src.id, name, 100, server);
  made = await show('1 first run: created', a);
  if (!made) process.exit(1);

  // 2 — second run, nothing changed
  const b = await duplicateTestcase(opts, src.id, name, 100, server);
  const idB = await show('2 second run: same testcase', b);
  console.log(`   same id as the first? ${idB === made ? 'YES' : 'NO — ' + idB}`);
  console.log(`   same name, no _2?      ${b.name === name ? 'YES' : 'NO — ' + b.name}`);

  // 3 — somebody edits it on the Simnovator
  const edited: any = JSON.parse(JSON.stringify(server));
  const cell = edited.cellConfig?.cells?.[0];
  if (cell) cell.rx_gain = (Number(cell.rx_gain) || 0) + 7;        // a visible, harmless change
  // Without this the update carries the SOURCE's name and the box refuses to
  // rename onto a name that already exists — after it has already written the
  // cells. Which is its own small lesson: that update is not atomic.
  delete edited.settings;
  const up = await updateTestcaseInPlace(opts, idB, edited);
  // updateTestcaseInPlace reports which sections it wrote, not an `ok` flag —
  // reading it as one made a successful edit print "FAILED".
  console.log(`\n   edited on the box (rx_gain +7): ${up.error
    ? 'FAILED ' + String(up.error).slice(0, 120)
    : 'updated ' + ((up as { updated?: string[] }).updated ?? []).join(', ')}`);
  const c = await duplicateTestcase(opts, src.id, name, 100, server);
  const idC = await show('3 after a box-side edit', c);
  console.log(`   rebuilt rather than reused? ${c.reused && idC === idB ? 'NO — it reused the edited one' : 'YES'}`);
  const backC: any = await getTestcase(opts, idC);
  const gainC = backC?.testDefinition?.cellConfig?.cells?.[0]?.rx_gain;
  const gainServer = server.cellConfig?.cells?.[0]?.rx_gain;
  console.log(`   rx_gain back to the server's ${gainServer}? ${gainC === gainServer ? 'YES' : 'NO — ' + gainC}`);

  // 4 — the row's power-on duration changes for the next run
  const d = await duplicateTestcase(opts, src.id, name, 250, server);
  const idD = await show('4 duration 100 -> 250', d);
  const backD: any = await getTestcase(opts, idD);
  console.log(`   power-on now 250?      ${powerOnOf(backD.testDefinition).powerOnTime === 250 ? 'YES' : 'NO'}`);
  console.log(`   still the same name?   ${d.name === name ? 'YES' : 'NO — ' + d.name}`);
  made = idD;

  // and nothing accumulated on the box
  const after = await listTestcases(opts, 1000, 0);
  const mine = (after.items ?? []).filter((t: any) => String(t.name).startsWith('simqa_lifecycle_'));
  console.log(`\n   testcases left wearing this row's name: ${mine.length} (${mine.map((t: any) => t.name).join(', ')})`);
} finally {
  if (made) console.log(`\ncleanup: delete -> ${await deleteTestCase(opts, made).catch(() => -1)}`);
}

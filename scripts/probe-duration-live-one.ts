// One named testcase, fitted to a requested power-on duration, created on the
// box and read back — then deleted. The targeted version of
// probe-duration-live.ts, for a shape whose automatic pick failed to create for
// reasons of its own (a missing success criteria, a null cell field).
//
//   npx tsx scripts/probe-duration-live-one.ts <host> <user> <pass> <seconds> <sourceName>
import { ensureToken, getTestcase, listTestcases, type ApiOpts } from '../src/lib/uesimClient';
import { duplicateTestcase } from '../src/lib/automation/duplicateTestcase';
import { deleteTestCase } from '../src/lib/configFidelity/testCreator';
import { boxComplaints, requiredPowerOn } from '../src/lib/automation/durationFit';

const [, , host, username, password, secArg, sourceName] = process.argv;
const seconds = Number(secArg ?? 100);
const opts: ApiOpts = { host, username, password } as ApiOpts;
await ensureToken(host, username, password);
const page = await listTestcases(opts, 1000, 0);
const src = (page.items ?? []).find((t: any) => t.name === sourceName);
if (!src) { console.error(`no testcase named "${sourceName}"`); process.exit(1); }

const before: any = await getTestcase(opts, src.id);
const b = (before?.testDefinition?.userPlaneConfig?.profiles ?? [])[0] ?? {};
console.log(`source "${sourceName}": ${b.dataType} session=${b.sessionDuration} start=${b.startDelay} call=${b.callDuration} setup=${b.callSetupDelay} loop=${b.dataLoop}`);

const copyName = `simqa_durfit_one_${Date.now().toString(36)}`;
let id = '';
try {
  const r = await duplicateTestcase(opts, src.id, copyName, seconds);
  id = r.testCaseId ?? '';
  if (!id) { console.log(`FAILED: ${JSON.stringify(r).slice(0, 400)}`); process.exit(1); }
  const back: any = await getTestcase(opts, id);
  const td = back?.testDefinition ?? {};
  const pc = (td.powerCycleConfig?.profiles ?? [])[0] ?? {};
  const up = (td.userPlaneConfig?.profiles ?? [])[0] ?? {};
  const left = boxComplaints(td);
  console.log(left.length ? 'BOX WOULD REFUSE' : 'ACCEPTED by the box');
  console.log(`  powerOnTime=${pc.powerOnTime} durationP=${pc.durationP} dataLoopP=${pc.dataLoopP}`);
  console.log(`  session=${up.sessionDuration} start=${up.startDelay} call=${up.callDuration} setup=${up.callSetupDelay} loop=${up.dataLoop} need=${requiredPowerOn(up)}`);
  if (r.warning) console.log(`  warning: ${r.warning}`);
  for (const l of left) console.log(`  LEFT: ${l}`);
} finally {
  if (id) console.log(`  delete -> ${await deleteTestCase(opts, id).catch(() => -1)}`);
}

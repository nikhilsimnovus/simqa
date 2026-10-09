// Real examples of a looping user-plane profile, with the fields that go with
// it — dataLoop / loopCount / interSessionGap — and the power-cycle window
// around them, so the loop arithmetic is written against values the box has
// actually accepted.
//
//   npx tsx scripts/probe-dataloop.ts <host> <user> <pass> [max]
import { ensureToken, getTestcase, listTestcases, type ApiOpts } from '../src/lib/uesimClient';

const [, , host, username, password, maxArg] = process.argv;
const opts: ApiOpts = { host, username, password } as ApiOpts;
await ensureToken(host, username, password);
const page = await listTestcases(opts, 1000, 0);
const items = (page.items ?? []).slice(0, Number(maxArg ?? 400));
console.log(`== ${host} as ${username}: scanning ${items.length} of ${page.total}`);

let withLoop = 0;
for (const t of items) {
  let td: any;
  try { td = await getTestcase(opts, t.id); } catch { continue; }
  const def = td?.testDefinition ?? td;
  const profs = (def?.userPlaneConfig?.profiles ?? []).filter((p: any) => p && p.dataLoop === true);
  if (!profs.length) continue;
  withLoop++;
  const pc = (def?.powerCycleConfig?.profiles ?? [])[0] ?? {};
  console.log(`\n${t.name}`);
  console.log(`   powerCycle: powerOnTime=${pc.powerOnTime} durationP=${pc.durationP} attachDelay=${pc.attachDelay} loopProfile=${pc.loopProfile} dataLoopP=${pc.dataLoopP} noOfPowerOnCycles=${pc.noOfPowerOnCycles} powerOffTime=${pc.powerOffTime} totalTestDuration=${pc.totalTestDuration}`);
  for (const p of profs) {
    console.log(`   ${String(p.dataType).padEnd(8)} session=${p.sessionDuration} start=${p.startDelay} loop=${p.dataLoop} loopCount=${p.loopCount} interSessionGap=${p.interSessionGap}`
      + ` pkts=${p.numberOfPackets} interval=${p.interval} call=${p.callDuration} setup=${p.callSetupDelay}`);
  }
}
console.log(`\n${withLoop} testcase(s) with a looping profile`);

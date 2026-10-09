// Would the box accept what the fitter produces, for every testcase it holds?
//
// applyDuration is the inverse of the box's own arithmetic, and the arithmetic
// is transcribed from its form bundle — so the way to find a shape I did not
// think of is to run every real testcase through it at several durations and
// ask the transcribed rules whether anything is left to complain about.
//
//   npx tsx scripts/probe-duration-sweep.ts <host> <user> <pass> [max]
import { ensureToken, getTestcase, listTestcases, type ApiOpts } from '../src/lib/uesimClient';
import { applyDuration, boxComplaints, requiredPowerOn } from '../src/lib/automation/durationFit';

const [, , host, username, password, maxArg] = process.argv;
const opts: ApiOpts = { host, username, password } as ApiOpts;
await ensureToken(host, username, password);
const page = await listTestcases(opts, 1000, 0);
const items = (page.items ?? []).slice(0, Number(maxArg ?? 200));
const DURATIONS = [20, 60, 100, 300, 900, 3600];

let checked = 0, bad = 0, raised = 0;
const byType = new Map<string, number>();
const failures: string[] = [];

for (const t of items) {
  let td: any;
  try { td = await getTestcase(opts, t.id); } catch { continue; }
  const base = td?.testDefinition;
  if (!base?.userPlaneConfig && !base?.powerCycleConfig) continue;
  for (const p of base.userPlaneConfig?.profiles ?? []) {
    const k = String(p?.dataType ?? '(none)');
    byType.set(k, (byType.get(k) ?? 0) + 1);
  }
  for (const want of DURATIONS) {
    const copy = JSON.parse(JSON.stringify(base));
    let notes: string[] = [];
    try { notes = applyDuration(copy, want); }
    catch (e: any) { failures.push(`${t.name} @${want}s THREW ${e?.message}`); bad++; continue; }
    checked++;
    const left = boxComplaints(copy);
    const got = copy.powerCycleConfig?.profiles?.[0]?.powerOnTime;
    if (got !== want) raised++;
    if (left.length) {
      bad++;
      if (failures.length < 25) {
        const types = (copy.userPlaneConfig?.profiles ?? []).map((p: any) => `${p.dataType}${p.dataLoop ? '/loop' : ''}`).join('+');
        failures.push(`${t.name} @${want}s [${types}] -> ${left.join(' | ')}`);
        for (const p of copy.userPlaneConfig?.profiles ?? []) {
          failures.push(`      session=${p.sessionDuration} start=${p.startDelay} call=${p.callDuration} setup=${p.callSetupDelay}`
            + ` loop=${p.dataLoop} n=${p.loopCount} gap=${p.interSessionGap} pkts=${p.numberOfPackets} interval=${p.interval} need=${requiredPowerOn(p)}`);
        }
      }
    }
    void notes;
  }
}

console.log(`\n${host}: ${checked} fits checked across ${items.length} testcases and ${DURATIONS.length} durations`);
console.log(`data types seen: ${[...byType.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ')}`);
console.log(`power-on raised above the asked-for figure: ${raised}`);
console.log(bad === 0 ? 'NOTHING the box would refuse' : `${bad} would be REFUSED:`);
for (const f of failures) console.log('  ' + f);

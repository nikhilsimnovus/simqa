// What is the "Ramp-up offset" the box adds to Total Test Duration?
//
// The refusal names it — "Total Test Duration should be at least Power On Time
// + Power Off Time + Ramp-up offset for profile 0. Minimum: 183.00" — but the
// term appears nowhere in the box's frontend bundle, so it is a server-side
// rule and has to be measured. For every testcase that carries a
// totalTestDuration, this prints the leftover once powerOn and powerOff are
// taken out, beside the attach parameters that might explain it.
//
//   npx tsx scripts/probe-rampup.ts <host> <user> <pass> [max]
import { ensureToken, getTestcase, listTestcases, type ApiOpts } from '../src/lib/uesimClient';

const [, , host, username, password, maxArg] = process.argv;
const opts: ApiOpts = { host, username, password } as ApiOpts;
await ensureToken(host, username, password);
const page = await listTestcases(opts, 1000, 0);
const items = (page.items ?? []).slice(0, Number(maxArg ?? 250));

const ueCountOf = (td: any): number => {
  const subs = td?.subscriberConfig?.subs ?? td?.subscriberConfig?.subsConfig?.subs
    ?? td?.subscriberData?.subsConfig?.subs ?? [];
  let n = 0;
  for (const s of subs) n += Number(s?.ueCount ?? s?.count ?? s?.noOfUes ?? s?.numberOfUes ?? 0) || 0;
  return n;
};

console.log('leftover  powerOn  powerOff  cycles  attachRate  ttiRate  type        ueCount  subsLen  name');
let rows = 0;
for (const t of items as any[]) {
  let td: any;
  try { td = (await getTestcase(opts, t.id)).testDefinition; } catch { continue; }
  for (const pc of td?.powerCycleConfig?.profiles ?? []) {
    const total = Number(pc?.totalTestDuration);
    if (!Number.isFinite(total) || total <= 0) continue;
    const on = Number(pc?.powerOnTime) || 0;
    const off = Number(pc?.powerOffTime) || 0;
    const cycles = Number(pc?.noOfPowerOnCycles) || 0;
    const leftover = total - on - off;
    rows++;
    console.log(
      String(leftover).padStart(8),
      String(on).padStart(8), String(off).padStart(9), String(cycles).padStart(7),
      String(pc?.attachRate ?? '-').padStart(11), String(pc?.ttiAttachRate ?? '-').padStart(8),
      String(pc?.attachType ?? '-').padEnd(11),
      String(ueCountOf(td)).padStart(8), String(pc?.subsLen ?? '-').padStart(8),
      ' ' + String(t.name).slice(0, 44),
    );
    if (rows >= 30) break;
  }
  if (rows >= 30) break;
}
console.log(`\n${rows} power-cycle profile(s) with a total test duration`);

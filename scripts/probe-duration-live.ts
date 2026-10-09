// Does the BOX accept what the fitter produces?
//
// The offline sweep checks the fit against rules transcribed from the box's own
// form bundle. This checks the transcription itself: for one testcase per data
// type it creates a real copy at a requested power-on duration, reads back what
// the box stored, and deletes the copy again. If the transcription is wrong the
// box says so here, in its own words.
//
//   npx tsx scripts/probe-duration-live.ts <host> <user> <pass> <seconds>
import { ensureToken, getTestcase, listTestcases, type ApiOpts } from '../src/lib/uesimClient';
import { duplicateTestcase } from '../src/lib/automation/duplicateTestcase';
import { deleteTestCase } from '../src/lib/configFidelity/testCreator';
import { boxComplaints, requiredPowerOn } from '../src/lib/automation/durationFit';

const [, , host, username, password, secArg] = process.argv;
const seconds = Number(secArg ?? 100);
const opts: ApiOpts = { host, username, password } as ApiOpts;
await ensureToken(host, username, password);

const page = await listTestcases(opts, 1000, 0);
/** One source per shape: data type plus whether it loops. */
const picks = new Map<string, { id: string; name: string }>();
for (const t of (page.items ?? [])) {
  if (picks.size >= 12) break;
  let td: any;
  try { td = await getTestcase(opts, t.id); } catch { continue; }
  const profs = (td?.testDefinition?.userPlaneConfig?.profiles ?? []).filter((p: any) => p);
  if (profs.length !== 1) continue;                  // keep the probe simple
  const p = profs[0];
  const key = `${String(p.dataType ?? 'none')}${p.dataLoop ? '-loop' : ''}`;
  if (!picks.has(key)) picks.set(key, { id: t.id, name: String(t.name) });
}
console.log(`${host}: probing ${picks.size} shape(s) at ${seconds}s — ${[...picks.keys()].join(', ')}\n`);

const stamp = Date.now().toString(36);
for (const [key, src] of picks) {
  const copyName = `simqa_durfit_${key.replace(/[^A-Za-z0-9]+/g, '_')}_${stamp}`;
  let madeId = '';
  try {
    const r = await duplicateTestcase(opts, src.id, copyName, seconds);
    madeId = r.testCaseId ?? '';
    if (!madeId) { console.log(`${key.padEnd(12)} FAILED to create: ${JSON.stringify(r).slice(0, 220)}`); continue; }
    const back: any = await getTestcase(opts, madeId);
    const td = back?.testDefinition ?? {};
    const pcs = (td.powerCycleConfig?.profiles ?? []);
    const up = (td.userPlaneConfig?.profiles ?? [])[0] ?? {};
    const left = boxComplaints(td);
    console.log(`${key.padEnd(12)} ${left.length ? 'BOX WOULD REFUSE' : 'accepted        '} from "${src.name}"`);
    console.log(`             powerOnTime=${pcs.map((x: any) => x.powerOnTime).join(',')} durationP=${pcs.map((x: any) => x.durationP).join(',')} dataLoopP=${pcs.map((x: any) => x.dataLoopP).join(',')}`);
    console.log(`             session=${up.sessionDuration} start=${up.startDelay} call=${up.callDuration} setup=${up.callSetupDelay}`
      + ` loop=${up.dataLoop} n=${up.loopCount} gap=${up.interSessionGap} pkts=${up.numberOfPackets} interval=${up.interval} need=${requiredPowerOn(up)}`);
    if (r.warning) console.log(`             warning: ${r.warning.slice(0, 200)}`);
    for (const l of left) console.log(`             LEFT: ${l}`);
  } catch (e: any) {
    console.log(`${key.padEnd(12)} THREW ${String(e?.message ?? e).slice(0, 260)}`);
  } finally {
    if (madeId) {
      const st = await deleteTestCase(opts, madeId).catch(() => -1);
      if (st < 200 || st >= 300) console.log(`             (copy ${copyName} left behind, delete returned ${st})`);
    }
  }
}

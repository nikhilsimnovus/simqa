import { NextResponse } from 'next/server';
import { getTestcase } from '@/lib/uesimClient';
import { generateConfigs, type UesimTestDefinition } from '@/lib/cfgGenerator';
import { uesimApiOptsForSystem, loadInventory, callboxForProfile, type Inventory } from '@/lib/inventory';
import { listRuns, loadRun } from '@/lib/endToEnd/runner';
import { readRemoteFile, readCommand } from '@/lib/configFidelity/ssh';
import { moduleConfigPath, MODULE_NAMES, type ModuleName } from '@/lib/deploy';
import { ueCfgLogName } from '@/lib/liveFidelity/watcher';
import { listCaptures, readArtifact, hasArtifact } from '@/lib/liveFidelity/store';

export const dynamic = 'force-dynamic';

/**
 * Pull the LIVE config files off the lab machines.
 *
 * The cfgs simqa shows are synthesised from the testcase; these are what the
 * boxes actually hold. ue.cfg in particular can only come from the box — the
 * UE-sim writes it during execution and there is no local generator for it.
 * Lab configs are split across hosts (callbox runs enb/gnb/mme, UE-sim writes
 * ue.cfg), so each inventory system declares what it holds via `collect`.
 *
 * Best-effort by design: a missing host, absent credentials or an unreadable
 * file yields a note, never a failed preview. Collected files are keyed by
 * their plain filename, so once a testcase has run they REPLACE the generated
 * default of the same name rather than sitting beside it — after execution the
 * file that matters is the one the box actually holds.
 */
async function collectLiveConfigs(inv: Inventory): Promise<{ files: Record<string, string>; notes: string[] }> {
  const files: Record<string, string> = {};
  const notes: string[] = [];

  const sources = inv.systems.filter((s) => Array.isArray(s.collect) && s.collect.length);
  if (!sources.length) return { files, notes };

  for (const sys of sources) {
    // A host without credentials is simply not set up for collection yet —
    // that's a config state, not a fault, so skip it silently rather than
    // repeating the same notice on every testcase view. Real failures
    // (unreachable host, missing file) still get reported below.
    const usingKey = sys.authMode === 'privateKey';
    const hasCreds = !!sys.username && (usingKey ? !!sys.privateKey : !!sys.password);
    if (!hasCreds) continue;
    for (const raw of sys.collect!) {
      const mod = String(raw) as ModuleName;
      if (!MODULE_NAMES.includes(mod)) {
        notes.push(`live configs: ${sys.id} lists unknown module "${raw}" (expected ${MODULE_NAMES.join(', ')})`);
        continue;
      }
      const path = sys.collectPaths?.[mod] ?? moduleConfigPath(mod);
      const label = path.split('/').pop() ?? mod;
      try {
        const text = await readRemoteFile(sys, path);
        if (!text) { notes.push(`${label}: not found at ${sys.host}:${path}`); continue; }
        files[label] = text;
      } catch (e: any) {
        notes.push(`${label}: ${sys.host} unreachable — ${e?.message ?? e}`);
      }
    }
  }
  return { files, notes };
}

/**
 * This testcase's own ue.cfg, from the Config Fidelity capture of its last run.
 *
 * Nothing generates a ue.cfg — the UE-sim writes it during execution — so once
 * the lab moves on to another testcase the only surviving copy of THIS one's is
 * the captured artifact. The capture was already attributed to this testcase at
 * capture time, so it cannot be another test's file.
 *
 * Best-effort: no capture, or an unreadable one, simply yields nothing.
 */
function capturedUeCfg(ip: string, testcaseId: string): { text: string; startedAt: string } | undefined {
  try {
    const mine = listCaptures(ip)
      .filter((c) => c.testcaseId === testcaseId && hasArtifact(ip, c.captureId, 'ue.cfg'))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const newest = mine[0];
    if (!newest) return undefined;
    return {
      text: readArtifact(ip, newest.captureId, 'ue.cfg').toString('utf8'),
      startedAt: newest.startedAt,
    };
  } catch {
    return undefined;
  }
}

/**
 * The cfg files THIS testcase's last SimQA run linked, read off the callbox by
 * name.
 *
 * The live-config read below asks the boxes what they hold now and then has to
 * work out whose it is — the lab holds one set at a time, so after another
 * test runs, enb.cfg is somebody else's. This asks a different question with a
 * definite answer: the run recorded that it linked enb-3cc.cfg, so read
 * /root/enb/config/enb-3cc.cfg. The named file is the file, whoever ran last,
 * and it is right from the first execution onwards.
 *
 * Best-effort: no run, no selection, no callbox credentials or an unreadable
 * file yields nothing and the caller falls back as before.
 */
async function configsFromLastRun(
  inv: Inventory,
  systemId: string | undefined,
  testcaseId: string,
): Promise<{ files: Record<string, string>; from?: string; notes: string[] }> {
  const notes: string[] = [];
  if (!systemId) return { files: {}, notes };

  const mine = listRuns()
    .filter((r) => r.testcaseId === testcaseId && r.systemId === systemId)
    .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
  for (const summary of mine.slice(0, 5)) {
    const report = loadRun(summary.runId);
    const sel = report?.cfgSelection;
    if (!sel || !Object.values(sel).some(Boolean)) continue;

    const profile = inv.profiles.find((p) => p.simnovator === systemId);
    const callbox = callboxForProfile(inv, profile);
    if (!callbox) { notes.push('cfg files: this Simnovator has no callbox in its topology setup.'); return { files: {}, notes }; }
    const usingKey = callbox.authMode === 'privateKey';
    if (!callbox.username || (usingKey ? !callbox.privateKey : !callbox.password)) {
      notes.push(`cfg files: ${callbox.host} has no credentials in System Management, so the files this run used could not be read.`);
      return { files: {}, notes };
    }

    const files: Record<string, string> = {};
    for (const mod of ['enb', 'gnb', 'mme', 'ims'] as const) {
      const chosen = (sel as Record<string, string | undefined>)[mod];
      if (!chosen) continue;
      const dir = moduleConfigPath(mod as ModuleName).replace(/\/[^/]+$/, '');
      try {
        const text = await readRemoteFile(callbox, `${dir}/${chosen}`);
        if (text) files[`${mod} (${chosen})`] = text;
        else notes.push(`${chosen}: not found at ${callbox.host}:${dir}`);
      } catch (e: any) {
        notes.push(`${chosen}: ${callbox.host} unreachable — ${e?.message ?? e}`);
      }
    }
    if (Object.keys(files).length) {
      notes.push(
        `Config files read from ${callbox.host} by the names this testcase's run of ${new Date(summary.startedAt).toLocaleString()} linked.`,
      );
      return { files, from: summary.startedAt, notes };
    }
  }

  // Runs recorded before the selection was stored — and runs that linked
  // nothing — leave us with the callbox itself. Its enb.cfg is a symlink to
  // whichever file was linked last, so reading the link target names the file
  // and reading through it gives the content. Only when the newest run on this
  // Simnovator is THIS testcase's: otherwise those files are another test's,
  // which is the mistake the live-config gate below exists to prevent.
  const newestHere = mine[0];
  const newestOnSystem = listRuns()
    .filter((r) => r.systemId === systemId)
    .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))[0];
  if (!newestHere || !newestOnSystem || newestOnSystem.runId !== newestHere.runId) return { files: {}, notes };

  const profile = inv.profiles.find((p) => p.simnovator === systemId);
  const callbox = callboxForProfile(inv, profile);
  const usingKey = callbox?.authMode === 'privateKey';
  if (!callbox?.username || (usingKey ? !callbox.privateKey : !callbox.password)) return { files: {}, notes };

  const files: Record<string, string> = {};
  for (const mod of ['enb', 'gnb', 'mme', 'ims'] as const) {
    const linkPath = moduleConfigPath(mod as ModuleName);
    try {
      const text = await readRemoteFile(callbox, linkPath);
      if (!text) continue;
      // The link target, so the file is named the way it was picked.
      const target = (await readCommand(callbox, `readlink ${linkPath} 2>/dev/null || true`)).trim();
      files[target ? `${mod} (${target.split('/').pop()})` : mod] = text;
    } catch { /* a module the callbox does not hold */ }
  }
  if (Object.keys(files).length) {
    notes.push(`Config files read from ${callbox.host}, which still holds what this testcase's last run linked.`);
    return { files, from: newestHere.startedAt, notes };
  }
  return { files: {}, notes };
}

/** GET /api/testcases/:id/preview?systemId -> { files, summary } without
 *  persisting. systemId must match the list route or the preview is generated
 *  from a different box's copy of the testcase. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const systemId = q.get('systemId') ?? undefined;
  const boxUserId = q.get('boxUserId') ?? undefined;   // see ../route.ts
  const inv = loadInventory();
  const opts = uesimApiOptsForSystem(inv, systemId, boxUserId);
  if (!opts) {
    return NextResponse.json(
      { error: systemId ? `system "${systemId}" is not a testable UESIM` : 'no UESIM in inventory' },
      { status: 400 },
    );
  }
  try {
    const tc = await getTestcase(opts, id);
    if (!tc.testDefinition) return NextResponse.json({ error: 'no testDefinition' }, { status: 502 });
    const bundle = generateConfigs(tc.testDefinition as UesimTestDefinition, id, { testcaseName: tc.name });

    // Live configs only make sense once THIS testcase has actually run. Before
    // that the files on the lab machines belong to whatever ran last, so
    // showing them beside a never-executed testcase implies they came from it.
    //
    // Not executed -> "default enb", "default mme", "default ims" — synthesised
    //                 from this testcase's own definition (band, bandwidth,
    //                 antennas…). Nothing on a box relates to it yet.
    // Executed     -> "enb", "mme", "ims", "ue" — what the boxes actually hold.
    //                 The defaults are dropped: once a run has happened the
    //                 real file is the answer, and showing both invites reading
    //                 the wrong one.
    const isCfg = (n: string) => n.endsWith('.cfg');
    const stripCfg = (n: string) => n.replace(/\.cfg$/, '');

    const executed = Boolean((tc as any)?.metadata?.lastExecution?.executedOn);
    const generated = bundle.files;
    const out: Record<string, string> = {};
    const liveNames: string[] = [];
    const defaultNames: string[] = [];

    // "Has this testcase ever run" is NOT enough to claim the lab's files as
    // its own. The boxes hold one set of configs — whatever ran LAST anywhere
    // on the lab — so after a 5G run every executed testcase, LTE included,
    // was being shown that same enb/mme/ims/ue. Confirmed on .102: vonr, SA and
    // TC_LTE returned byte-identical live files.
    //
    // The UE-sim stamps each ue.cfg with `log_filename: /tmp/<testcase>.log`,
    // which is the same attribution gate the live-fidelity watcher uses. If it
    // names this testcase, the lab is holding this run's configs and they are
    // safe to show; if it names another, they belong to that run.
    let liveOwner: string | undefined;
    let liveIsOurs = false;

    // The files this testcase's own last run linked, by name. These need no
    // attribution — the run said which files it used — so they are shown
    // whether or not the lab has since moved on to another test.
    const fromRun = await configsFromLastRun(inv, systemId, id);
    bundle.summary.notes.push(...fromRun.notes);
    for (const [label, text] of Object.entries(fromRun.files)) {
      out[label] = text;
      liveNames.push(label);
    }
    const haveRunFiles = Object.keys(fromRun.files).length > 0;

    if (executed) {
      const live = await collectLiveConfigs(inv);
      bundle.summary.notes.push(...live.notes);

      const ueCfg = Object.entries(live.files).find(([n]) => stripCfg(n) === 'ue')?.[1];
      liveOwner = ueCfg ? ueCfgLogName(ueCfg) : undefined;
      // No ue.cfg, or one with no marker, means we cannot attribute the lab's
      // files to anything. Unattributable is treated as "not ours": a confident
      // wrong config is worse than an honest gap.
      liveIsOurs = !!liveOwner && !!tc.name && liveOwner.trim() === String(tc.name).trim();

      if (liveIsOurs) {
        for (const [name, text] of Object.entries(live.files)) {
          const label = stripCfg(name);
          out[label] = text;
          liveNames.push(label);
        }
      } else if (!haveRunFiles) {
        // Only worth saying when nothing else answered. With the run's own
        // files already shown, "live configs hidden" reads as though the page
        // were missing something it is not.
        bundle.summary.notes.push(
          liveOwner
            ? `Live configs hidden: the lab machines currently hold "${liveOwner}"'s configs, not this testcase's. Run this testcase to see its own.`
            : `Live configs hidden: the ue.cfg on the UE-sim carries no testcase marker, so the lab's configs cannot be attributed to this testcase.`,
        );
      }
    }

    // An executed testcase always shows its enb / mme / ims / ue db, even when
    // the lab has since moved on to another test. These are generated from THIS
    // testcase's own definition, so they are correct for it — unlike the live
    // files, which belong to whatever ran last. Labelled "default …" so they
    // are never mistaken for what the box actually held.
    //
    // ue.cfg has no generator: only the UE-sim writes it. Where a config
    // fidelity capture exists for this testcase, that capture's stored ue.cfg
    // IS this testcase's real one — attributed at capture time by the same
    // log_filename marker — so it is recovered from there rather than left out.
    if (executed) {
      if (!liveIsOurs) {
        const recovered = capturedUeCfg(opts.host, id);
        if (recovered) {
          out.ue = recovered.text;
          liveNames.push('ue');
          bundle.summary.notes.push(
            `ue.cfg recovered from the Config Fidelity capture of this testcase's run at ${recovered.startedAt}.`,
          );
        }
      }
      for (const [name, text] of Object.entries(generated)) {
        if (!isCfg(name)) { out[name] = text; continue; }
        const label = stripCfg(name);
        // A file read by the name the run linked already answers for this
        // module — "enb (enb-3cc.cfg)" — so no "default enb" beside it to be
        // read instead.
        const haveReal = label in out || Object.keys(out).some((k) => k.startsWith(`${label} (`));
        if (!haveReal) { out[`default ${label}`] = text; defaultNames.push(`default ${label}`); }
      }
    } else {
      // Either never executed, or executed but the lab has since moved on to
      // another testcase. Show ONLY testcase.json in both cases.
      //
      // The speculative "default enb / default mme / default ims" previews were
      // synthesised from the testcase's own definition with nothing on a box to
      // back them up — shown next to a Run Configuration picker (which offers
      // REAL cfg files already on the callbox), they read as though they were
      // real choices. Showing them here would be the same trap, and showing the
      // lab's actual files would be worse still: they are another test's.
      for (const [name, text] of Object.entries(generated)) {
        if (isCfg(name)) continue;
        out[name] = text;
      }
    }

    bundle.files = out;
    (bundle.summary as any).executed = executed;
    (bundle.summary as any).liveFiles = liveNames;
    (bundle.summary as any).defaultFiles = defaultNames;
    // Who the lab's current configs actually belong to, so the page can say so.
    (bundle.summary as any).liveOwner = liveOwner;
    (bundle.summary as any).liveIsOurs = liveIsOurs;
    return NextResponse.json(bundle);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 502 });
  }
}

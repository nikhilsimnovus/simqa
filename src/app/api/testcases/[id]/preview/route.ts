import { NextResponse } from 'next/server';
import { getTestcase } from '@/lib/uesimClient';
import { generateConfigs, type UesimTestDefinition } from '@/lib/cfgGenerator';
import { uesimApiOptsForSystem, loadInventory, type Inventory } from '@/lib/inventory';
import { readRemoteFile } from '@/lib/configFidelity/ssh';
import { moduleConfigPath, MODULE_NAMES, type ModuleName } from '@/lib/deploy';

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

/** GET /api/testcases/:id/preview?systemId -> { files, summary } without
 *  persisting. systemId must match the list route or the preview is generated
 *  from a different box's copy of the testcase. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const systemId = new URL(req.url).searchParams.get('systemId') ?? undefined;
  const inv = loadInventory();
  const opts = uesimApiOptsForSystem(inv, systemId);
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

    if (executed) {
      const live = await collectLiveConfigs(inv);
      bundle.summary.notes.push(...live.notes);
      for (const [name, text] of Object.entries(live.files)) {
        const label = stripCfg(name);
        out[label] = text;
        liveNames.push(label);
      }
      // A box that could not be read leaves a gap. Fall back to the generated
      // default for that module rather than showing nothing, and keep the
      // "default" label so it is never mistaken for what ran.
      for (const [name, text] of Object.entries(generated)) {
        if (!isCfg(name)) { out[name] = text; continue; }
        const label = stripCfg(name);
        if (!(label in out)) { out[`default ${label}`] = text; defaultNames.push(`default ${label}`); }
      }
    } else {
      // Not executed: show ONLY testcase.json. The speculative "default enb /
      // default mme / default ims" previews were synthesised from the
      // testcase's own definition with nothing on a box to back them up yet —
      // shown next to a Run Configuration picker (which offers REAL cfg files
      // already on the callbox), they read as though they were real choices.
      // Once the testcase has actually run, the live section above still
      // shows the true cfgs.
      for (const [name, text] of Object.entries(generated)) {
        if (isCfg(name)) continue;
        out[name] = text;
      }
    }

    bundle.files = out;
    (bundle.summary as any).executed = executed;
    (bundle.summary as any).liveFiles = liveNames;
    (bundle.summary as any).defaultFiles = defaultNames;
    return NextResponse.json(bundle);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 502 });
  }
}

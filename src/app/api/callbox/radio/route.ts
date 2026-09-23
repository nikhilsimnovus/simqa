// GET  /api/callbox/radio?systemId=<callbox|simnovator|topology>&lines=80
// POST /api/callbox/radio   { systemId, cfgSelection }
//
// The callbox radio, on its own — link a cfg set, restart `lte`, and read what
// the radio then said about itself.
//
// Everything else that touches the callbox does it as a side effect of running
// a testcase (Scenarios, the end-to-end runner, Automation Suite). Bringing a
// radio up and READING ITS LOG had no entry point at all, which made NTN work
// guesswork: a gNB computes its own SSB position from the carrier and only
// announces it in /tmp/gnb0.log, and the UE has to be told that exact ARFCN or
// it never finds the cell. Guessing it costs a full run to disprove.
//
// The log paths are a fixed whitelist, not a parameter: this runs as root on
// lab equipment, and an arbitrary-path reader is a different thing entirely
// from "show me what the radio is doing".

import { NextResponse } from 'next/server';
import {
  loadInventory, getSystem, getProfile, callboxForProfile, callboxForSimnovator,
  type Inventory, type InventorySystem,
} from '@/lib/inventory';
import { currentCfgLinks, linkAndRestart, type CfgSelection } from '@/lib/labCfgLink';
import { readCommand } from '@/lib/configFidelity/ssh';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The radio's own logs, by role — each a list of the places OTS is known to
 * write it, tried in order. Not a parameter: this runs as root on lab
 * equipment, so "show me what the radio is doing" must not become an
 * arbitrary-path file reader.
 *
 * Two layouts in this lab: /tmp/<role>0.log on the .122-style boxes, and
 * /var/log/lte/ on the CSI callbox (.57) and the CSI UEsim.
 */
const LOGS: Record<string, string[]> = {
  gnb: ['/tmp/gnb0.log', '/var/log/lte/gnb0.log', '/var/log/lte/gnb.log'],
  enb: ['/tmp/enb0.log', '/var/log/lte/enb0.log', '/var/log/lte/enb.log'],
  mme: ['/tmp/mme0.log', '/var/log/lte/mme0.log', '/var/log/lte/mme.log'],
  ims: ['/tmp/ims0.log', '/var/log/lte/ims0.log', '/var/log/lte/ims.log'],
  /** OTS itself — why a component refused to start, which the role logs never say. */
  ots: ['/var/log/lte/ots.log', '/tmp/ots.log'],
  /** Not a log: the OTS service config. It decides WHICH file each component
   *  actually loads (ENB_CONFIG_FILE) and can carry its own licence tag — so
   *  when a link is in place and the radio still starts something else, this
   *  is the file that explains it. */
  otscfg: ['/root/ots/config/ots.cfg'],
  /** Not a log either: the box-wide licence pointer. A component takes its
   *  licence tag from here when one is set, OVERRIDING the tag in its own
   *  config — which reads as "my config says oru-enb, the box says
   *  pre-sales-enb" and stops the radio from starting at all. */
  licence: ['/root/.simnovus/license_server.cfg'],
  /** Not logs: the per-component start scripts OTS generates, and the core
   *  configs. Between them they settle "which config and which licence tag is
   *  this component ACTUALLY using", which no log states outright. */
  enbsh: ['/root/enb/.ENB.sh'],
  mmesh: ['/root/mme/.MME.sh'],
  mmecfg: ['/root/mme/config/mme.cfg'],
};
/**
 * The callbox a request means, however it was named: the callbox itself, a
 * Simnovator whose topology binds one, or a topology id.
 */
function resolveCallbox(inv: Inventory, id: string): InventorySystem | undefined {
  const sys = getSystem(inv, id);
  if (sys?.type === 'CALLBOX') return sys;
  const profile = getProfile(inv, id);
  if (profile) return callboxForProfile(inv, profile);
  return sys ? callboxForSimnovator(inv, sys.id) : undefined;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('systemId') ?? url.searchParams.get('topologyId') ?? '';
  const which = url.searchParams.get('log') ?? 'gnb';
  const lines = Math.min(Math.max(Number(url.searchParams.get('lines') ?? 80), 1), 2000);
  const grep = url.searchParams.get('grep') ?? '';

  if (!id) return NextResponse.json({ ok: false, error: 'systemId (or topologyId) required' }, { status: 400 });
  const candidates = LOGS[which];
  if (!candidates) {
    return NextResponse.json({ ok: false, error: `log must be one of ${Object.keys(LOGS).join(', ')}` }, { status: 400 });
  }

  const inv = loadInventory();
  const box = resolveCallbox(inv, id);
  if (!box) return NextResponse.json({ ok: false, error: `no callbox resolves from "${id}"` }, { status: 404 });

  // grep is a filter over OUR OWN read, never interpolated into the shell —
  // the command below is fixed.
  try {
    // Which of the known locations this box actually uses — reported back, so
    // a caller is never left guessing which file it is looking at.
    const probe = await readCommand(box, candidates.map((p) => `[ -f ${p} ] && echo ${p}`).join('; ') + '; true');
    const path = probe.split('\n').map((l) => l.trim()).find((l) => candidates.includes(l));
    if (!path) {
      return NextResponse.json({
        ok: false, callbox: { id: box.id, host: box.host },
        error: `none of ${candidates.join(', ')} exist on ${box.host}`,
      }, { status: 404 });
    }
    const raw = await readCommand(box, `sudo -n tail -n ${lines} ${path} 2>/dev/null || tail -n ${lines} ${path}`);
    const all = raw.split('\n');
    const matched = grep ? all.filter((l) => l.toLowerCase().includes(grep.toLowerCase())) : all;
    const current = await currentCfgLinks(box).catch(() => ({}));
    return NextResponse.json({
      ok: true,
      callbox: { id: box.id, host: box.host, name: box.name },
      log: path, lines: matched.length, current,
      content: matched.join('\n'),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `${box.host}: ${e?.message ?? e}` }, { status: 502 });
  }
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'body is not valid JSON' }, { status: 400 }); }
  const id = String(body?.systemId ?? body?.topologyId ?? '');
  if (!id) return NextResponse.json({ ok: false, error: 'systemId (or topologyId) required' }, { status: 400 });

  const sel: CfgSelection = {};
  for (const k of ['enb', 'gnb', 'mme', 'mme2', 'ims'] as const) {
    const v = body?.cfgSelection?.[k];
    if (typeof v === 'string' && v.trim()) sel[k] = v.trim();
  }
  if (!Object.keys(sel).length) {
    return NextResponse.json({ ok: false, error: 'cfgSelection must name at least one of enb, gnb, mme, mme2, ims' }, { status: 400 });
  }

  const inv = loadInventory();
  const box = resolveCallbox(inv, id);
  if (!box) return NextResponse.json({ ok: false, error: `no callbox resolves from "${id}"` }, { status: 404 });

  // linkAndRestart waits for the radio to report NG/S1 setup before returning,
  // so a 2xx here means the stack is actually up — not merely restarted.
  const r = await linkAndRestart(box, sel);
  const current = await currentCfgLinks(box).catch(() => ({}));
  return NextResponse.json({ ...r, callbox: { id: box.id, host: box.host }, current }, { status: r.ok ? 200 : 502 });
}

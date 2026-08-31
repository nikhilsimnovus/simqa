// Symlink an existing cfg file into place on a callbox and bring the radio
// stack back up — the bring-up sequence Automation Suite already proved out
// in src/lib/automation/runner.ts (search "cfg-link" there for the original).
// Extracted here so the end-to-end engine (src/lib/endToEnd) can do the same
// bring-up before a validation run, without a second copy of these commands
// drifting out of sync with the original.
//
// Deliberately NOT the SCP-overwrite path in src/lib/deploy.ts — this points
// enb.cfg/mme.cfg/ims.cfg at a file the user picked that's ALREADY on the box,
// the same "soft link" flow Automation Suite uses, not SimQA-generated content.

import { withSsh, readCommand } from './configFidelity/ssh';
import type { InventorySystem } from './inventory';

export interface CfgSelection {
  /** Basename of a file already in /root/enb/config, to become enb.cfg. */
  enb?: string;
  /** Basename of a file already in /root/mme/config, to become mme.cfg. */
  mme?: string;
  /** Basename of a file already in /root/mme/config, to become ims.cfg. */
  ims?: string;
}

export interface CfgLinkStep {
  step: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Symlink each selected file into place, then restart `lte` once. lte.service
 * runs enb+mme+ims together (see automation/runner.ts's own note on this —
 * there is no separate ltemme unit), so one restart picks up every link.
 *
 * Non-destructive to anything NOT selected: a role left unset in `sel` is
 * simply not touched, so e.g. picking only `enb` leaves mme.cfg/ims.cfg
 * pointed at whatever they already were.
 */
export async function linkAndRestart(
  callbox: InventorySystem,
  sel: CfgSelection,
): Promise<{ ok: boolean; steps: CfgLinkStep[] }> {
  const steps: CfgLinkStep[] = [];
  const stamp = (step: string, ok: boolean, detail: string, t0: number) => {
    steps.push({ step, ok, detail, durationMs: Date.now() - t0 });
  };

  if (!sel.enb && !sel.mme && !sel.ims) {
    return { ok: true, steps: [{ step: 'cfg-link', ok: true, detail: 'no files selected — nothing to link', durationMs: 0 }] };
  }

  try {
    if (sel.enb) {
      const t0 = Date.now();
      await withSsh(callbox, async (ssh) => {
        const r = await ssh.execCommand(`cd /root/enb/config && ln -sfn ${q(sel.enb!)} 'enb.cfg' && ls -la 'enb.cfg'`);
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || `ln exit ${r.code}`);
      });
      stamp('cfg-link:enb', true, `enb.cfg → ${sel.enb}`, t0);
    }
    for (const [role, name] of [['mme', sel.mme], ['ims', sel.ims]] as const) {
      if (!name) continue;
      const t0 = Date.now();
      await withSsh(callbox, async (ssh) => {
        const r = await ssh.execCommand(`cd /root/mme/config && ln -sfn ${q(name)} ${q(`${role}.cfg`)} && ls -la ${q(`${role}.cfg`)}`);
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || `ln exit ${r.code}`);
      });
      stamp(`cfg-link:${role}`, true, `${role}.cfg → ${name}`, t0);
    }
  } catch (e: any) {
    steps.push({ step: 'cfg-link', ok: false, detail: e?.message ?? String(e), durationMs: 0 });
    return { ok: false, steps };
  }

  const t0 = Date.now();
  try {
    await withSsh(callbox, async (ssh) => {
      const r = await ssh.execCommand('sudo service lte restart');
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || `restart exit ${r.code}`);
    });
    // Same 15s settle Automation Suite waits out before considering the
    // radio stack up — the enb/mme/ims processes need a moment to bind.
    await new Promise((r) => setTimeout(r, 15_000));
    stamp('cfg-restart', true, 'lte restarted (enb+mme+ims) + 15s settle', t0);
  } catch (e: any) {
    stamp('cfg-restart', false, e?.message ?? String(e), t0);
    return { ok: false, steps };
  }

  return { ok: true, steps };
}

/** What is CURRENTLY symlinked, for pre-filling a picker with today's state
 *  rather than a blank one. Best-effort — a read failure just means "unknown"
 *  for that role, never an error surfaced to the caller. */
export async function currentCfgLinks(callbox: InventorySystem): Promise<CfgSelection> {
  const read = async (path: string) => {
    try {
      const out = await readCommand(callbox, `readlink ${q(path)} 2>/dev/null || true`);
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const [enb, mme, ims] = await Promise.all([
    read('/root/enb/config/enb.cfg'),
    read('/root/mme/config/mme.cfg'),
    read('/root/mme/config/ims.cfg'),
  ]);
  return { enb, mme, ims };
}

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
  /** Basename of a file already in /root/enb/config, to become gnb.cfg.
   *  Separate slot from `enb`: boxes running LTE and NR side by side keep
   *  both links, and a single-stack box simply leaves this unset. */
  gnb?: string;
  /** Basename of a file already in /root/mme/config, to become mme.cfg. */
  mme?: string;
  /** Basename of a file already in /root/mme/config, to become mme2.cfg —
   *  the SECOND core, for two-core setups like the DISH/Boost roaming demo
   *  where mme.cfg serves the home PLMN and mme2.cfg the partner. Only has
   *  an effect when the box's ots.cfg declares an MME2 component. */
  mme2?: string;
  /** Basename of a file already in /root/mme/config, to become ims.cfg. */
  ims?: string;
}

/**
 * The UE database is deliberately NOT a field here.
 *
 * Unlike enb/gnb/mme/mme2/ims — each a symlink this module can repoint — the
 * subscriber DB is pulled in by an `include "<name>.cfg"` line INSIDE the MME
 * config (mme-dish.cfg includes dish-roaming-db.cfg). There is no ue_db.cfg
 * symlink convention on the callboxes: a survey of /root/mme/config found
 * twelve different DB files included by name and zero includes of a generic
 * ue_db.cfg.
 *
 * So the DB travels WITH the MME config you pick. Offering a separate
 * dropdown would mean rewriting an include line inside a shared config file —
 * mutating a file other setups also use. `ueDbFor()` below reports which DB a
 * given MME config pulls in, so a picker can show it rather than pretend to
 * set it.
 */

export interface CfgLinkStep {
  step: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** `ln -sfn <target> <dir>/<link>`, privileged, with an unprivileged fallback.
 *
 *  Written without `cd` on purpose. /root is 0700 on some callboxes, so
 *  `cd /root/enb/config && ln …` dies at the cd — the failure the suite
 *  reported as "bring-up failed: cd: /root/enb/config: Permission denied".
 *  Passing the link's absolute path sidesteps the directory entirely, while
 *  the target stays relative so the symlink itself is byte-identical to what
 *  the old command produced. `-n` keeps sudo non-interactive so a box without
 *  passwordless sudo falls through instead of hanging on a prompt.
 *
 *  `target` and `link` arrive already shell-quoted via q(). */
export function sudoLink(dir: string, target: string, link: string): string {
  const linkPath = `${dir}/${link.replace(/^'|'$/g, '')}`;
  const abs = q(linkPath);
  return `sudo -n ln -sfn ${target} ${abs} 2>/dev/null || ln -sfn ${target} ${abs}; `
    + `sudo -n ls -la ${abs} 2>/dev/null || ls -la ${abs}`;
}

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

  if (!sel.enb && !sel.gnb && !sel.mme && !sel.mme2 && !sel.ims) {
    return { ok: true, steps: [{ step: 'cfg-link', ok: true, detail: 'no files selected — nothing to link', durationMs: 0 }] };
  }

  try {
    if (sel.enb) {
      const t0 = Date.now();
      await withSsh(callbox, async (ssh) => {
        // Absolute link path + sudo, no `cd`. On a callbox with /root at 0700
        // the shell cannot even enter the directory, so `cd … && ln` failed
        // with "cd: /root/enb/config: Permission denied" before ln ever ran.
        // The target stays relative so the resulting symlink is unchanged.
        const r = await ssh.execCommand(sudoLink(`/root/enb/config`, q(sel.enb!), `'enb.cfg'`));
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || `ln exit ${r.code}`);
      });
      stamp('cfg-link:enb', true, `enb.cfg → ${sel.enb}`, t0);
    }
    if (sel.gnb) {
      const t0 = Date.now();
      await withSsh(callbox, async (ssh) => {
        const r = await ssh.execCommand(sudoLink(`/root/enb/config`, q(sel.gnb!), `'gnb.cfg'`));
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || `ln exit ${r.code}`);
      });
      stamp('cfg-link:gnb', true, `gnb.cfg → ${sel.gnb}`, t0);
    }
    for (const [role, name] of [['mme', sel.mme], ['mme2', sel.mme2], ['ims', sel.ims]] as const) {
      if (!name) continue;
      const t0 = Date.now();
      await withSsh(callbox, async (ssh) => {
        const r = await ssh.execCommand(sudoLink(`/root/mme/config`, q(name), q(`${role}.cfg`)));
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
    // Wait for the radio to actually be READY, not a fixed sleep.
    //
    // The old blind 15s was too short and produced the exact failure the DISH
    // runbook warns about — "do not start the test while the radio is
    // restarting, the UEs will fail to attach". Measured on the two-core
    // two-cell build: lte restarted 04:18:41, NG setup completed 04:19:02 —
    // 21s. The run triggered at 15s and attached 0/30 UEs.
    //
    // OTS rotates /tmp/gnb0.log on restart, so ANY setup response in the new
    // file is this bring-up's. Accept the NR (NGAP) or LTE (S1AP) marker.
    const ready = await waitForRadio(callbox);
    stamp('cfg-restart', ready.ok,
      `lte restarted — ${ready.detail}`, t0);
    if (!ready.ok) return { ok: false, steps };
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
      // sudo first: /root is 0700 on some callboxes (.122), where an
      // unprivileged readlink returns nothing and the caller concludes no cfg
      // is bound — when one is.
      const out = await readCommand(callbox, `sudo -n readlink ${q(path)} 2>/dev/null || readlink ${q(path)} 2>/dev/null || true`);
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const [enb, gnb, mme, mme2, ims] = await Promise.all([
    read('/root/enb/config/enb.cfg'),
    read('/root/enb/config/gnb.cfg'),
    read('/root/mme/config/mme.cfg'),
    read('/root/mme/config/mme2.cfg'),
    read('/root/mme/config/ims.cfg'),
  ]);
  return { enb, gnb, mme, mme2, ims };
}

/**
 * Which subscriber DB an MME config pulls in, by reading its `include` lines.
 *
 * The DB is not separately selectable (see the note on CfgSelection), so a
 * picker shows this as derived, read-only context: choose mme-dish.cfg and
 * you get dish-roaming-db.cfg with it. Commented-out includes are ignored —
 * the configs on the box carry several of those as history.
 *
 * Best-effort: returns [] if the file can't be read, never throws.
 */
export async function ueDbFor(callbox: InventorySystem, mmeCfgName: string): Promise<string[]> {
  try {
    const path = `/root/mme/config/${mmeCfgName}`;
    const out = await readCommand(
      callbox,
      `sudo -n grep -E '^[[:space:]]*include' ${q(path)} 2>/dev/null || grep -E '^[[:space:]]*include' ${q(path)} 2>/dev/null || true`,
    );
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('include'))
      .map((l) => /include\s+"([^"]+)"/.exec(l)?.[1])
      .filter((n): n is string => !!n)
      // Only the subscriber/PLMN databases, not every include (configs also
      // pull in 1000UE.mme.cfg-style fragments).
      .filter((n) => /db|subscriber|ue/i.test(n));
  } catch {
    return [];
  }
}

/** How long to wait for the radio to report a completed setup before giving
 *  up. Generous: a two-core build takes ~21s, a cold SDR can take longer. */
const RADIO_READY_TIMEOUT_MS = 120_000;
const RADIO_POLL_MS = 3_000;
/**
 * Extra settle after the core setup completes, before we let a testcase fire.
 *
 * Measured on the two-core DISH build: `lte` restarted at 04:28:01, NG setup
 * completed ~21s later, but the first UE did not register until 04:29:04 —
 * 63s after the restart. Triggering at ~20s produced either 0/30 attached or
 * a 500 "failed to start UE" from the simulator. 40s past NG setup lands
 * safely past that window without padding every run unnecessarily.
 */
const RADIO_SETTLE_MS = 40_000;

/**
 * Poll the gNB log until it reports a completed setup with the core(s).
 *
 * Returns ok:false rather than throwing so the caller records a failed step
 * with a readable reason instead of a stack trace — and, importantly, does
 * NOT trigger a testcase into a radio that never came up.
 */
async function waitForRadio(callbox: InventorySystem): Promise<{ ok: boolean; detail: string }> {
  const started = Date.now();
  let lastErr = '';
  while (Date.now() - started < RADIO_READY_TIMEOUT_MS) {
    try {
      const out = await readCommand(
        callbox,
        `sudo -n grep -c -E "NG setup response|S1 setup response" /tmp/gnb0.log 2>/dev/null `
        + `|| grep -c -E "NG setup response|S1 setup response" /tmp/gnb0.log 2>/dev/null || echo 0`,
      );
      // Last line only: the sudo/non-sudo fallback can emit two counts.
      const parts = out.trim().split(String.fromCharCode(10));
      const n = parseInt((parts[parts.length - 1] || '0').trim(), 10);
      if (n > 0) {
        await new Promise((r) => setTimeout(r, RADIO_SETTLE_MS));
        const waited = Math.round((Date.now() - started) / 1000);
        return { ok: true, detail: `${n} core setup response(s) after ${waited}s, +${RADIO_SETTLE_MS / 1000}s settle` };
      }
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
    await new Promise((r) => setTimeout(r, RADIO_POLL_MS));
  }
  return {
    ok: false,
    detail: `radio did not report a completed core setup within ${RADIO_READY_TIMEOUT_MS / 1000}s`
      + `${lastErr ? ` (last read error: ${lastErr})` : ''} — refusing to trigger into a restarting radio`,
  };
}

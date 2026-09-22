// May this run re-point the callbox's config and restart LTE?
//
// Every user of a multi-user Simnovator shares its callbox: on .95, simuser,
// sruthi and mohan all run through 192.168.1.107. Applying a config means
// symlinking enb.cfg/mme.cfg/ims.cfg and `service lte restart` — and that
// restart takes the radio down under EVERY execution on the callbox, not just
// the caller's. One person picking a different config would kill the other
// two people's tests.
//
// So a bring-up is decided, not assumed:
//
//   • nothing to apply              → none
//   • what was picked is already    → unchanged (no restart — it would change
//     linked                          nothing but still drop every attached UE)
//   • someone else is executing     → blocked: the caller either waits, or runs
//                                      on the config that is already linked
//   • otherwise                     → link-restart, as before
//
// Pure, imports nothing, so node --test can load it directly.

export interface CfgPick {
  enb?: string;
  gnb?: string;
  mme?: string;
  mme2?: string;
  ims?: string;
}

/** Someone else's execution on the same callbox. */
export interface OtherExecution {
  user?: string;
  testcaseName?: string;
  simulator?: string;
  /** 'executing' — the box reports it running; 'starting' — a SimQA run that
   *  has not triggered yet but is about to use the callbox. */
  state?: 'executing' | 'starting';
}

export type BringUp =
  | { action: 'none' }
  | { action: 'unchanged'; current: CfgPick }
  | { action: 'blocked'; changes: string[]; others: OtherExecution[]; current: CfgPick }
  | { action: 'link-restart'; changes: string[] };

const ROLES = ['enb', 'gnb', 'mme', 'mme2', 'ims'] as const;

const base = (p?: string) => (p ?? '').split('/').filter(Boolean).pop() ?? '';

/** Roles whose picked file differs from what is linked now, as "enb.cfg: a → b". */
export function cfgChanges(pick: CfgPick | undefined, current: CfgPick | undefined): string[] {
  const out: string[] = [];
  for (const r of ROLES) {
    const want = pick?.[r];
    if (!want) continue;
    const have = current?.[r];
    // By file name: a link may have been made with an absolute target
    // (/root/enb/config/x.cfg) or a bare one (x.cfg) — the same file.
    if (base(want) !== base(have)) out.push(`${r}.cfg: ${have ?? '(none)'} → ${want}`);
  }
  return out;
}

export function decideBringUp(
  pick: CfgPick | undefined,
  current: CfgPick | undefined,
  others: OtherExecution[],
): BringUp {
  if (!pick || !ROLES.some((r) => pick[r])) return { action: 'none' };
  const changes = cfgChanges(pick, current);
  if (changes.length === 0) return { action: 'unchanged', current: current ?? {} };
  if (others.length > 0) return { action: 'blocked', changes, others, current: current ?? {} };
  return { action: 'link-restart', changes };
}

/** "sruthi (sample on UE-Simulator-2), mohan (starting)" — for messages. */
export function describeOthers(others: OtherExecution[]): string {
  return others.map((o) => {
    const who = o.user ?? 'another user';
    const what = [o.testcaseName, o.simulator ? `on ${o.simulator}` : ''].filter(Boolean).join(' ');
    const bits = [what, o.state === 'starting' ? 'starting' : ''].filter(Boolean).join(', ');
    return bits ? `${who} (${bits})` : who;
  }).join(', ');
}

/** "enb.cfg → a, mme.cfg → b" — the config a shared run will use. */
export function describeCfg(current: CfgPick | undefined): string {
  const parts = ROLES.filter((r) => current?.[r]).map((r) => `${r}.cfg → ${current![r]}`);
  return parts.length ? parts.join(', ') : 'whatever is currently linked';
}

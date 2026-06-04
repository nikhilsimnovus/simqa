// Execute a test case briefly so the UE-sim writes ue.cfg, then retrieve it
// over SSH. No callbox is required: ue.cfg is written at execution start and
// lteue accepts-or-rejects the config regardless of whether a cell attaches.
// We pre-delete the remote ue.cfg so a stale file from a previous case can
// never be mistaken for the current one, and we ALWAYS stop the execution in
// finally (the box enforces a system-wide execution mutex).

import { startExecution, stopExecution, getTestcase } from '../uesimClient';
import { readRemoteFile, readCommand, withSsh } from './ssh';
import type { InventorySystem } from '../inventory';
import type { ApiOpts } from './testCreator';
import type { UeCfg } from './types';
import type { RuntimeSignals } from './validate';

export const UE_CFG_PATH_DEFAULT = '/root/ue/config/ue.cfg';

export interface GenerateResult {
  ueCfg?: UeCfg;
  rawUeCfg?: string;
  executionId?: string;
  signals: RuntimeSignals;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Best-effort delete of the remote ue.cfg so we only read a freshly generated one. */
async function removeRemote(sys: InventorySystem, p: string): Promise<void> {
  const pwd = sys.sudoPassword ?? (sys.authMode !== 'privateKey' ? sys.password : '') ?? '';
  const sudo = pwd ? `printf '%s\\n' '${pwd.replace(/'/g, "'\\''")}' | sudo -S -p '' ` : 'sudo -n ';
  await withSsh(sys, (ssh) => ssh.execCommand(`${sudo}rm -f '${p.replace(/'/g, "'\\''")}'`)).catch(() => {});
}

/** Remote mtime in epoch seconds (0 if absent). Used to detect a freshly
 *  regenerated ue.cfg even when we lack write permission to delete the old one. */
async function remoteMtime(sys: InventorySystem, p: string): Promise<number> {
  const out = await readCommand(sys, `stat -c %Y '${p.replace(/'/g, "'\\''")}' 2>/dev/null`).catch(() => '');
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export async function generateAndRetrieveUeCfg(params: {
  api: ApiOpts;
  ueSimSystem: InventorySystem;
  testCaseId: string;
  simulatorId?: string;
  ueCfgPath?: string;
  pollTimeoutMs?: number;
}): Promise<GenerateResult> {
  const { api, ueSimSystem, testCaseId } = params;
  const cfgPath = params.ueCfgPath ?? UE_CFG_PATH_DEFAULT;
  const timeout = params.pollTimeoutMs ?? 90_000;
  const signals: RuntimeSignals = { ueCfgPresent: false };
  let executionId: string | undefined;
  let rawUeCfg: string | undefined;

  // 0. Best-effort delete + record the current mtime so we only accept a
  //    FRESHLY regenerated ue.cfg (robust even without write perms to rm).
  await removeRemote(ueSimSystem, cfgPath);
  const mtime0 = await remoteMtime(ueSimSystem, cfgPath);

  // 1. Fire the execution start but DO NOT block on it. On this box `start`
  //    is slow (~30s — it deploys the cfg to the UE-sim and launches lteue),
  //    and ue.cfg is written DURING start, frequently before the HTTP call
  //    returns. So we kick it off and detect the regenerated ue.cfg by mtime.
  const startP = startExecution(api, testCaseId, {})
    .catch((e: any) => { signals.executionDetail = `start: ${e?.message ?? e}`; });

  // 2. Poll for ue.cfg to be (re)generated (mtime advances), plus a light
  //    best-effort metadata read for execution id/status.
  const t0 = Date.now();
  let metaTries = 0;
  try {
    while (Date.now() - t0 < timeout) {
      await sleep(2500);
      const mt = await remoteMtime(ueSimSystem, cfgPath).catch(() => 0);
      if (mt > mtime0) {
        const raw = await readRemoteFile(ueSimSystem, cfgPath).catch(() => undefined);
        if (raw && raw.trim()) { rawUeCfg = raw; break; }
      }
      if (metaTries++ % 3 === 0) {
        try {
          const tc = await getTestcase(api, testCaseId);
          const last: any = (tc.metadata as any)?.lastExecution;
          if (last?.executionId) executionId = last.executionId;
          if (last?.status) signals.executionStatus = last.status;
          if (last?.result) signals.executionResult = last.result;
          if (last?.execution_result_details || last?.statusDetail) signals.executionDetail = last.execution_result_details ?? last.statusDetail;
        } catch { /* keep polling */ }
      }
    }
  } finally {
    // 3. Let the start settle briefly, then ALWAYS stop (system-wide mutex).
    await Promise.race([startP, sleep(2000)]);
    await stopExecution(api, executionId ?? 'current', params.simulatorId).catch(() => {});
  }

  // 4. Log tail for config-error scanning (best-effort).
  signals.logTail = await readCommand(
    ueSimSystem,
    'tail -n 120 /tmp/*.log 2>/dev/null; tail -n 120 /root/ue/logs/ots.log 2>/dev/null',
  ).catch(() => '');

  if (!rawUeCfg) return { signals, executionId };

  signals.ueCfgPresent = true;
  let ueCfg: UeCfg | undefined;
  try { ueCfg = JSON.parse(rawUeCfg); }
  catch (e: any) { signals.ueCfgParseError = e?.message ?? String(e); }
  return { ueCfg, rawUeCfg, executionId, signals };
}

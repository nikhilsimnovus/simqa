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
  const timeout = params.pollTimeoutMs ?? 60_000;
  const signals: RuntimeSignals = { ueCfgPresent: false };
  let executionId: string | undefined;
  let rawUeCfg: string | undefined;

  // 0. Pre-clean stale cfg.
  await removeRemote(ueSimSystem, cfgPath);

  // 1. Start execution.
  try {
    await startExecution(api, testCaseId, {});
  } catch (e: any) {
    signals.executionDetail = `start failed: ${e?.message ?? e}`;
    return { signals };
  }

  // 2. Poll metadata + for the ue.cfg file to (re)appear.
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < timeout) {
      await sleep(3000);
      try {
        const tc = await getTestcase(api, testCaseId);
        const last: any = (tc.metadata as any)?.lastExecution;
        if (last?.executionId) executionId = last.executionId;
        if (last?.status) signals.executionStatus = last.status;
        if (last?.result) signals.executionResult = last.result;
        if (last?.execution_result_details || last?.statusDetail) signals.executionDetail = last.execution_result_details ?? last.statusDetail;
      } catch { /* keep polling */ }
      const raw = await readRemoteFile(ueSimSystem, cfgPath).catch(() => undefined);
      if (raw && raw.trim()) { rawUeCfg = raw; break; }
    }
  } finally {
    // 3. ALWAYS stop (mutex). Prefer explicit eid, fall back to "current".
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

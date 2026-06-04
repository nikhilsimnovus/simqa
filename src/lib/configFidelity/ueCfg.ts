// Execute a test case briefly so the UE-sim writes ue.cfg, then retrieve it
// over SSH. No callbox is required: ue.cfg is written at execution start and
// lteue accepts-or-rejects the config regardless of whether a cell attaches.
// We pre-delete the remote ue.cfg so a stale file from a previous case can
// never be mistaken for the current one, and we ALWAYS stop the execution in
// finally (the box enforces a system-wide execution mutex).

import { stopExecution, getTestcase, ensureToken } from '../uesimClient';
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

/** Extract the testcase name encoded in ue.cfg's log_filename (/tmp/<name>.log). */
function ueCfgLogName(raw: string): string | undefined {
  const m = raw.match(/"log_filename"\s*:\s*"([^"]+)"/);
  if (!m) return undefined;
  return m[1].split('/').pop()?.replace(/\.log$/, '');
}

export async function generateAndRetrieveUeCfg(params: {
  api: ApiOpts;
  ueSimSystem: InventorySystem;
  testCaseId: string;
  simulatorId?: string;
  ueCfgPath?: string;
  pollTimeoutMs?: number;
  /** Unique testcase name we set in settings. We ONLY accept a ue.cfg whose
   *  log_filename matches this — guarantees we read THIS case's cfg, not a
   *  previous case's late-written one (executions overlap otherwise). */
  expectedName?: string;
}): Promise<GenerateResult> {
  const { api, ueSimSystem, testCaseId } = params;
  const cfgPath = params.ueCfgPath ?? UE_CFG_PATH_DEFAULT;
  const timeout = params.pollTimeoutMs ?? 90_000;
  const signals: RuntimeSignals = { ueCfgPresent: false };
  let executionId: string | undefined;
  let rawUeCfg: string | undefined;

  await removeRemote(ueSimSystem, cfgPath);

  // 1. Fire the execution start WITHOUT blocking. On this box `start` holds the
  //    HTTP connection ~120s, but ue.cfg is written to the UE-sim ~30s in. We
  //    poll for it and rely on the log_filename gate (below) for correctness,
  //    so we don't pay the full start latency on every case.
  // The box holds the start connection open ~120s. We don't need its response
  // (the box has already received + begun the execution by the time ue.cfg is
  // written), so we make it abortable and free the socket in finally — without
  // this, held-open start fetches pile up and exhaust the connection pool
  // ("fetch failed") over a long run.
  const startAbort = new AbortController();
  const startP = (async () => {
    const tok = await ensureToken(api.host, api.username, api.password);
    await fetch(`http://${api.host}/v2/testcases/${encodeURIComponent(testCaseId)}/executions`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: '{}', signal: startAbort.signal,
    });
  })().catch((e: any) => { if (e?.name !== 'AbortError') signals.executionDetail = `start: ${e?.message ?? e}`; });
  void startP;

  // 2. Poll until we have a ue.cfg that BELONGS to this case — its log_filename
  //    must match this case's unique name. This is what prevents accepting a
  //    previous case's late-written cfg (executions overlap otherwise).
  const t0 = Date.now();
  let metaTries = 0;
  try {
    while (Date.now() - t0 < timeout) {
      const raw = await readRemoteFile(ueSimSystem, cfgPath).catch(() => undefined);
      if (raw && raw.trim()) {
        const name = ueCfgLogName(raw);
        if (!params.expectedName || name === params.expectedName) { rawUeCfg = raw; break; }
        // else: stale/previous case's cfg — keep waiting for ours.
      }
      await sleep(2500);
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
    // 3. Free the held-open start socket, then ALWAYS stop the execution
    //    (system-wide mutex) so the next case can start clean.
    try { startAbort.abort(); } catch { /* ignore */ }
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

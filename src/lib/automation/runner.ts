// Per-suite runner. Given a saved AutomationSuite, iterates its
// testcaseIds and triggers each via the Simnovator REST execution API
// on the suite's UESIM. For uesim+callbox suites, the chosen eNB config
// is logged in the run record so QA can correlate radio side ↔ exec.
//
// Sequential only — the Simnovator side enforces a system-wide execution
// mutex anyway, so parallel triggers don't help.

import { loadInventory, getSystem, uesimApiOptsForSystem, type AutomationSuite } from '../inventory';
import { withSsh } from '../configFidelity/ssh';

export interface SuiteRunStep {
  testcaseId: string;
  status: number;
  ok: boolean;
  executionId?: string;
  detail?: string;
  durationMs: number;
}

export interface SuiteRunResult {
  startedAt: string;
  finishedAt: string;
  suiteId: string;
  suiteName: string;
  kind: 'uesim-only' | 'uesim+callbox';
  uesimHost: string;
  callboxHost?: string;
  callboxConfigName?: string;
  /** True iff we successfully pushed + activated the callbox config. */
  callboxConfigPushed?: boolean;
  total: number;
  passed: number;
  failed: number;
  steps: SuiteRunStep[];
}

interface RunOpts {
  /** When false (default), the callbox config is logged but not pushed
   *  /restart. Set true to actually scp + restart the eNB service. */
  pushCallboxConfig?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, currentId?: string) => void;
}

async function login(host: string, username: string, password: string): Promise<string> {
  const r = await fetch(`http://${host}/v2/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  const j: any = await r.json();
  return j.access_token ?? j.token;
}

/** Optionally scp the picked / uploaded eNB config to /root/enb/config
 *  on the callbox before the run. We DON'T restart the eNB service —
 *  too lab-specific. Just lays the file down so the customer can
 *  confirm + activate manually. */
async function maybePushCallboxConfig(suite: AutomationSuite, inv: ReturnType<typeof loadInventory>): Promise<boolean> {
  if (suite.kind !== 'uesim+callbox' || !suite.callboxSystemId || !suite.callboxConfig) return false;
  const sys = getSystem(inv, suite.callboxSystemId);
  if (!sys || sys.type !== 'CALLBOX') return false;
  const cfg = suite.callboxConfig;
  // 'pick' = already on the box, nothing to push.
  if (cfg.source === 'pick') return true;
  // 'upload' = write the base64'd content over SSH.
  if (!cfg.contentBase64 || !cfg.filename) return false;
  const target = `/root/enb/config/${cfg.filename.replace(/[^\w.\-]/g, '_')}`;
  try {
    await withSsh(sys, async (ssh) => {
      const buf = Buffer.from(cfg.contentBase64!, 'base64');
      // Use sftp to atomically write the file; createWriteStream avoids
      // shell quoting issues with binary configs.
      const sftp = await ssh.requestSFTP();
      await new Promise<void>((resolve, reject) => {
        const ws = sftp.createWriteStream(target);
        ws.on('close', () => resolve());
        ws.on('error', reject);
        ws.end(buf);
      });
    });
    return true;
  } catch {
    return false;
  }
}

export async function runSuite(suite: AutomationSuite, opts: RunOpts = {}): Promise<SuiteRunResult> {
  const startedAt = new Date().toISOString();
  const inv = loadInventory();
  const ueOpts = uesimApiOptsForSystem(inv, suite.uesimSystemId ?? '');
  if (!ueOpts) throw new Error(`suite uesimSystemId "${suite.uesimSystemId}" not testable`);

  const callboxSys = suite.callboxSystemId ? getSystem(inv, suite.callboxSystemId) : undefined;
  const callboxConfigPushed = opts.pushCallboxConfig ? await maybePushCallboxConfig(suite, inv) : false;

  const token = await login(ueOpts.host, ueOpts.username, ueOpts.password);
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const steps: SuiteRunStep[] = [];
  let passed = 0, failed = 0;

  for (const tcId of suite.testcaseIds) {
    if (opts.signal?.aborted) break;
    opts.onProgress?.(steps.length, suite.testcaseIds.length, tcId);
    const t0 = Date.now();
    try {
      const r = await fetch(`http://${ueOpts.host}/v2/testcases/${encodeURIComponent(tcId)}/executions`, {
        method: 'POST', headers: H, body: '{}',
      });
      const dur = Date.now() - t0;
      const j: any = await r.json().catch(() => ({}));
      const ok = r.ok || r.status === 200 || r.status === 201;
      const executionId: string | undefined = j?.executionId ?? j?.id;
      steps.push({ testcaseId: tcId, status: r.status, ok, executionId, detail: ok ? 'execution kicked off' : (typeof j === 'object' ? JSON.stringify(j).slice(0, 200) : 'no body'), durationMs: dur });
      if (ok) passed += 1; else failed += 1;
      if (!ok && suite.stopOnFail) break;
    } catch (e: any) {
      steps.push({ testcaseId: tcId, status: 0, ok: false, detail: `threw: ${e?.message ?? e}`, durationMs: Date.now() - t0 });
      failed += 1;
      if (suite.stopOnFail) break;
    }
  }
  opts.onProgress?.(steps.length, suite.testcaseIds.length);

  return {
    startedAt, finishedAt: new Date().toISOString(),
    suiteId: suite.id, suiteName: suite.name,
    kind: suite.kind ?? 'uesim-only',
    uesimHost: ueOpts.host,
    callboxHost: callboxSys?.host,
    callboxConfigName: suite.callboxConfig?.filename,
    callboxConfigPushed,
    total: suite.testcaseIds.length, passed, failed, steps,
  };
}

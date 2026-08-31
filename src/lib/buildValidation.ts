// Build Validation — install a Simnovator build, then prove the box actually
// works before anyone trusts it.
//
// Four verification groups, each independently selectable:
//
//   reachable     every machine in the deployment answers (Simnovator, UE, App Server)
//   login         the management UI serves, and the REST credentials are accepted
//   sample-tests  the box's sample tests are present for this build
//   run-tests     a 5G and an LTE testcase execute to completion on real hardware
//
// Design notes worth knowing before changing anything here:
//
// • Every group returns a structured result with its own sub-steps rather than
//   a single boolean. "Login failed" is useless on its own — the operator needs
//   to know whether the UI was down, the credentials were wrong, or it timed
//   out, and those are three different jobs to go and do.
//
// • Nothing throws. A validation run that dies halfway tells you less than one
//   that reports which step died, so every probe resolves to a FAIL with a
//   reason instead of rejecting.
//
// • The install itself is NOT executed from here. The build is installed by
//   pasting the generated commands into the Cockpit terminal on the install
//   host — SimQA has no SSH credentials for these machines (inventory.yaml
//   carries none), so it cannot run or watch the installer. Install progress
//   is therefore *observed*, not driven: see observeInstallProgress().

import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Inventory, InventorySystem } from './inventory';
import { getSystem, uesimApiOptsForSystem } from './inventory';
import { fetchBoxBuild } from './buildVersion';
import { appendHistoryEntry } from './historyStore';

export type StepStatus = 'pass' | 'fail' | 'skip' | 'running' | 'pending';

export interface Step {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  /** Operator-facing "what should have happened", shown on failure. */
  expected?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface CheckGroup {
  id: VerificationId;
  label: string;
  status: StepStatus;
  detail?: string;
  steps: Step[];
}

export type VerificationId = 'reachable' | 'login' | 'sample-tests' | 'run-tests';

export const VERIFICATION_LABELS: Record<VerificationId, string> = {
  'reachable':    'Simnovator Reachable',
  'login':        'Able to Login',
  'sample-tests': 'Sample Tests Available',
  'run-tests':    'Run Test Cases',
};

export interface BuildValidationRequest {
  /** Simnovator (SIMNOVATOR / SIMNOVATOR_GUI) system id — required. */
  systemId: string;
  /** Which verification groups to run. */
  checks: VerificationId[];
  /** Inventory ids of the machines that took part in the install, used by the
   *  reachability group. Optional: a validate-only run may not involve them. */
  ueSystemId?: string;
  appServerSystemId?: string;
  /** Install context, recorded on the report when this run followed an install. */
  install?: {
    buildUrl?: string;
    skipFlags?: string[];
    commands?: string[];
  };
  /** Testcase ids for the run-tests group. Resolved by name when omitted. */
  fiveGTestcaseId?: string;
  lteTestcaseId?: string;
}

export interface BuildValidationReport {
  id: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  status: 'running' | 'passed' | 'failed';
  systemId: string;
  systemName?: string;
  host: string;
  buildVersion?: string;
  ueSystemId?: string;
  ueHost?: string;
  appServerSystemId?: string;
  appServerHost?: string;
  install?: BuildValidationRequest['install'];
  selectedChecks: VerificationId[];
  groups: CheckGroup[];
}

const REPORT_DIR = path.join(process.cwd(), 'data', 'build-validation');

// ───────────────────────── reachability ─────────────────────────

/** ICMP via the system `ping`. Portable across the Windows and Linux hosts
 *  SimQA runs on; Node has no ICMP of its own without a native module. */
function icmpPing(host: string, timeoutMs = 4000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const args = isWin
      ? ['-n', '1', '-w', String(timeoutMs), host]
      : ['-c', '1', '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), host];
    let out = '';
    let settled = false;
    const done = (r: { ok: boolean; detail: string }) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const p = spawn('ping', args, { windowsHide: true });
      p.stdout.on('data', (d) => { out += String(d); });
      p.stderr.on('data', (d) => { out += String(d); });
      p.on('error', () => done({ ok: false, detail: 'ping unavailable on this host' }));
      p.on('close', (code) => {
        // Windows' ping exits 0 even when it prints "Destination host
        // unreachable" / "Request timed out", so the exit code alone is not
        // enough — the output has to be checked too.
        const badText = /unreachable|timed out|100% (packet )?loss|could not find host/i.test(out);
        const rtt = out.match(/time[=<]\s*([\d.]+)\s*ms/i);
        if (code === 0 && !badText) done({ ok: true, detail: rtt ? `reply in ${rtt[1]} ms` : 'reply received' });
        else done({ ok: false, detail: (out.trim().split(/\r?\n/).find((l) => /unreachable|timed out|loss|not find/i.test(l)) ?? `ping exited ${code}`).trim().slice(0, 140) });
      });
      setTimeout(() => { try { p.kill(); } catch { /* already gone */ } done({ ok: false, detail: `no ICMP reply within ${timeoutMs} ms` }); }, timeoutMs + 1500);
    } catch {
      done({ ok: false, detail: 'ping unavailable on this host' });
    }
  });
}

/** TCP connect, used as corroboration when ICMP is filtered — a machine that
 *  serves a port is plainly reachable regardless of what ICMP says. */
function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; try { s.destroy(); } catch { /* noop */ } resolve(v); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    try { s.connect(port, host); } catch { done(false); }
  });
}

/** One machine's reachability. ICMP first (that is what the operator means by
 *  "ping"), then a TCP fallback so an environment that filters ICMP does not
 *  produce a false FAIL on a machine that is demonstrably serving traffic. */
async function reachOne(label: string, host: string | undefined, ports: number[]): Promise<Step> {
  const id = `reach-${label.toLowerCase().replace(/\s+/g, '-')}`;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  if (!host) {
    return { id, label, status: 'skip', detail: 'not selected for this run', startedAt, finishedAt: new Date().toISOString(), durationMs: 0 };
  }
  const ping = await icmpPing(host);
  if (ping.ok) {
    return { id, label, status: 'pass', detail: `${host} — ${ping.detail}`, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0 };
  }
  for (const port of ports) {
    if (await tcpProbe(host, port)) {
      return {
        id, label, status: 'pass',
        detail: `${host} — no ICMP reply (${ping.detail}), but TCP :${port} accepted the connection, so the machine is up and ICMP is filtered`,
        startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
      };
    }
  }
  return {
    id, label, status: 'fail',
    detail: `${host} — ${ping.detail}; no response on TCP ${ports.join('/')} either`,
    expected: `${label} answers ICMP, or accepts a TCP connection on ${ports.join(' / ')}`,
    startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
  };
}

async function groupReachable(sim: InventorySystem, ue?: InventorySystem, app?: InventorySystem): Promise<CheckGroup> {
  const steps = await Promise.all([
    reachOne('Simnovator', sim.host, [80, 443, 9090]),
    reachOne('UE', ue?.host, [22, 80, 9090]),
    reachOne('App Server', app?.host, [22, 80, 9090]),
  ]);
  const failed = steps.filter((s) => s.status === 'fail');
  const checked = steps.filter((s) => s.status !== 'skip');
  return {
    id: 'reachable',
    label: VERIFICATION_LABELS['reachable'],
    status: failed.length ? 'fail' : 'pass',
    detail: failed.length
      ? `${failed.length} of ${checked.length} machine(s) unreachable: ${failed.map((f) => f.label).join(', ')}`
      : `${checked.map((s) => s.label).join(', ')} reachable`,
    steps,
  };
}

// ───────────────────────── login ─────────────────────────

async function groupLogin(host: string, username: string, password: string): Promise<CheckGroup> {
  const steps: Step[] = [];
  const mk = (id: string, label: string): { step: Step; t0: number } => {
    const step: Step = { id, label, status: 'running', startedAt: new Date().toISOString() };
    return { step, t0: Date.now() };
  };
  const seal = (s: Step, t0: number, status: StepStatus, detail: string, expected?: string): Step => {
    s.status = status; s.detail = detail; s.expected = expected;
    s.finishedAt = new Date().toISOString(); s.durationMs = Date.now() - t0;
    return s;
  };

  // 1. The management UI serves its shell.
  const a = mk('login-ui', 'Simnovator UI accessible');
  try {
    const r = await fetch(`http://${host}/`, { signal: AbortSignal.timeout(10_000) });
    const body = await r.text();
    const isSpa = /<div id="root"|Simnovator/i.test(body);
    seal(a.step, a.t0, r.ok && isSpa ? 'pass' : 'fail',
      r.ok && isSpa ? `HTTP ${r.status} — management UI served` : `HTTP ${r.status}${isSpa ? '' : ' and the response is not the Simnovator UI'}`,
      'GET http://<host>/ returns 200 with the Simnovator SPA shell');
  } catch (e: any) {
    seal(a.step, a.t0, 'fail', `UI unavailable: ${e?.name === 'TimeoutError' ? 'timed out after 10s' : (e?.message ?? String(e))}`,
      'GET http://<host>/ returns 200 with the Simnovator SPA shell');
  }
  steps.push(a.step);

  // 2. The configured credentials are accepted.
  const b = mk('login-rest', 'Login successful');
  if (a.step.status !== 'pass') {
    seal(b.step, b.t0, 'skip', 'not attempted — the UI did not serve, so a credential result would be meaningless');
  } else {
    try {
      const r = await fetch(`http://${host}/v2/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(15_000),
      });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && j?.access_token) seal(b.step, b.t0, 'pass', `authenticated as "${username}"`);
      else if (r.status === 401 || r.status === 403) seal(b.step, b.t0, 'fail', `invalid credentials for "${username}" (HTTP ${r.status}${j?.message ? ` — ${j.message}` : ''})`, 'POST /v2/login returns 200 with an access_token');
      else seal(b.step, b.t0, 'fail', `HTTP ${r.status}${j?.message ? ` — ${j.message}` : ''}`, 'POST /v2/login returns 200 with an access_token');
    } catch (e: any) {
      seal(b.step, b.t0, 'fail', e?.name === 'TimeoutError' ? 'login timed out after 15s' : (e?.message ?? String(e)), 'POST /v2/login returns 200 with an access_token');
    }
  }
  steps.push(b.step);

  const failed = steps.some((s) => s.status === 'fail');
  return {
    id: 'login',
    label: VERIFICATION_LABELS['login'],
    status: failed ? 'fail' : 'pass',
    detail: failed ? (steps.find((s) => s.status === 'fail')?.detail ?? 'login failed') : 'Login successful',
    steps,
  };
}

// ───────────────────────── sample tests ─────────────────────────

/** A freshly-installed build ships sample testcases. There is no server-side
 *  "is sample" flag — the box ignores unknown query params and answers 200
 *  with the full list either way (verified 2026-08-27) — so they are
 *  identified by name, the same way the box's own Sample Tests page presents
 *  them. Matching is deliberately broad, because a build that ships them under
 *  a slightly different prefix should read as "found, named differently"
 *  rather than "missing". */
const SAMPLE_NAME = /^(sample|sample[-_ ])/i;

async function groupSampleTests(host: string, token: string | undefined): Promise<CheckGroup> {
  const steps: Step[] = [];
  const t0 = Date.now();
  const startedAt = new Date().toISOString();

  if (!token) {
    const s: Step = { id: 'sample-list', label: 'Sample Tests page accessible', status: 'skip', detail: 'no session — login must pass first', startedAt, finishedAt: new Date().toISOString() };
    return { id: 'sample-tests', label: VERIFICATION_LABELS['sample-tests'], status: 'skip', detail: 'skipped: could not authenticate', steps: [s] };
  }

  let names: string[] = [];
  let listOk = false;
  let listDetail = '';
  try {
    // Walk pages — `offset` is a PAGE INDEX on this API, not a row offset.
    for (let p = 0; p < 10; p++) {
      const r = await fetch(`http://${host}/v2/testcases?limit=50&offset=${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) { listDetail = `GET /v2/testcases returned HTTP ${r.status}`; break; }
      const j: any = await r.json();
      const items: any[] = j?.items ?? [];
      names.push(...items.map((x) => String(x?.name ?? '')));
      listOk = true;
      if (!items.length || names.length >= (j?.total ?? 0)) break;
    }
    if (listOk) listDetail = `catalogue readable — ${names.length} testcase(s)`;
  } catch (e: any) {
    listDetail = e?.name === 'TimeoutError' ? 'timed out reading the testcase catalogue' : (e?.message ?? String(e));
  }
  steps.push({
    id: 'sample-list', label: 'Sample Tests page accessible',
    status: listOk ? 'pass' : 'fail', detail: listDetail,
    expected: 'GET /v2/testcases returns the catalogue the Sample Tests page lists from',
    startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
  });

  const samples = names.filter((n) => SAMPLE_NAME.test(n));
  steps.push({
    id: 'sample-found', label: 'Expected sample tests found',
    status: !listOk ? 'skip' : samples.length > 0 ? 'pass' : 'fail',
    detail: !listOk ? 'catalogue unavailable'
      : samples.length > 0 ? `${samples.length} sample test(s): ${samples.slice(0, 6).join(', ')}${samples.length > 6 ? ` +${samples.length - 6} more` : ''}`
      : `no testcase name begins with "sample" among ${names.length} testcase(s) — this build shipped none, or they were removed`,
    expected: 'at least one sample testcase is present after a build install',
    startedAt, finishedAt: new Date().toISOString(),
  });

  const failed = steps.some((s) => s.status === 'fail');
  return {
    id: 'sample-tests',
    label: VERIFICATION_LABELS['sample-tests'],
    status: failed ? 'fail' : 'pass',
    detail: `${samples.length} sample test(s) detected of ${names.length} testcase(s)`,
    steps,
  };
}

// ───────────────────────── run test cases ─────────────────────────

/** Pick the testcase that best represents a RAT when the caller did not name
 *  one. Ordered patterns: the earlier one wins, so "one cell" beats a generic
 *  LTE match. Returns undefined rather than guessing wildly. */
function pickTestcase(all: Array<{ id: string; name: string }>, patterns: RegExp[]): { id: string; name: string } | undefined {
  for (const p of patterns) {
    const hit = all.find((t) => p.test(t.name));
    if (hit) return hit;
  }
  return undefined;
}

const FIVE_G_PATTERNS = [/5g[_\-\s]*single[_\-\s]*cell/i, /\b5g\b/i, /nr[_\-\s]*sa/i];
const LTE_PATTERNS = [/lte.*(one|1)[_\-\s]*cell/i, /lte[_\-\s]*1\b/i, /\blte\b/i];

async function executeOne(host: string, token: string, tc: { id: string; name: string }, label: string, maxWaitMs: number): Promise<Step> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const auth = { Authorization: `Bearer ${token}` };
  const fin = (status: StepStatus, detail: string, expected?: string): Step => ({
    id: `run-${label.toLowerCase().replace(/\s+/g, '-')}`, label, status, detail, expected,
    startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
  });
  try {
    // POST /v2/testcases/{id}/executions — plural. Starting an execution on
    // this box takes ~26s and proceeds even if the client stops listening, so
    // the timeout has to clear that. 409/503 mean the simulator is momentarily
    // busy rather than the request being wrong, so they are retried, matching
    // the proven helper in apiTester.ts.
    let start: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      start = await fetch(`http://${host}/v2/testcases/${encodeURIComponent(tc.id)}/executions`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(90_000),
      });
      if (start.status !== 409 && start.status !== 503) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 10_000));
    }
    if (!start || !start.ok) {
      const msg = start ? await start.text().catch(() => '') : '';
      return fin('fail', `could not start "${tc.name}": HTTP ${start?.status ?? '—'} ${msg.slice(0, 120)}`, 'the testcase starts and runs to a terminal status');
    }
    // Poll the testcase's lastExecution until terminal.
    const TERMINAL = new Set(['COMPLETED', 'FAILED', 'STOPPED', 'ABORTED', 'INCOMPLETE', 'PASSED']);
    const deadline = Date.now() + maxWaitMs;
    let status = '';
    let result = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const g = await fetch(`http://${host}/v2/testcases/${encodeURIComponent(tc.id)}`, { headers: auth, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!g || !g.ok) continue;
      const j: any = await g.json().catch(() => ({}));
      status = String(j?.metadata?.lastExecution?.status ?? '').toUpperCase();
      result = String(j?.metadata?.lastExecution?.result ?? '').toUpperCase();
      if (TERMINAL.has(status)) break;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!TERMINAL.has(status)) {
      return fin('fail', `"${tc.name}" did not finish within ${(maxWaitMs / 60000).toFixed(0)} min (last status ${status || 'unknown'}); ran ${secs}s`, 'the testcase reaches a terminal status inside the wait window');
    }
    // The box's own verdict is only ever "BLER <= 5%", which an empty run also
    // satisfies — so a PASS here means "it ran and the box was content", not
    // "traffic actually flowed". Said plainly rather than implied.
    const good = result === 'PASS' || result === 'PASSED' || (status === 'COMPLETED' && result !== 'FAIL');
    return fin(good ? 'pass' : 'fail',
      `"${tc.name}" — status ${status}${result ? `, result ${result}` : ''}, ran ${secs}s (box verdict only checks BLER ≤ 5%)`,
      'the testcase completes with a PASS verdict');
  } catch (e: any) {
    return fin('fail', `"${tc.name}" — ${e?.name === 'TimeoutError' ? 'request timed out' : (e?.message ?? String(e))}`, 'the testcase starts and runs to a terminal status');
  }
}

async function groupRunTests(host: string, token: string | undefined, req: BuildValidationRequest): Promise<CheckGroup> {
  if (!token) {
    return { id: 'run-tests', label: VERIFICATION_LABELS['run-tests'], status: 'skip', detail: 'skipped: could not authenticate', steps: [] };
  }
  // Resolve the two testcases.
  const all: Array<{ id: string; name: string }> = [];
  try {
    for (let p = 0; p < 10; p++) {
      const r = await fetch(`http://${host}/v2/testcases?limit=50&offset=${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) break;
      const j: any = await r.json();
      const items: any[] = j?.items ?? [];
      all.push(...items.map((x) => ({ id: String(x?.id ?? ''), name: String(x?.name ?? '') })));
      if (!items.length || all.length >= (j?.total ?? 0)) break;
    }
  } catch { /* handled below by the empty list */ }

  const byId = (id?: string) => (id ? all.find((t) => t.id === id) : undefined);
  const fiveG = byId(req.fiveGTestcaseId) ?? pickTestcase(all, FIVE_G_PATTERNS);
  const lte   = byId(req.lteTestcaseId)   ?? pickTestcase(all, LTE_PATTERNS);

  const steps: Step[] = [];
  // Strictly sequential: the box executes one testcase at a time, so starting
  // the second before the first finishes would 409 rather than queue.
  for (const [tc, label] of [[fiveG, '5G Test Case'], [lte, 'LTE One Cell Test Case']] as const) {
    if (!tc) {
      steps.push({
        id: `run-${label.toLowerCase().replace(/\s+/g, '-')}`, label, status: 'fail',
        detail: `no testcase on this box matches a ${label.startsWith('5G') ? '5G/NR-SA' : 'LTE one-cell'} name — pick one explicitly`,
        expected: 'a testcase representing this RAT exists on the box, or is named in the request',
      });
      continue;
    }
    steps.push(await executeOne(host, token, tc, label, 15 * 60_000));
  }

  const failed = steps.some((s) => s.status === 'fail');
  return {
    id: 'run-tests',
    label: VERIFICATION_LABELS['run-tests'],
    status: failed ? 'fail' : 'pass',
    detail: steps.map((s) => `${s.label}: ${s.status.toUpperCase()}`).join(' · '),
    steps,
  };
}

// ───────────────────────── orchestration ─────────────────────────

function saveReport(rep: BuildValidationReport): void {
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, `${rep.id}.json`), JSON.stringify(rep, null, 2));
  } catch (e: any) {
    console.error('[build-validation] could not save report:', e?.message ?? e);
  }
}

export function loadReport(id: string): BuildValidationReport | null {
  try { return JSON.parse(fs.readFileSync(path.join(REPORT_DIR, `${id}.json`), 'utf8')); }
  catch { return null; }
}

export function listReports(limit = 50): BuildValidationReport[] {
  try {
    if (!fs.existsSync(REPORT_DIR)) return [];
    return fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit)
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(REPORT_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean) as BuildValidationReport[];
  } catch { return []; }
}

export async function runBuildValidation(inv: Inventory, req: BuildValidationRequest): Promise<BuildValidationReport> {
  const sim = getSystem(inv, req.systemId);
  const startedAt = new Date().toISOString();
  const id = `bv-${startedAt.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;

  if (!sim) {
    const rep: BuildValidationReport = {
      id, startedAt, finishedAt: new Date().toISOString(), ok: false, status: 'failed',
      systemId: req.systemId, host: '', selectedChecks: req.checks, groups: [],
    };
    saveReport(rep);
    return rep;
  }

  const ue = req.ueSystemId ? getSystem(inv, req.ueSystemId) : undefined;
  const app = req.appServerSystemId ? getSystem(inv, req.appServerSystemId) : undefined;
  // Credentials via the shared resolver, which already knows the uesim → top
  // level → default fallback order used everywhere else.
  const creds = uesimApiOptsForSystem(inv, sim.id);
  const username = creds?.username ?? 'admin';
  const password = creds?.password ?? 'admin';

  const groups: CheckGroup[] = [];
  const want = new Set(req.checks);

  if (want.has('reachable')) groups.push(await groupReachable(sim, ue, app));

  // A token is needed by the two later groups; obtained once here so login is
  // not attempted three times.
  let token: string | undefined;
  if (want.has('login') || want.has('sample-tests') || want.has('run-tests')) {
    const g = await groupLogin(sim.host, username, password);
    if (want.has('login')) groups.push(g);
    if (g.status === 'pass') {
      try {
        const r = await fetch(`http://${sim.host}/v2/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15_000),
        });
        token = (await r.json())?.access_token;
      } catch { /* groups below report the skip */ }
    }
  }

  if (want.has('sample-tests')) groups.push(await groupSampleTests(sim.host, token));
  if (want.has('run-tests'))    groups.push(await groupRunTests(sim.host, token, req));

  const build = token ? await fetchBoxBuild(sim.host, token) : undefined;
  const finishedAt = new Date().toISOString();
  const ok = groups.length > 0 && groups.every((g) => g.status !== 'fail');

  const rep: BuildValidationReport = {
    id, startedAt, finishedAt, ok, status: ok ? 'passed' : 'failed',
    systemId: sim.id, systemName: sim.name, host: sim.host,
    buildVersion: build?.version,
    ueSystemId: ue?.id, ueHost: ue?.host,
    appServerSystemId: app?.id, appServerHost: app?.host,
    install: req.install,
    selectedChecks: req.checks,
    groups,
  };
  saveReport(rep);

  // Put it on the Run History timeline like every other surface.
  try {
    const passed = groups.filter((g) => g.status === 'pass').length;
    const failed = groups.filter((g) => g.status === 'fail').length;
    const skipped = groups.filter((g) => g.status === 'skip').length;
    appendHistoryEntry({
      surface: 'build-check',
      label: `Build Validation · ${ok ? 'PASSED' : 'FAILED'} · ${passed} pass / ${failed} fail`,
      startedAt, finishedAt,
      targetSystemId: sim.id, targetHost: sim.host,
      buildVersion: build?.version,
      total: groups.length, passed, failed, skipped,
      detailPath: `data/build-validation/${id}.json`,
      meta: { runId: id, buildUrl: req.install?.buildUrl },
    });
  } catch (e: any) {
    console.error('[build-validation] could not record history:', e?.message ?? e);
  }

  return rep;
}

// ───────────────────────── install progress ─────────────────────────

/** Install steps, in the order the installer performs them.
 *
 *  IMPORTANT: SimQA does not run the installer. The build is installed by
 *  pasting the generated commands into the Cockpit terminal, and inventory
 *  carries no SSH credentials for these machines, so there is nothing to
 *  stream. These steps are therefore inferred from what SimQA CAN observe
 *  from outside — the box going away and coming back on a new build — and the
 *  UI labels them as observed rather than reported. Inventing a live log we
 *  cannot see would be worse than saying so. */
export const INSTALL_STEPS: Array<{ id: string; label: string; observable: boolean }> = [
  { id: 'download',     label: 'Build download',          observable: false },
  { id: 'extract',      label: 'Build extraction',        observable: false },
  { id: 'started',      label: 'Installation started',    observable: true  },
  { id: 'simnovator',   label: 'Simnovator installation', observable: true  },
  { id: 'ue',           label: 'UE configuration',        observable: true  },
  { id: 'appserver',    label: 'App Server configuration', observable: true },
  { id: 'completed',    label: 'Installation completed',  observable: true  },
];

export interface InstallObservation {
  step: string;
  status: StepStatus;
  detail: string;
  at: string;
}

/** One poll of the observable install signals: is the box answering, and what
 *  build does it report? The caller drives this on a timer while the operator
 *  runs the installer in Cockpit. */
export async function observeInstallProgress(host: string, baselineBuild?: string): Promise<InstallObservation> {
  const at = new Date().toISOString();
  const up = await tcpProbe(host, 80, 2500);
  if (!up) return { step: 'simnovator', status: 'running', detail: `${host} is not serving yet — the installer is still working (the box goes down while it installs)`, at };
  try {
    const r = await fetch(`http://${host}/v2/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }), signal: AbortSignal.timeout(8_000),
    });
    const token = r.ok ? (await r.json())?.access_token : undefined;
    if (!token) return { step: 'simnovator', status: 'running', detail: `${host} is serving but not accepting logins yet`, at };
    const build = await fetchBoxBuild(host, token);
    if (build?.version && baselineBuild && build.version !== baselineBuild) {
      return { step: 'completed', status: 'pass', detail: `box is up on build ${build.version} (was ${baselineBuild})`, at };
    }
    if (build?.version && !baselineBuild) {
      return { step: 'completed', status: 'pass', detail: `box is up on build ${build.version}`, at };
    }
    return { step: 'started', status: 'running', detail: `box is up but still reporting the previous build (${build?.version ?? 'unknown'}) — install not finished`, at };
  } catch (e: any) {
    return { step: 'simnovator', status: 'running', detail: `${host} is serving but the API is not ready: ${e?.message ?? e}`, at };
  }
}

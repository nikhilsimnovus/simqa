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
//   host — SimQA does not drive that terminal session, so it cannot stream the
//   installer's own output here. Install progress is therefore *observed* from
//   outside, not driven: see observeInstallProgress(). (The Job Tracker DOES
//   install a build itself, via Cockpit automation in buildInstaller.ts; this
//   page is the manual path.)

import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Inventory, InventorySystem } from './inventory';
import { getSystem, uesimApiOptsForSystem } from './inventory';
import { linkAndRestart } from './labCfgLink';
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
  /**
   * Report id chosen by the caller, so it can poll this run's progress while
   * the POST is still open. The run publishes a partial report after every
   * group; without an agreed id the page cannot tell this run's partials from
   * the previous run's finished report. Sanitised before use — it becomes a
   * filename.
   */
  runId?: string;
}

export interface BuildValidationReport {
  id: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  status: 'running' | 'passed' | 'failed' | 'canceled';
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
  // Name each machine WITH its address. "Simnovator, UE, App Server reachable"
  // does not say which boxes were actually pinged, and on a lab with several
  // benches that is the first thing you need to know.
  const hostOfStep = (s: Step) =>
    s.label === 'Simnovator' ? sim.host : s.label === 'UE' ? ue?.host : app?.host;
  const withHost = (s: Step) => `${s.label} ${hostOfStep(s) ?? '(no host)'}`;
  return {
    id: 'reachable',
    label: VERIFICATION_LABELS['reachable'],
    status: failed.length ? 'fail' : 'pass',
    detail: failed.length
      ? `Could not reach ${failed.map(withHost).join(', ')} (${failed.length} of ${checked.length} machine(s))`
      : `Able to ping ${checked.map(withHost).join(', ')}`,
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
    // Say which box was logged into, since that is the fact being asserted.
    detail: failed
      ? (steps.find((s) => s.status === 'fail')?.detail ?? `Could not log in to ${host}`)
      : `Able to log in to ${host} — the configured credentials are accepted`,
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
    detail: failed
      ? `No sample test cases found among ${names.length} testcase(s) on the box`
      : `Verified sample test cases are present — ${samples.length} of ${names.length} testcase(s) on the box`,
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

/** Newest value of the first field that carries a finite number. */
function rowNum(row: any, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = Number(row?.[k]);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * One sample of an execution's per-cell radio statistics.
 *
 * Field names and the endpoint shape are taken from the end-to-end checks,
 * which verified them live: throughput is `dl_bitrate` / `ul_bitrate` in bps,
 * the window is in SECONDS, and the payload nests under data.cells on some
 * builds and is a bare array on others.
 *
 * Returns the peak across cells for this sample — one cell carrying traffic is
 * what "traffic flowed" means here — and the worst BLER, since a single bad
 * cell is the thing worth reporting.
 */
async function sampleCellStats(host: string, token: string, executionId: string): Promise<{ rows: number; dl: number; ul: number; bler?: number }> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 120;
  try {
    const r = await fetch(
      `http://${host}/v2/testcases/executions/${encodeURIComponent(executionId)}/statistics/cells?startTime=${start}&endTime=${end}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (!r.ok) return { rows: 0, dl: 0, ul: 0 };
    const j: any = await r.json().catch(() => ({}));
    const rows: any[] = Array.isArray(j?.data?.cells) ? j.data.cells
      : Array.isArray(j?.cells) ? j.cells
      : Array.isArray(j?.items) ? j.items
      : Array.isArray(j) ? j : [];
    if (!rows.length) return { rows: 0, dl: 0, ul: 0 };

    let dl = 0, ul = 0, bler: number | undefined;
    for (const c of rows) {
      dl = Math.max(dl, rowNum(c, ['dl_throughput', 'dlThroughput', 'dl_bitrate', 'dl', 'downlinkThroughput']) ?? 0);
      ul = Math.max(ul, rowNum(c, ['ul_throughput', 'ulThroughput', 'ul_bitrate', 'ul', 'uplinkThroughput']) ?? 0);
      const b = rowNum(c, ['bler', 'BLER', 'dl_bler', 'blerDl', 'avg_dl_bler']);
      if (b !== undefined) bler = bler === undefined ? b : Math.max(bler, b);
    }
    return { rows: rows.length, dl, ul, bler };
  } catch {
    return { rows: 0, dl: 0, ul: 0 };
  }
}

async function executeOne(host: string, token: string, tc: { id: string; name: string }, label: string, maxWaitMs: number, isCanceled?: () => boolean): Promise<Step> {
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
    // Poll the testcase's lastExecution until terminal, sampling the radio
    // statistics as we go.
    //
    // Sampled DURING the run, not after: /statistics/cells is a time series
    // over a window, and once the execution ends the box stops producing rows,
    // so a single read afterwards can come back empty. Peaks are kept because
    // "did traffic ever flow" is what the build check is asking; the worst BLER
    // is kept for the same reason in the other direction.
    const TERMINAL = new Set(['COMPLETED', 'FAILED', 'STOPPED', 'ABORTED', 'INCOMPLETE', 'PASSED']);
    const deadline = Date.now() + maxWaitMs;
    let status = '';
    let result = '';
    let executionId = '';
    let peakDl = 0;
    let peakUl = 0;
    let worstBler: number | undefined;
    let sampled = 0;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      // Cancel has to reach in here: this loop is where the minutes go, and
      // stopping the box's execution is what "stop it" has to mean — leaving
      // the hardware running and only closing our eyes would be worse.
      if (isCanceled?.()) {
        if (executionId) {
          await fetch(`http://${host}/v2/testcases/executions/${encodeURIComponent(executionId)}/stop`, {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
            body: '{}', signal: AbortSignal.timeout(15_000),
          }).catch(() => null);
        }
        return fin('skip', `canceled after ${((Date.now() - t0) / 1000).toFixed(1)}s${executionId ? ' — execution stopped on the box' : ''}`, 'the run was canceled');
      }
      const g = await fetch(`http://${host}/v2/testcases/${encodeURIComponent(tc.id)}`, { headers: auth, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!g || !g.ok) continue;
      const j: any = await g.json().catch(() => ({}));
      status = String(j?.metadata?.lastExecution?.status ?? '').toUpperCase();
      result = String(j?.metadata?.lastExecution?.result ?? '').toUpperCase();
      executionId = String(j?.metadata?.lastExecution?.executionId ?? executionId);

      if (executionId) {
        const s = await sampleCellStats(host, token, executionId);
        if (s.rows > 0) {
          sampled += s.rows;
          peakDl = Math.max(peakDl, s.dl);
          peakUl = Math.max(peakUl, s.ul);
          if (s.bler !== undefined) worstBler = worstBler === undefined ? s.bler : Math.max(worstBler, s.bler);
        }
      }
      if (TERMINAL.has(status)) break;
    }
    // dl_bitrate / ul_bitrate are BITS PER SECOND — verified on a live run:
    // {"cell":"0","dl_bitrate":1467334681,"ul_bitrate":231997578,"bler":0}.
    // That is 1.47 Gbps, so the ladder has to reach Gbps; formatting it as
    // "1467.3 Mbps" is right but unreadable, and treating the field as kbps
    // would be wrong by a factor of a thousand.
    const rate = (bps: number) =>
      bps >= 1_000_000_000 ? `${(bps / 1_000_000_000).toFixed(2)} Gbps`
        : bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(1)} Mbps`
        : `${Math.round(bps / 1000)} kbps`;
    const measured = sampled > 0
      // "peak" said out loud: these are the highest values seen across the
      // run's samples, not an average. A run that only briefly reached the
      // floor would otherwise read as though it held it throughout.
      ? `BLER ${worstBler === undefined ? 'not reported' : `${worstBler.toFixed(2)}%`}`
        + ` · peak throughput DL ${rate(peakDl)}, UL ${rate(peakUl)}`
      : 'no cell statistics were returned for this execution';
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!TERMINAL.has(status)) {
      return fin('fail', `"${tc.name}" did not finish within ${(maxWaitMs / 60000).toFixed(0)} min (last status ${status || 'unknown'}); ran ${secs}s`, 'the testcase reaches a terminal status inside the wait window');
    }
    // The box's own verdict is only ever "BLER <= 5%", which an empty run also
    // satisfies — so a PASS here means "it ran and the box was content", not
    // "traffic actually flowed". Said plainly rather than implied.
    // The box's own verdict is only ever "Avg_DL_BLER <= 5%", which an empty
    // run also satisfies — so it is necessary but nowhere near sufficient. The
    // build check adds the two things that actually prove the radio carried
    // traffic, and fails the step when either falls short.
    const ranToCompletion = result === 'PASS' || result === 'PASSED' || (status === 'COMPLETED' && result !== 'FAIL');
    const dlMbps = peakDl / 1_000_000;
    const ulMbps = peakUl / 1_000_000;

    const shortfalls: string[] = [];
    if (!ranToCompletion) shortfalls.push(`the box reported status ${status || 'unknown'}${result ? ` / result ${result}` : ''}`);
    if (sampled === 0) shortfalls.push('no cell statistics were returned, so throughput and BLER could not be measured');
    else {
      if (dlMbps < BUILD_CHECK_MIN_DL_MBPS) shortfalls.push(`DL ${dlMbps.toFixed(0)} Mbps is below the ${BUILD_CHECK_MIN_DL_MBPS} Mbps floor`);
      if (ulMbps < BUILD_CHECK_MIN_UL_MBPS) shortfalls.push(`UL ${ulMbps.toFixed(0)} Mbps is below the ${BUILD_CHECK_MIN_UL_MBPS} Mbps floor`);
      if (worstBler === undefined) shortfalls.push('the box reported no BLER');
      else if (worstBler > BUILD_CHECK_MAX_BLER) shortfalls.push(`BLER ${worstBler.toFixed(2)}% exceeds ${BUILD_CHECK_MAX_BLER}%`);
    }

    const headline = `status ${status}${result ? `, result ${result}` : ''}, ran ${secs}s · ${measured}`;
    return fin(shortfalls.length ? 'fail' : 'pass',
      shortfalls.length ? `${headline} — ${shortfalls.join('; ')}` : headline,
      `the testcase completes, DL ≥ ${BUILD_CHECK_MIN_DL_MBPS} Mbps, UL ≥ ${BUILD_CHECK_MIN_UL_MBPS} Mbps and BLER ≤ ${BUILD_CHECK_MAX_BLER}%`);
  } catch (e: any) {
    return fin('fail', `"${tc.name}" — ${e?.name === 'TimeoutError' ? 'request timed out' : (e?.message ?? String(e))}`, 'the testcase starts and runs to a terminal status');
  }
}

/**
 * The build-check testcase, and the callbox configs it needs.
 *
 * One fixed testcase rather than "a 5G one and an LTE one picked by name":
 * a build check has to compare like with like across builds, and a heuristic
 * name match silently ran a different testcase whenever the box's contents
 * changed. All four names verified present on the lab (2026-09-07): the
 * testcase on .102, the three cfgs on callbox .106.
 */
export const BUILD_CHECK_TESTCASE = 'Buildcheck_SA_1Cell_1UEs_UDP';
export const BUILD_CHECK_CFG = { enb: 'SA-1cell', mme: 'demo-mme.cfg', ims: 'demo-ims.cfg' } as const;

/**
 * What this testcase has to achieve for the build to pass.
 *
 * The box's own verdict is only "Avg_DL_BLER <= 5%", which zero attached UEs
 * also satisfies — so a green light from the Simnovator says nothing about
 * whether traffic flowed. These floors are what make the build check mean
 * something. Set from the observed healthy run on .102 (DL peaked ~1.47 Gbps,
 * UL ~232 Mbps) with headroom, so a build that regresses materially fails
 * while normal run-to-run variation does not.
 */
export const BUILD_CHECK_MIN_DL_MBPS = 1200;
export const BUILD_CHECK_MIN_UL_MBPS = 200;
export const BUILD_CHECK_MAX_BLER = 5;

/**
 * Put the build-check testcase on a box that does not have it.
 *
 * The definition ships with SimQA (buildCheckTestcase.json, exported from .102
 * on 2026-09-07) rather than being copied from another Simnovator at run time:
 * a build check is only comparable across builds if every box runs the same
 * definition, and sourcing it from a peer makes it whatever that peer happens
 * to hold today.
 *
 * Import is multipart to /v2/testcases/import — the same call apiTester.ts
 * exercises. Test_Id is regenerated so importing onto a box that has a
 * soft-deleted row of the same id does not collide.
 */
async function createBuildCheckTestcase(
  host: string,
  token: string,
): Promise<{ ok: boolean; detail: string; testcase?: { id: string; name: string } }> {
  try {
    const seedPath = path.join(process.cwd(), 'src', 'lib', 'buildCheckTestcase.json');
    if (!fs.existsSync(seedPath)) {
      return { ok: false, detail: 'the bundled testcase definition is missing from this SimQA install' };
    }
    const pack = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const detail = pack?.test_case_details?.[0];
    if (!detail) return { ok: false, detail: 'the bundled testcase definition has no test_case_details' };

    // Timestamps belong to the export, not to this import.
    delete detail.Created_Date;
    delete detail.Modified_Date;
    delete detail.Deleted_Date;
    detail.Test_Name = BUILD_CHECK_TESTCASE;
    detail.Test_Id = `simqa-buildcheck-${Date.now().toString(36)}`;

    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(pack)], { type: 'application/json' }), 'buildcheck.json');
    const r = await fetch(`http://${host}/v2/testcases/import`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text().catch(() => '');
    if (!r.ok) return { ok: false, detail: `import returned HTTP ${r.status}: ${text.slice(0, 160)}` };

    // Look it up by NAME rather than trusting the import response's id: the box
    // assigns its own, and has been observed auto-suffixing a name it considers
    // taken — in which case this must fail loudly rather than run a "_copy".
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((res) => setTimeout(res, 1500));
      const g = await fetch(`http://${host}/v2/testcases?limit=50&offset=0`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!g?.ok) continue;
      const j: any = await g.json().catch(() => ({}));
      const hit = (j?.items ?? []).find((x: any) => String(x?.name) === BUILD_CHECK_TESTCASE);
      if (hit) return { ok: true, detail: `imported onto ${host} as ${hit.id}`, testcase: { id: String(hit.id), name: BUILD_CHECK_TESTCASE } };
    }
    return { ok: false, detail: `import returned ${r.status} but no testcase named "${BUILD_CHECK_TESTCASE}" appeared on the box` };
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) };
  }
}

/** The callbox bound to a Simnovator via its topology profile — the same
 *  lookup endToEnd/runner.ts and callbox-configs/route.ts already do. */
function callboxForSimnovator(inv: Inventory, simnovatorId: string): InventorySystem | undefined {
  const profile = inv.profiles.find((p) => p.simnovator === simnovatorId);
  return profile?.callbox ? getSystem(inv, profile.callbox) : undefined;
}

async function groupRunTests(
  host: string,
  token: string | undefined,
  req: BuildValidationRequest,
  inv: Inventory,
  sim: InventorySystem,
  isCanceled?: () => boolean,
): Promise<CheckGroup> {
  if (!token) {
    return { id: 'run-tests', label: VERIFICATION_LABELS['run-tests'], status: 'skip', detail: 'skipped: could not authenticate', steps: [] };
  }
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

  const steps: Step[] = [];

  // The named testcase, or nothing — no fallback to "something that looks
  // similar", because running a different testcase and reporting it as the
  // build check is worse than saying it is missing.
  let wanted = req.fiveGTestcaseId
    ? all.find((t) => t.id === req.fiveGTestcaseId)
    : all.find((t) => t.name === BUILD_CHECK_TESTCASE);

  // Not there — create it. A freshly installed box, or a new Simnovator, will
  // not have it, and "the build check cannot run here" is a worse answer than
  // putting the testcase on the box. Imported from the pack shipped with SimQA
  // (buildCheckTestcase.json, exported from .102), so every box runs a byte-
  // identical definition rather than whatever each lab happens to hold.
  if (!wanted) {
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    const created = await createBuildCheckTestcase(host, token);
    steps.push({
      id: 'create-testcase',
      label: `Create ${BUILD_CHECK_TESTCASE}`,
      status: created.ok ? 'pass' : 'fail',
      detail: created.detail,
      expected: `the testcase "${BUILD_CHECK_TESTCASE}" is importable onto this Simnovator`,
      startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
    });
    if (created.ok && created.testcase) wanted = created.testcase;
  }

  if (!wanted) {
    steps.push({
      id: 'run-buildcheck-testcase', label: BUILD_CHECK_TESTCASE, status: 'fail',
      detail: `"${BUILD_CHECK_TESTCASE}" is not on this box (searched ${all.length} testcase(s)) and could not be created`,
      expected: `the testcase "${BUILD_CHECK_TESTCASE}" exists on the Simnovator`,
    });
    return {
      id: 'run-tests', label: VERIFICATION_LABELS['run-tests'], status: 'fail',
      detail: `"${BUILD_CHECK_TESTCASE}" not found on the box and could not be created`, steps,
    };
  }

  // ── Point the callbox at this testcase's configs, then restart lte ──
  // The testcase assumes a specific radio and core config; running it against
  // whatever the callbox happened to be linked to last measures that instead.
  const callbox = callboxForSimnovator(inv, sim.id);
  const tCfg = Date.now();
  const cfgStartedAt = new Date().toISOString();
  if (!callbox) {
    steps.push({
      id: 'cfg-link', label: 'Callbox configuration', status: 'fail',
      detail: `no callbox is bound to ${sim.name ?? sim.host} in its topology profile, so the configs cannot be linked`,
      expected: 'the Simnovator’s topology profile names a callbox',
      startedAt: cfgStartedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - tCfg,
    });
  } else {
    try {
      const link = await linkAndRestart(callbox, { ...BUILD_CHECK_CFG });
      steps.push({
        id: 'cfg-link',
        label: 'Callbox configuration',
        status: link.ok ? 'pass' : 'fail',
        detail: link.ok
          ? `${callbox.host}: enb.cfg → ${BUILD_CHECK_CFG.enb}, mme.cfg → ${BUILD_CHECK_CFG.mme}, ims.cfg → ${BUILD_CHECK_CFG.ims}, lte restarted`
          : (link.steps.find((s) => !s.ok)?.detail ?? 'linking the configs failed'),
        expected: `enb/mme/ims linked to ${BUILD_CHECK_CFG.enb} / ${BUILD_CHECK_CFG.mme} / ${BUILD_CHECK_CFG.ims}`,
        startedAt: cfgStartedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - tCfg,
      });
    } catch (e: any) {
      steps.push({
        id: 'cfg-link', label: 'Callbox configuration', status: 'fail',
        detail: `${callbox.host}: ${e?.message ?? String(e)}`,
        expected: `enb/mme/ims linked to ${BUILD_CHECK_CFG.enb} / ${BUILD_CHECK_CFG.mme} / ${BUILD_CHECK_CFG.ims}`,
        startedAt: cfgStartedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - tCfg,
      });
    }
  }

  // Execute only if the radio actually came up on the right config — running
  // against the wrong one produces a verdict about a configuration nobody
  // asked for.
  const cfgOk = steps[steps.length - 1]?.status === 'pass';
  if (!cfgOk) {
    steps.push({
      id: 'run-buildcheck-testcase', label: wanted.name, status: 'skip',
      detail: 'not executed — the callbox is not on this testcase’s configuration',
    });
  } else {
    steps.push(await executeOne(host, token, wanted, wanted.name, 15 * 60_000, isCanceled));
  }

  const failed = steps.some((s) => s.status === 'fail');
  // Find the execution step by LABEL, not by a guessed id. executeOne derives
  // its id from the label it is given — here the testcase name — so it comes
  // out as `run-buildcheck_sa_1cell_1ues_udp`, and looking for a fixed
  // 'run-buildcheck-testcase' never matched. The summary therefore read
  // "— not executed" on runs that had just executed the testcase for 685s.
  const exec = steps.find((s) => s.label === wanted!.name);
  return {
    id: 'run-tests',
    label: VERIFICATION_LABELS['run-tests'],
    status: failed ? 'fail' : 'pass',
    detail: exec
      ? `${wanted.name} — ${exec.status === 'pass' ? 'executed' : exec.status.toUpperCase()}${exec.detail ? `: ${exec.detail}` : ''}`
      : `${wanted.name} — not executed`,
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

/**
 * Cancellation, as a file.
 *
 * The run is one long POST and the operator who cancels is not that request —
 * they may even have refreshed the page since. A marker beside the report is
 * something any request can write and the run can see; it is checked between
 * groups and inside the execution wait loop, which is where the minutes are.
 */
function cancelPath(id: string): string { return path.join(REPORT_DIR, `${id}.cancel`); }

export function cancelRun(id: string): boolean {
  if (!/^bv-[\w.\-]{1,80}$/.test(id)) return false;
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(cancelPath(id), new Date().toISOString());
    return true;
  } catch { return false; }
}

function isCanceled(id: string): boolean {
  try { return fs.existsSync(cancelPath(id)); } catch { return false; }
}

function clearCancel(id: string): void {
  try { fs.rmSync(cancelPath(id), { force: true }); } catch { /* ignore */ }
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
  const id = /^bv-[\w.\-]{1,80}$/.test(req.runId ?? '')
    ? req.runId!
    : `bv-${startedAt.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;

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

  /**
   * Write the report as it stands, so the page can show each check finishing
   * instead of four spinners for the whole run.
   *
   * The run is one long POST — Run Test Cases alone executes on hardware for
   * minutes — and until this existed the only report was the one written at the
   * end. So Reachable, Login and Sample Tests, which all finish in seconds,
   * still read "running" until the hardware test came back. Groups not reached
   * yet are `pending`; the one in flight is `running`.
   */
  const publish = (runningId?: VerificationId) => {
    const done = new Set(groups.map((g) => g.id));
    const pending: CheckGroup[] = req.checks
      .filter((c) => !done.has(c))
      .map((c) => ({
        id: c,
        label: VERIFICATION_LABELS[c] ?? c,
        status: c === runningId ? 'running' : 'pending',
        detail: c !== runningId
          ? 'waiting'
          // Naming the testcase matters here: this is the group that takes
          // minutes, and without saying why it looks like a hang.
          : c === 'run-tests'
            ? `executing ${BUILD_CHECK_TESTCASE} on the box — this takes minutes`
            : 'running…',
        steps: [],
      }));
    saveReport({
      id, startedAt, ok: false, status: 'running',
      systemId: sim.id, systemName: sim.name, host: sim.host,
      ueSystemId: ue?.id, ueHost: ue?.host,
      appServerSystemId: app?.id, appServerHost: app?.host,
      install: req.install,
      selectedChecks: req.checks,
      groups: [...groups, ...pending],
    });
  };

  /** Mark everything not yet run as canceled and stop. */
  const cancelRemaining = () => {
    const done = new Set(groups.map((g) => g.id));
    for (const c of req.checks) {
      if (done.has(c)) continue;
      groups.push({ id: c, label: VERIFICATION_LABELS[c] ?? c, status: 'skip', detail: 'canceled', steps: [] });
    }
  };

  if (want.has('reachable')) { publish('reachable'); groups.push(await groupReachable(sim, ue, app)); }

  // A token is needed by the two later groups; obtained once here so login is
  // not attempted three times.
  let token: string | undefined;
  if (!isCanceled(id) && (want.has('login') || want.has('sample-tests') || want.has('run-tests'))) {
    publish('login');
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

  if (!isCanceled(id) && want.has('sample-tests')) { publish('sample-tests'); groups.push(await groupSampleTests(sim.host, token)); }
  if (!isCanceled(id) && want.has('run-tests'))    { publish('run-tests');    groups.push(await groupRunTests(sim.host, token, req, inv, sim, () => isCanceled(id))); }

  // "Canceled" only if the cancel actually stopped something. A click that
  // lands as the last group finishes should not relabel a run that completed —
  // the operator would be told nothing ran when everything did.
  const cutShort = req.checks.some((c) => !groups.some((g) => g.id === c))
    || groups.some((g) => g.steps.some((s) => (s.detail ?? '').startsWith('canceled')));
  const canceled = isCanceled(id) && cutShort;
  if (canceled) cancelRemaining();
  clearCancel(id);
  // Last groups finished; publish once more so a poll landing between here and
  // the final save still sees them as done rather than running.
  publish();

  const build = token ? await fetchBoxBuild(sim.host, token) : undefined;
  const finishedAt = new Date().toISOString();
  // A canceled run is never "passed", however far it got — the checks that did
  // not run cannot vouch for the build.
  const ok = !canceled && groups.length > 0 && groups.every((g) => g.status !== 'fail');

  const rep: BuildValidationReport = {
    id, startedAt, finishedAt, ok, status: canceled ? 'canceled' : ok ? 'passed' : 'failed',
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

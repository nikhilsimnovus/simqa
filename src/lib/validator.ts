// Build validation plan. Drives the "I have a new build, did it land cleanly?"
// flow. Composed of discrete checks; each returns a structured result so the
// UI can show a green/red row with detail. Optionally fronted by a download
// + install step that pushes a build tarball to a target host and triggers
// the vendor installer.
//
// The plan is intentionally narrow: it answers "does this build behave?"
// not "does every feature work as specified". Use the Automation suites
// (suites.testcaseIds) for feature-level coverage on top of this.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeSSH } from 'node-ssh';
import {
  ensureToken, listTestcases, listSimulators, getTestcase, startExecution,
} from './uesimClient';
import { generateConfigs, type UesimTestDefinition } from './cfgGenerator';
import {
  type Inventory, type InventorySystem, getSystem, uesimApiOptsFromInventory,
  isSimnovatorTarget,
} from './inventory';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
  durationMs?: number;
}

export type CheckId =
  | 'ui-reachable'
  | 'login'
  | 'version'
  | 'list-simulators'
  | 'list-testcases'
  | 'list-bands'
  | 'me'
  | 'cfg-generator-roundtrip'
  | 'sample-execution'
  | 'sshUesim-reachable'
  | 'install-build';

export interface ValidationPlanRequest {
  /** Validation target: which UESIM (and optionally which CALLBOX) to check. Defaults to first UESIM in inventory. */
  uesimSystemId?: string;

  /** Optional: build to install before running checks. */
  build?: {
    /** Build source. http(s):// URL, or absolute filesystem path on the simqa host. */
    source: string;
    /** Optional installer command line. Run on the UESIM host after the file lands at /tmp/<name>. */
    installCommand?: string;
    /** Optional target path (defaults to /tmp/<basename>). */
    targetPath?: string;
  };

  /** Subset of checks to run. Defaults to all standard checks. */
  checks?: CheckId[];

  /**
   * If supplied, run a single sample testcase end-to-end (no deploy, just
   * trigger + poll). This is a strong signal the box is healthy.
   */
  sampleTestcaseId?: string;
}

export interface ValidationPlanResult {
  /** Set when the request included `build`. */
  build?: {
    source: string;
    targetPath: string;
    bytes: number;
    sha256?: string;
    installResult?: { ok: boolean; output: string };
  };
  checks: CheckResult[];
  ok: boolean;
  startedAt: string;
  finishedAt: string;
}

// ---------- Helpers ----------

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; data?: T; err?: string; ms: number }> {
  const t0 = Date.now();
  try {
    const data = await fn();
    return { ok: true, data, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, err: e?.message ?? String(e), ms: Date.now() - t0 };
  }
}

function check(name: string, r: { ok: boolean; err?: string; ms: number }, detail?: string): CheckResult {
  return { name, ok: r.ok, detail: r.ok ? detail : (detail ? `${detail} - ${r.err}` : r.err), durationMs: r.ms };
}

async function downloadToTmp(source: string, into: string): Promise<{ bytes: number }> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`download ${source}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(into, buf);
    return { bytes: buf.length };
  }
  // Treat as a local path. Copy it into the cache so we have a stable handle.
  const stat = fs.statSync(source);
  fs.copyFileSync(source, into);
  return { bytes: stat.size };
}

function defaultChecks(): CheckId[] {
  return [
    'ui-reachable', 'login', 'me', 'list-simulators',
    'list-testcases', 'list-bands', 'cfg-generator-roundtrip',
  ];
}

// ---------- The pipeline ----------

export async function runValidationPlan(inv: Inventory, req: ValidationPlanRequest): Promise<ValidationPlanResult> {
  const startedAt = new Date().toISOString();

  // Resolve target system. Build Check installs / validates Simnovator only —
  // the only acceptable target type is SIMNOVATOR. If the user passed an
  // explicit id, refuse anything that isn't Simnovator-typed; otherwise pick
  // the first Simnovator system in inventory.
  const uesim: InventorySystem | undefined =
    req.uesimSystemId ? getSystem(inv, req.uesimSystemId) : inv.systems.find(isSimnovatorTarget);
  if (!uesim) {
    return {
      checks: [{ name: 'resolve-target', ok: false, detail: 'no system marked Simnovator in inventory — add one in Inventory' }],
      ok: false, startedAt, finishedAt: new Date().toISOString(),
    };
  }
  if (!isSimnovatorTarget(uesim)) {
    return {
      checks: [{ name: 'resolve-target', ok: false, detail: `target "${uesim.name || uesim.id}" is type ${uesim.type}; Build Check requires a Simnovator-typed system` }],
      ok: false, startedAt, finishedAt: new Date().toISOString(),
    };
  }
  const apiOpts = {
    host:     uesim.host,
    username: uesim.uesim?.username ?? 'admin',
    password: uesim.uesim?.password ?? 'admin',
  };

  const checks: CheckResult[] = [];

  // ---------- Optional: download + install a new build ----------
  let buildOut: ValidationPlanResult['build'];
  if (req.build) {
    const cacheDir = path.join(process.cwd(), 'data', 'builds');
    fs.mkdirSync(cacheDir, { recursive: true });
    const basename = path.basename(req.build.source.split('?')[0]) || `build-${Date.now()}`;
    const localPath = path.join(cacheDir, basename);

    const dl = await timed(() => downloadToTmp(req.build!.source, localPath));
    checks.push(check('download-build', dl, `${(dl as any).data?.bytes ?? 0} bytes -> ${localPath}`));
    if (!dl.ok) return { build: { source: req.build.source, targetPath: '', bytes: 0 }, checks, ok: false, startedAt, finishedAt: new Date().toISOString() };

    buildOut = {
      source: req.build.source,
      targetPath: req.build.targetPath ?? `/tmp/${basename}`,
      bytes: (dl as any).data?.bytes ?? 0,
    };

    // SCP + install. Requires SSH credentials on the UESIM system. The
    // UESIM stack typically lives on the same host the REST API is on, so
    // we treat `uesim.host` as the target. Auth defaults to password if
    // not configured.
    if (!uesim.username) {
      checks.push({ name: 'scp-build', ok: false, detail: 'no SSH username on UESIM system; set username + password (or privateKey) in inventory' });
      return { build: buildOut, checks, ok: false, startedAt, finishedAt: new Date().toISOString() };
    }

    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: uesim.host,
        port: uesim.sshPort ?? 22,
        username: uesim.username,
        ...(uesim.authMode === 'privateKey'
          ? { privateKey: resolveKey(uesim.privateKey), passphrase: uesim.passphrase }
          : { password: uesim.password ?? '' }),
        readyTimeout: 10000,
      });
      const t = await timed(() => ssh.putFile(localPath, buildOut!.targetPath));
      checks.push(check('scp-build', t, `${localPath} -> ${uesim.host}:${buildOut!.targetPath}`));
      if (!t.ok) return { build: buildOut, checks, ok: false, startedAt, finishedAt: new Date().toISOString() };

      if (req.build.installCommand) {
        const sudoPwd = uesim.sudoPassword ?? (uesim.authMode !== 'privateKey' ? uesim.password : '') ?? '';
        const sudo = sudoPwd
          ? `echo '${sudoPwd.replace(/'/g, "'\\''")}' | sudo -S -p ''`
          : 'sudo -n';
        const cmd = `${sudo} sh -c ${shellEscape(req.build.installCommand)}`;
        const t2 = Date.now();
        const r = await ssh.execCommand(cmd);
        const ok = r.code === 0;
        const tail = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).slice(-1500);
        buildOut.installResult = { ok, output: tail };
        checks.push({ name: 'install-build', ok, detail: ok ? `installed (${Date.now() - t2}ms)` : `installer exit ${r.code}: ${(r.stderr || r.stdout).slice(-300)}`, durationMs: Date.now() - t2 });
        if (!ok) return { build: buildOut, checks, ok: false, startedAt, finishedAt: new Date().toISOString() };
      } else {
        checks.push({ name: 'install-build', ok: true, detail: 'no installCommand provided - file staged at ' + buildOut.targetPath });
      }
    } catch (e: any) {
      checks.push({ name: 'ssh-build', ok: false, detail: e?.message ?? String(e) });
      return { build: buildOut, checks, ok: false, startedAt, finishedAt: new Date().toISOString() };
    } finally {
      try { ssh.dispose(); } catch {}
    }

    // After install, give services a moment to come back up.
    await new Promise((r) => setTimeout(r, 3000));
  }

  // ---------- Standard checks ----------
  const wanted = new Set<CheckId>(req.checks ?? defaultChecks());

  if (wanted.has('ui-reachable')) {
    const r = await timed(async () => {
      const res = await fetch(`http://${uesim!.host}/`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    });
    const html = (r as any).data as string | undefined;
    checks.push(check('ui-reachable', r, html?.includes('Simnovator') ? 'serves Simnovator SPA' : '200 from /'));
  }

  if (wanted.has('login')) {
    const r = await timed(() => ensureToken(apiOpts.host, apiOpts.username, apiOpts.password));
    checks.push(check('login', r, `JWT issued for ${apiOpts.username}@${apiOpts.host}`));
  }

  if (wanted.has('me')) {
    const r = await timed(async () => {
      const tok = await ensureToken(apiOpts.host, apiOpts.username, apiOpts.password);
      const res = await fetch(`http://${apiOpts.host}/v2/users/me`, { headers: { Authorization: `Bearer ${tok}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });
    const me: any = (r as any).data;
    checks.push(check('me', r, me ? `username=${me.username} roles=${(me.roles ?? []).join(',')}` : undefined));
  }

  if (wanted.has('list-simulators')) {
    const r = await timed(() => listSimulators(apiOpts));
    const items = (r as any).data?.items ?? [];
    checks.push(check('list-simulators', r, `${items.length} registered`));
  }

  if (wanted.has('list-testcases')) {
    const r = await timed(() => listTestcases(apiOpts, 1, 0));
    const total = (r as any).data?.total;
    checks.push(check('list-testcases', r, total != null ? `total=${total}` : undefined));
  }

  if (wanted.has('list-bands')) {
    const r = await timed(async () => {
      const tok = await ensureToken(apiOpts.host, apiOpts.username, apiOpts.password);
      const res = await fetch(`http://${apiOpts.host}/v2/band-info`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rat: 'NR' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });
    const data: any = (r as any).data;
    checks.push(check('list-bands', r, data ? `${(data.data ?? []).length} bands` : undefined));
  }

  if (wanted.has('cfg-generator-roundtrip')) {
    const r = await timed(async () => {
      // Pull one testcase, generate cfgs, ensure no exceptions.
      const list = await listTestcases(apiOpts, 1, 0);
      const id = list.items?.[0]?.id;
      if (!id) throw new Error('no testcases to round-trip against');
      const tc = await getTestcase(apiOpts, id);
      if (!tc.testDefinition) throw new Error('testcase has no testDefinition');
      const bundle = generateConfigs(tc.testDefinition as UesimTestDefinition, id);
      return { id, files: Object.keys(bundle.files), summary: bundle.summary };
    });
    const data: any = (r as any).data;
    checks.push(check('cfg-generator-roundtrip', r, data ? `${data.id}: ${data.files.join(', ')} (${data.summary.cells}-cell)` : undefined));
  }

  if (wanted.has('sample-execution') && req.sampleTestcaseId) {
    const r = await timed(async () => {
      const startR = await startExecution(apiOpts, req.sampleTestcaseId!, {});
      // Poll up to 60s.
      const t0 = Date.now();
      while (Date.now() - t0 < 60_000) {
        await new Promise((r) => setTimeout(r, 3000));
        const refreshed = await getTestcase(apiOpts, req.sampleTestcaseId!);
        const last: any = (refreshed.metadata as any)?.lastExecution;
        const status = last?.status ?? '?';
        if (status === 'COMPLETED') return { result: last?.result ?? '?' };
        if (status === 'ABORTED' || status === 'STOPPED') throw new Error(`execution ${status}: ${last?.result ?? ''}`);
      }
      throw new Error('execution did not complete within 60s');
    });
    const data: any = (r as any).data;
    checks.push(check('sample-execution', r, data ? `result=${data.result}` : undefined));
  }

  const ok = checks.every((c) => c.ok);
  return { build: buildOut, checks, ok, startedAt, finishedAt: new Date().toISOString() };
}

function resolveKey(field: string | undefined): string {
  if (!field) throw new Error('privateKey not set');
  const s = field.trim();
  if (s.startsWith('-----BEGIN')) return s;
  for (const c of [s, path.resolve(process.cwd(), s), path.resolve(os.homedir(), s.replace(/^~[\/\\]/, ''))]) {
    try { return fs.readFileSync(c, 'utf8'); } catch {}
  }
  throw new Error(`private key not found: ${field}`);
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

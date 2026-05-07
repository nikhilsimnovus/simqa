// Build installer for SIMNOVATOR systems.
//
// Connects to the Simnovator VM over SSH (using the inventory credentials)
// and runs the same wget + tar + ./install pipeline a human would type into
// Cockpit Terminal. Streams stdout/stderr line-by-line back to the caller
// so the UI can render a live log.
//
// We deliberately keep this straightforward — no exotic Cockpit-channel
// stuff; just SSH. The Simnovator account that owns Cockpit (`simnovus`)
// is also a real Linux user with the same password, so its creds work for
// SSH authentication too. The actual `./install` script is what eventually
// SSHes onward to the UE / App / ORU machines from the Simnovator VM.

import { NodeSSH } from 'node-ssh';
import type { Inventory, InventorySystem } from './inventory';
import { getSystem, isSimnovatorTarget } from './inventory';

/** A single event the caller can stream to the browser. */
export type InstallEvent =
  | { type: 'log'; stream: 'stdout' | 'stderr' | 'info' | 'error'; line: string; ts: number }
  | { type: 'step'; step: InstallStepName; status: 'start' | 'ok' | 'fail'; detail?: string; durationMs?: number; ts: number }
  | { type: 'done'; ok: boolean; durationMs: number; ts: number };

export type InstallStepName = 'connect' | 'fetch' | 'extract' | 'install';

export interface BuildInstallRequest {
  /** Inventory id of the SIMNOVATOR system to install onto. */
  systemId: string;
  /** http(s) URL of the .tar.gz to install. */
  buildUrl: string;
  /** Working dir on the VM (default /tmp). */
  workingDir?: string;
  /** Per-host (--ue, --app, --oru, --external) IPs and SSH users. */
  hosts: Array<{
    flag: '--ue' | '--app' | '--oru' | '--external';
    ip: string;
    user?: string;       // ignored for --external
    ipOnly?: boolean;    // true for --external
  }>;
  /** Timezone passed to ./install via -t. Empty/undefined = skip the flag. */
  timezone?: string;
  /** Numeric value for -m / --max_simulators. Empty = skip. */
  maxSimulators?: string;
  /** Each truthy entry adds a `--no_*` flag. */
  skip?: { app_server?: boolean; app_manager?: boolean; simnovator?: boolean; ue?: boolean; oru?: boolean };
  /** If true, append --restore. */
  restore?: boolean;
  /** Free-form pass-through args appended to the install line. */
  extraArgs?: string;
}

interface BuildInstallContext {
  emit: (e: InstallEvent) => void;
  inv: Inventory;
  req: BuildInstallRequest;
}

const UTF8 = 'utf-8';

function nowEvent<T extends Omit<InstallEvent, 'ts'>>(e: T): InstallEvent {
  return { ...(e as any), ts: Date.now() };
}

function nameFromUrl(url: string): { fileName: string; dirName: string } {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').filter(Boolean).pop() ?? 'build.tar.gz';
    const dir = file.replace(/\.tar\.gz$|\.tgz$/i, '');
    return { fileName: file, dirName: dir };
  } catch {
    return { fileName: 'build.tar.gz', dirName: 'build' };
  }
}

function shellQuote(s: string): string {
  // POSIX-safe single-quote wrapping.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Build the `./install <flags>` line from a request. */
export function buildInstallCommand(req: BuildInstallRequest): string {
  const parts: string[] = ['./install'];
  for (const h of req.hosts) {
    if (!h.ip) continue;
    if (h.ipOnly) {
      parts.push(h.flag, shellQuote(h.ip));
    } else {
      const user = (h.user || 'sysadmin').trim() || 'sysadmin';
      parts.push(h.flag, shellQuote(`${user}@${h.ip}`));
    }
  }
  if (req.timezone && req.timezone.trim()) parts.push('-t', shellQuote(req.timezone.trim()));
  if (req.maxSimulators && req.maxSimulators.trim()) parts.push('-m', req.maxSimulators.trim());
  if (req.skip?.app_server)  parts.push('--no_app_server');
  if (req.skip?.app_manager) parts.push('--no_app_manager');
  if (req.skip?.simnovator)  parts.push('--no_simnovator');
  if (req.skip?.ue)          parts.push('--no_ue');
  if (req.skip?.oru)         parts.push('--no_oru');
  if (req.restore)           parts.push('--restore');
  if (req.extraArgs && req.extraArgs.trim()) parts.push(req.extraArgs.trim());
  return parts.join(' ');
}

/** Resolve the SSH credentials we'll use to log into the Simnovator VM. */
function sshCreds(target: InventorySystem): { username: string; password: string } {
  // Cockpit creds are the same Linux user, so we try cockpitUser/cockpitPassword
  // first (those are visibly set on the Inventory page for the Simnovator
  // system), then fall back to the generic SSH username/password.
  const username = target.cockpitUser ?? target.username ?? '';
  const password = target.cockpitPassword ?? target.password ?? '';
  if (!username) throw new Error(`system ${target.id}: no username (set Cockpit user or SSH user in Inventory)`);
  if (!password) throw new Error(`system ${target.id}: no password (set Cockpit password or SSH password in Inventory)`);
  return { username, password };
}

/**
 * Run the build install.
 *
 * Calls `emit` with progress events; resolves once the install line returns
 * (regardless of exit code — overall success/failure is signalled in the
 * final 'done' event). On unexpected exceptions a 'log' (error) event is
 * emitted and the function still resolves.
 */
export async function runBuildInstall(ctx: BuildInstallContext): Promise<{ ok: boolean }> {
  const { emit, inv, req } = ctx;
  const t0 = Date.now();

  const target = getSystem(inv, req.systemId);
  if (!target) {
    emit(nowEvent({ type: 'log', stream: 'error', line: `system not found: ${req.systemId}` }));
    emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
    return { ok: false };
  }
  if (!isSimnovatorTarget(target)) {
    emit(nowEvent({ type: 'log', stream: 'error', line: `target ${target.id} is type ${target.type}; install requires SIMNOVATOR` }));
    emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
    return { ok: false };
  }
  if (!req.buildUrl?.trim()) {
    emit(nowEvent({ type: 'log', stream: 'error', line: 'missing buildUrl' }));
    emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
    return { ok: false };
  }

  const { fileName, dirName } = nameFromUrl(req.buildUrl);
  const dir = (req.workingDir?.trim() || '/tmp').replace(/\/+$/, '');
  const installCmd = buildInstallCommand(req);

  emit(nowEvent({ type: 'log', stream: 'info', line: `target: ${target.name || target.id} (${target.host})` }));

  const ssh = new NodeSSH();
  let creds: { username: string; password: string };
  try {
    creds = sshCreds(target);
  } catch (e: any) {
    emit(nowEvent({ type: 'log', stream: 'error', line: e?.message ?? String(e) }));
    emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
    return { ok: false };
  }

  // ── connect ──────────────────────────────────────────────
  const tConnect = Date.now();
  emit(nowEvent({ type: 'step', step: 'connect', status: 'start', detail: `${creds.username}@${target.host}:22` }));
  try {
    await ssh.connect({
      host: target.host,
      port: 22,
      username: creds.username,
      password: creds.password,
      readyTimeout: 30_000,
    });
    emit(nowEvent({ type: 'step', step: 'connect', status: 'ok', durationMs: Date.now() - tConnect }));
  } catch (e: any) {
    emit(nowEvent({ type: 'step', step: 'connect', status: 'fail', detail: e?.message ?? String(e), durationMs: Date.now() - tConnect }));
    emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
    return { ok: false };
  }

  // helper that runs a single command, streaming stdout/stderr line-by-line.
  const runStreaming = async (label: InstallStepName, cmd: string, opts?: { cwd?: string }): Promise<{ ok: boolean; durationMs: number }> => {
    const tStep = Date.now();
    emit(nowEvent({ type: 'step', step: label, status: 'start', detail: cmd.slice(0, 200) }));
    emit(nowEvent({ type: 'log', stream: 'info', line: `$ ${cmd}` }));
    const buf = { stdout: '', stderr: '' };
    const flushLines = (s: 'stdout' | 'stderr') => {
      const lines = buf[s].split(/\r?\n/);
      buf[s] = lines.pop() ?? '';
      for (const ln of lines) emit(nowEvent({ type: 'log', stream: s, line: ln }));
    };
    let exitCode = 0;
    try {
      const r = await ssh.execCommand(cmd, {
        cwd: opts?.cwd,
        execOptions: { pty: false },
        onStdout: (chunk) => { buf.stdout += chunk.toString(UTF8); flushLines('stdout'); },
        onStderr: (chunk) => { buf.stderr += chunk.toString(UTF8); flushLines('stderr'); },
      });
      exitCode = r.code ?? 0;
      // flush any trailing partial line
      if (buf.stdout) emit(nowEvent({ type: 'log', stream: 'stdout', line: buf.stdout }));
      if (buf.stderr) emit(nowEvent({ type: 'log', stream: 'stderr', line: buf.stderr }));
    } catch (e: any) {
      emit(nowEvent({ type: 'log', stream: 'error', line: e?.message ?? String(e) }));
      exitCode = 1;
    }
    const durationMs = Date.now() - tStep;
    if (exitCode === 0) emit(nowEvent({ type: 'step', step: label, status: 'ok', durationMs }));
    else emit(nowEvent({ type: 'step', step: label, status: 'fail', detail: `exit code ${exitCode}`, durationMs }));
    return { ok: exitCode === 0, durationMs };
  };

  try {
    // ── fetch ──────────────────────────────────────────────
    const fetchCmd =
      `mkdir -p ${shellQuote(dir)} && cd ${shellQuote(dir)} && ` +
      `wget --no-check-certificate -c -q --show-progress ${shellQuote(req.buildUrl)}`;
    const fetched = await runStreaming('fetch', fetchCmd);
    if (!fetched.ok) {
      emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
      return { ok: false };
    }

    // ── extract ────────────────────────────────────────────
    const extractCmd =
      `cd ${shellQuote(dir)} && tar -zxvf ${shellQuote(fileName)} 2>&1 | tail -50`;
    const extracted = await runStreaming('extract', extractCmd);
    if (!extracted.ok) {
      emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
      return { ok: false };
    }

    // ── install ────────────────────────────────────────────
    const installFull =
      `cd ${shellQuote(`${dir}/${dirName}`)} && ${installCmd}`;
    const installed = await runStreaming('install', installFull);
    if (!installed.ok) {
      emit(nowEvent({ type: 'done', ok: false, durationMs: Date.now() - t0 }));
      return { ok: false };
    }

    emit(nowEvent({ type: 'done', ok: true, durationMs: Date.now() - t0 }));
    return { ok: true };
  } finally {
    try { ssh.dispose(); } catch { /* ignore */ }
  }
}

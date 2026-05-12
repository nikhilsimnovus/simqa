// labTools.ts — server-side orchestration for the "Tools" page (/tools).
//
// Today this hosts a single utility: the UE-sim cfg patcher. The patcher
// watches /root/ue/config/ue.cfg on a no-SDR UESIM box and rewrites the SDR
// rf_driver block to use the Amarisoft IP loopback driver instead, so tests
// run end-to-end without hardware. See scripts/lab-tools/patch_ue_cfg.sh.
//
// The Tools page lets the user pick a UESIM from inventory, then:
//   install   — scp the script, install inotify-tools if missing, start it in
//               the background, return immediately.
//   status    — is it running? how many cfgs has it patched? recent log tail.
//   uninstall — stop the watcher, remove the script + log + (optionally) the
//               .orig backup copies.
//
// SSH connection is made fresh on every call. Cheap (<1s) on a LAN and keeps
// the server stateless — no long-lived connections to leak when Next.js
// hot-reloads.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeSSH } from 'node-ssh';
import type { InventorySystem } from './inventory';
import { isUesimLike } from './inventory';

/** Filename uploaded into the SSH user's home directory. Keep stable so the
 *  status + uninstall paths know what to look for. */
const REMOTE_SCRIPT_NAME = 'patch_ue_cfg.sh';
const REMOTE_LOG_NAME    = 'patch_ue_cfg.log';

/** Backup files the script writes when it patches — also what `status` counts
 *  to show "patches today". */
const REMOTE_BACKUP_GLOB = '/root/ue/config/ue.cfg.orig.*';

/** A summarised status the UI renders. */
export interface PatcherStatus {
  systemId: string;
  host: string;
  /** True when at least one `patch_ue_cfg.sh` process is running on the box. */
  running: boolean;
  /** PIDs for the running process(es). */
  pids: number[];
  /** True when the script file is present on the box (~/patch_ue_cfg.sh). */
  scriptInstalled: boolean;
  /** True when inotifywait is installed on the box. */
  inotifyAvailable: boolean;
  /** Count of ue.cfg.orig.* backup files = number of patches applied so far. */
  patchCount: number;
  /** Last ~20 lines of the watcher log file, in time order (oldest → newest). */
  recentLog: string[];
  /** Last error / informational message we encountered while gathering this. */
  detail?: string;
}

export interface OperationResult {
  ok: boolean;
  detail: string;
  /** Truncated stdout/stderr from the most important command, for the UI. */
  output?: string;
}

// ───────────── SSH connection ─────────────

/** Throws a readable error if the system can't be SSH'd into. */
function assertReady(s: InventorySystem): asserts s is InventorySystem & { username: string } {
  if (!isUesimLike(s)) throw new Error(`system "${s.id}" is not a UESIM (type=${s.type})`);
  if (!s.username)     throw new Error(`system "${s.id}" has no SSH username in inventory.yaml`);
  if (s.authMode === 'privateKey') {
    if (!s.privateKey) throw new Error(`system "${s.id}" is set to privateKey auth but inventory.yaml has no privateKey`);
  } else {
    // Either authMode is unset (defaults to password) or explicitly 'password'.
    if (!s.password) throw new Error(`system "${s.id}" needs either a password or authMode: privateKey + privateKey in inventory.yaml`);
  }
}

async function openSsh(s: InventorySystem): Promise<NodeSSH> {
  assertReady(s);
  const ssh = new NodeSSH();
  const useKey = s.authMode === 'privateKey' && !!s.privateKey;
  const keyText = useKey ? (s.privateKey!.startsWith('-----BEGIN') ? s.privateKey! : fs.readFileSync(s.privateKey!, 'utf-8')) : undefined;
  await ssh.connect({
    host: s.host,
    port: s.sshPort ?? 22,
    username: s.username,
    ...(useKey
      ? { privateKey: keyText, passphrase: s.passphrase }
      : { password: s.password }),
    readyTimeout: 20_000,
    keepaliveInterval: 5_000,
  });
  return ssh;
}

/** Where the script + log live on the remote box (user's home). */
function remotePaths(s: InventorySystem) {
  // We use $HOME (~) so it works for any SSH user (sysadmin, simnovus, etc.).
  // The script itself only writes to /root/ue/config which is what needs sudo.
  const home = `/home/${s.username}`;
  return {
    script: `${home}/${REMOTE_SCRIPT_NAME}`,
    log:    `${home}/${REMOTE_LOG_NAME}`,
  };
}

/** Read the bundled bash script that we'll upload. Lives under
 *  scripts/lab-tools/patch_ue_cfg.sh — committed, ships in the release tar. */
function loadBundledScript(): string {
  const p = path.join(process.cwd(), 'scripts', 'lab-tools', REMOTE_SCRIPT_NAME);
  if (!fs.existsSync(p)) throw new Error(`bundled script not found at ${p}`);
  return fs.readFileSync(p, 'utf-8');
}

/** Shell-quote a single value safely for `sudo -S` usage. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Run a sudo command on a connected SSH session, providing the configured
 *  sudoPassword (or password) via -S. Returns the combined stdout/stderr +
 *  exit code so callers can decide. */
async function sudoExec(ssh: NodeSSH, s: InventorySystem, cmd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const pwd = s.sudoPassword ?? s.password ?? '';
  // Pipe the password into sudo -S. If the user has NOPASSWD, the password is
  // silently ignored which is fine.
  const wrapped = `printf '%s\\n' ${shellQuote(pwd)} | sudo -S -p '' bash -lc ${shellQuote(cmd)}`;
  const r = await ssh.execCommand(wrapped, { execOptions: { pty: false } });
  return { stdout: r.stdout, stderr: r.stderr, code: r.code };
}

// ───────────── Status ─────────────

export async function getStatus(s: InventorySystem): Promise<PatcherStatus> {
  const status: PatcherStatus = {
    systemId: s.id, host: s.host,
    running: false, pids: [],
    scriptInstalled: false, inotifyAvailable: false,
    patchCount: 0, recentLog: [],
  };
  let ssh: NodeSSH | undefined;
  try {
    ssh = await openSsh(s);
    const { script, log } = remotePaths(s);

    // Combined probe — one round-trip rather than five.
    const probe = `
      pgrep -fa ${shellQuote(REMOTE_SCRIPT_NAME)} 2>/dev/null | head -5
      echo '---'
      test -x ${shellQuote(script)} && echo SCRIPT_INSTALLED=yes || echo SCRIPT_INSTALLED=no
      command -v inotifywait >/dev/null && echo INOTIFY=yes || echo INOTIFY=no
      ls -1 ${REMOTE_BACKUP_GLOB} 2>/dev/null | wc -l | awk '{print "PATCH_COUNT="$1}'
      echo '---'
      tail -n 20 ${shellQuote(log)} 2>/dev/null || true
    `;
    const r = await sudoExec(ssh, s, probe);
    const [pidsRaw, metaRaw, logRaw = ''] = r.stdout.split(/\n---\n/);

    // pgrep output: lines like "12345 bash /home/sysadmin/patch_ue_cfg.sh"
    for (const line of (pidsRaw ?? '').split('\n')) {
      const m = line.match(/^(\d+)\s/);
      if (m) {
        status.pids.push(Number(m[1]));
        status.running = true;
      }
    }
    for (const line of (metaRaw ?? '').split('\n')) {
      if (line.startsWith('SCRIPT_INSTALLED=')) status.scriptInstalled  = line.endsWith('yes');
      if (line.startsWith('INOTIFY='))          status.inotifyAvailable = line.endsWith('yes');
      if (line.startsWith('PATCH_COUNT=')) {
        const n = Number(line.split('=')[1]);
        if (!Number.isNaN(n)) status.patchCount = n;
      }
    }
    status.recentLog = (logRaw ?? '').split('\n').filter((l) => l.trim().length > 0);
    return status;
  } catch (e: any) {
    status.detail = `status probe failed: ${e?.message ?? String(e)}`;
    return status;
  } finally {
    ssh?.dispose();
  }
}

// ───────────── Install ─────────────

/** Push the bundled script, ensure inotify-tools is present, and start the
 *  watcher in the background. Idempotent: re-install while running is a no-op
 *  on the running process; the script content is updated either way. */
export async function install(s: InventorySystem): Promise<OperationResult> {
  let ssh: NodeSSH | undefined;
  try {
    ssh = await openSsh(s);
    const { script, log } = remotePaths(s);
    const bundled = loadBundledScript();

    // 1) Upload script to ~ — owned by the SSH user. No sudo needed yet.
    await ssh.execCommand(`mkdir -p ${shellQuote(path.posix.dirname(script))}`);
    // Use SFTP. node-ssh exposes putFile but we want to send a string —
    // simpler to pipe via stdin: cat > ...
    await new Promise<void>((resolve, reject) => {
      ssh!.requestSFTP().then((sftp) => {
        const ws = sftp.createWriteStream(script, { mode: 0o755 });
        ws.on('close', () => resolve());
        ws.on('error', (err: Error) => reject(err));
        ws.end(bundled);
      }).catch(reject);
    });

    // 2) Ensure inotify-tools is installed. This is the only step that may
    //    need to hit the package manager — first run can take a few seconds.
    const haveInotify = await ssh.execCommand('command -v inotifywait >/dev/null && echo yes || echo no');
    if (!haveInotify.stdout.includes('yes')) {
      const apt = await sudoExec(ssh, s, 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq inotify-tools');
      if (apt.code !== 0) {
        return { ok: false, detail: `inotify-tools install failed (exit ${apt.code})`, output: (apt.stdout + '\n' + apt.stderr).slice(-1200) };
      }
    }

    // 3) Start (no-op if already running). nohup + & detaches from the SSH
    //    session so the watcher survives the connection close. Stderr is
    //    merged into the log.
    const already = await sudoExec(ssh, s, `pgrep -f ${shellQuote(REMOTE_SCRIPT_NAME)} >/dev/null && echo RUNNING || echo NOT_RUNNING`);
    if (already.stdout.includes('NOT_RUNNING')) {
      const start = await sudoExec(ssh, s, `nohup bash ${shellQuote(script)} > ${shellQuote(log)} 2>&1 & disown; sleep 0.5; pgrep -f ${shellQuote(REMOTE_SCRIPT_NAME)} | head -1`);
      const pid = start.stdout.trim().split('\n').pop();
      if (!pid || !/^\d+$/.test(pid)) {
        return { ok: false, detail: 'watcher did not appear in pgrep after start — check log on the box', output: (start.stdout + '\n' + start.stderr).slice(-1200) };
      }
      return { ok: true, detail: `installed + started, pid ${pid}` };
    }
    return { ok: true, detail: 'already running — script file updated' };
  } catch (e: any) {
    return { ok: false, detail: `install failed: ${e?.message ?? String(e)}` };
  } finally {
    ssh?.dispose();
  }
}

// ───────────── Uninstall ─────────────

export interface UninstallOpts {
  /** Also delete the .orig backup files under /root/ue/config/. Default: false. */
  removeBackups?: boolean;
}

export async function uninstall(s: InventorySystem, opts: UninstallOpts = {}): Promise<OperationResult> {
  let ssh: NodeSSH | undefined;
  try {
    ssh = await openSsh(s);
    const { script, log } = remotePaths(s);

    const lines: string[] = [];
    lines.push(`pkill -f ${shellQuote(REMOTE_SCRIPT_NAME)} || true`);
    lines.push(`sleep 0.3`);
    lines.push(`rm -f ${shellQuote(script)} ${shellQuote(log)}`);
    if (opts.removeBackups) {
      lines.push(`rm -f ${REMOTE_BACKUP_GLOB}`);
    }
    lines.push(`pgrep -f ${shellQuote(REMOTE_SCRIPT_NAME)} && echo STILL_RUNNING || echo STOPPED`);

    const r = await sudoExec(ssh, s, lines.join(' && '));
    if (r.stdout.includes('STILL_RUNNING')) {
      return { ok: false, detail: 'pkill ran but watcher is still alive — try again or investigate manually', output: r.stdout.slice(-500) };
    }
    return {
      ok: true,
      detail: opts.removeBackups
        ? 'stopped + removed script, log, and .orig backups'
        : 'stopped + removed script and log (.orig backups left in /root/ue/config/)',
    };
  } catch (e: any) {
    return { ok: false, detail: `uninstall failed: ${e?.message ?? String(e)}` };
  } finally {
    ssh?.dispose();
  }
}

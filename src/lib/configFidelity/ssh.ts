// SSH helpers for config-fidelity: read a remote file and run a command on the
// UE-sim host. Mirrors the stateless connect pattern in deploy.ts / validator.ts
// (node-ssh, fresh connection per op, disposed after) and reuses the same
// inventory auth fields. deploy.ts only ever *uploads*; here we need to *read*
// the generated ue.cfg back, so we add an sftp getFile/read.

import { NodeSSH } from 'node-ssh';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { InventorySystem } from '../inventory';

/** Resolve a privateKey field to PEM contents (raw, or a path). */
function resolvePrivateKey(field: string | undefined): string | undefined {
  if (!field) return undefined;
  const s = field.trim();
  if (s.startsWith('-----BEGIN')) return s;
  for (const c of [s, path.resolve(process.cwd(), s), path.resolve(os.homedir(), s.replace(/^~[\/\\]/, ''))]) {
    try { return fs.readFileSync(c, 'utf8'); } catch { /* next */ }
  }
  throw new Error(`private key not found: ${field}`);
}

function connectConfig(sys: InventorySystem) {
  if (!sys.username) throw new Error(`system ${sys.id}: no SSH username set (needed to read ue.cfg)`);
  const auth = sys.authMode === 'privateKey'
    ? { privateKey: resolvePrivateKey(sys.privateKey), passphrase: sys.passphrase }
    : { password: sys.password ?? '' };
  return { host: sys.host, port: sys.sshPort ?? 22, username: sys.username, ...auth, readyTimeout: 10000 };
}

export async function withSsh<T>(sys: InventorySystem, fn: (ssh: NodeSSH) => Promise<T>): Promise<T> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect(connectConfig(sys));
    return await fn(ssh);
  } finally {
    try { ssh.dispose(); } catch { /* ignore */ }
  }
}

/** Read a remote text file over SFTP. Returns undefined if it doesn't exist. */
export async function readRemoteFile(sys: InventorySystem, remotePath: string): Promise<string | undefined> {
  return withSsh(sys, async (ssh) => {
    // `cat` is simplest and avoids sftp temp-file plumbing; sudo in case the
    // file is root-owned (ue.cfg lives under /root on the lab boxes).
    const pwd = sys.sudoPassword ?? (sys.authMode !== 'privateKey' ? sys.password : '') ?? '';
    const sudo = pwd ? `printf '%s\\n' '${pwd.replace(/'/g, "'\\''")}' | sudo -S -p '' ` : 'sudo -n ';
    let r = await ssh.execCommand(`${sudo}cat ${shellQuote(remotePath)}`);
    if (r.code === 0 && r.stdout) return r.stdout;
    // Retry without sudo (user may own it / NOPASSWD not set).
    r = await ssh.execCommand(`cat ${shellQuote(remotePath)}`);
    if (r.code === 0 && r.stdout) return r.stdout;
    return undefined;
  });
}

/** Run a command and return stdout (best-effort; empty string on failure). */
export async function readCommand(sys: InventorySystem, cmd: string): Promise<string> {
  return withSsh(sys, async (ssh) => {
    const r = await ssh.execCommand(cmd);
    return (r.stdout || '') + (r.stderr ? `\n${r.stderr}` : '');
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

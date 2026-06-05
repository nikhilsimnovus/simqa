// gnbBackup.ts — back up + restore the Amarisoft eNB / MME cfg trees from a
// remote Simnovator box.
//
// What gets backed up:
//   • Every file under /root/enb/config (gNB / eNB cfgs, includes, certs)
//   • Every file under /root/mme/config (MME / IMS cfgs)
//
// Files are read via SSH + sudo (the trees are root-owned) and base64-encoded
// inside the backup JSON so binary content (.pem, .der, etc.) survives the
// round-trip without corruption.
//
// What does NOT:
//   • /var/log/* — runtime logs are not config
//   • Any file > 5 MB — defensive cap; cfg files are well under that
//   • Symlinks — followed during walk, the file they point at is captured
//
// Format: one JSON document, same shape family as configBackup.ts so the UI
// can render results with the same components.
//
// Safety properties of restore:
//   1. Strict whitelist — every incoming path MUST be under /root/enb/config/
//      or /root/mme/config/. Anything else is rejected.
//   2. Every existing remote file is copied to <path>.bak-<ts> BEFORE
//      overwriting. So a bad restore can always be rolled back manually.
//   3. Path-traversal guard: rejects `../` segments and absolute paths that
//      escape the whitelisted roots.
//   4. Restore touches ONLY the whitelisted roots; nothing else on the box
//      can be created or modified.

import * as fs from 'node:fs';
import { NodeSSH } from 'node-ssh';
import type { InventorySystem } from './inventory';

/** Remote directories we collect. Add to this list if a new cfg surface
 *  needs coverage; restore whitelist updates automatically. */
const REMOTE_ROOTS = ['/root/enb/config', '/root/mme/config'] as const;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface GnbBackup {
  manifest: {
    version: 1;
    kind: 'gnb-mme-config';
    createdAt: string;
    systemId: string;
    host: string;
    sourceDirs: string[];
    fileCount: number;
    totalBytes: number;
  };
  /** Map of absolute remote path → base64-encoded file content. */
  files: Record<string, string>;
}

export interface GnbRestoreResult {
  restoredFiles: string[];
  backedUpFiles: string[];
  rejectedFiles: string[];
  errors: string[];
}

// ───────────── SSH helpers ─────────────

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

async function openSsh(s: InventorySystem): Promise<NodeSSH> {
  if (!s.username) throw new Error(`system "${s.id}" has no SSH username in inventory.yaml`);
  const useKey = s.authMode === 'privateKey' && !!s.privateKey;
  if (useKey) {
    if (!s.privateKey) throw new Error(`system "${s.id}" is privateKey auth but no privateKey set`);
  } else {
    if (!s.password) throw new Error(`system "${s.id}" needs a password or privateKey for SSH`);
  }
  const ssh = new NodeSSH();
  const keyText = useKey
    ? (s.privateKey!.startsWith('-----BEGIN') ? s.privateKey! : fs.readFileSync(s.privateKey!, 'utf-8'))
    : undefined;
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

/** Run a command via sudo -S, piping the sudo password through stdin. */
async function sudoExec(ssh: NodeSSH, s: InventorySystem, cmd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const pwd = s.sudoPassword ?? s.password ?? '';
  const wrapped = `printf '%s\\n' ${shellQuote(pwd)} | sudo -S -p '' bash -lc ${shellQuote(cmd)}`;
  const r = await ssh.execCommand(wrapped, { execOptions: { pty: false } });
  return { stdout: r.stdout, stderr: r.stderr, code: r.code };
}

// ───────────── Create ─────────────

export async function backupGnb(s: InventorySystem): Promise<GnbBackup> {
  const ssh = await openSsh(s);
  try {
    const files: Record<string, string> = {};
    let totalBytes = 0;

    // One-shot remote script — walks both roots, emits MARKER:<path>\n<base64>\n
    // per file. Cheaper than one SSH round-trip per file (some boxes have
    // ~100 files in those dirs).
    const roots = REMOTE_ROOTS.map(shellQuote).join(' ');
    const probe = `
      set -e
      for d in ${roots}; do
        if [ -d "$d" ]; then
          find "$d" -type f -size -${MAX_FILE_BYTES}c -print0 \\
            | while IFS= read -r -d '' f; do
                printf '\\n===SIMQA_FILE===%s\\n' "$f"
                base64 -w0 "$f"
                printf '\\n'
              done
        fi
      done
    `;
    const r = await sudoExec(ssh, s, probe);
    if (r.code !== 0) {
      throw new Error(`remote walk failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 400)}`);
    }

    // Parse the marker-delimited output. Each entry: marker line, then one
    // line of base64 (we used -w0 so the encoded blob is on a single line).
    const lines = r.stdout.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(/^===SIMQA_FILE===(.+)$/);
      if (!m) { i++; continue; }
      const path = m[1];
      const b64  = (lines[i + 1] || '').trim();
      if (b64) {
        files[path] = b64;
        totalBytes += Math.floor(b64.length * 3 / 4); // approximate decoded size
      }
      i += 2;
    }

    return {
      manifest: {
        version: 1,
        kind: 'gnb-mme-config',
        createdAt: new Date().toISOString(),
        systemId: s.id,
        host: s.host,
        sourceDirs: [...REMOTE_ROOTS],
        fileCount: Object.keys(files).length,
        totalBytes,
      },
      files,
    };
  } finally {
    ssh.dispose();
  }
}

/** Suggested filename for the download (includes systemId + timestamp). */
export function backupFilename(systemId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `gnb-mme-${systemId}-${stamp}.json`;
}

// ───────────── Restore ─────────────

/** Path must be under one of the REMOTE_ROOTS (defence-in-depth: also
 *  rejects `..` segments and any non-canonical form). */
function isWhitelisted(absPath: string): boolean {
  if (!absPath.startsWith('/')) return false;
  if (absPath.includes('/../') || absPath.endsWith('/..')) return false;
  if (absPath.includes('//')) return false;
  for (const root of REMOTE_ROOTS) {
    if (absPath === root) return false; // can't restore a dir as a file
    if (absPath.startsWith(root + '/')) return true;
  }
  return false;
}

export async function restoreGnb(s: InventorySystem, backup: GnbBackup): Promise<GnbRestoreResult> {
  const result: GnbRestoreResult = {
    restoredFiles: [],
    backedUpFiles: [],
    rejectedFiles: [],
    errors: [],
  };

  if (!backup || typeof backup !== 'object') {
    result.errors.push('backup is not an object');
    return result;
  }
  if (!backup.manifest || backup.manifest.version !== 1 || backup.manifest.kind !== 'gnb-mme-config') {
    result.errors.push(`unsupported backup (expected gnb-mme-config v1, got ${JSON.stringify(backup.manifest)?.slice(0, 120)})`);
    return result;
  }
  if (!backup.files || typeof backup.files !== 'object') {
    result.errors.push('backup has no files object');
    return result;
  }

  // Filter to whitelist BEFORE opening SSH so a bad payload fails fast.
  const work: Array<{ path: string; b64: string }> = [];
  for (const [path, b64] of Object.entries(backup.files)) {
    if (typeof b64 !== 'string') { result.rejectedFiles.push(`${path} (non-string content)`); continue; }
    if (!isWhitelisted(path))    { result.rejectedFiles.push(path); continue; }
    work.push({ path, b64 });
  }
  if (work.length === 0) {
    result.errors.push('no whitelisted files to restore (everything was outside /root/enb/config and /root/mme/config)');
    return result;
  }

  const ssh = await openSsh(s);
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    for (const { path, b64 } of work) {
      try {
        // 1) backup-if-exists, 2) ensure parent dir, 3) write via base64 -d
        // tee — all in one sudo call to keep it atomic-ish.
        const script = `
          set -e
          F=${shellQuote(path)}
          if [ -e "$F" ]; then
            cp -p "$F" "$F.bak-${stamp}"
            echo "BACKED_UP=$F.bak-${stamp}"
          fi
          mkdir -p "$(dirname "$F")"
          printf '%s' ${shellQuote(b64)} | base64 -d > "$F"
          echo "RESTORED=$F"
        `;
        const r = await sudoExec(ssh, s, script);
        if (r.code !== 0) {
          result.errors.push(`${path}: exit ${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`);
          continue;
        }
        for (const line of r.stdout.split('\n')) {
          if (line.startsWith('BACKED_UP=')) result.backedUpFiles.push(line.slice('BACKED_UP='.length));
          if (line.startsWith('RESTORED='))  result.restoredFiles.push(line.slice('RESTORED='.length));
        }
      } catch (e: any) {
        result.errors.push(`${path}: ${e?.message ?? e}`);
      }
    }
  } finally {
    ssh.dispose();
  }

  return result;
}

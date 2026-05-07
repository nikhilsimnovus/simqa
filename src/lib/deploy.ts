// Push generated cfg files to a target system over SSH and bounce the
// matching service. Layout follows the Simnovus convention:
//
//   /root/enb/config/{enb,gnb}.cfg     -> service `lte`     (port 9001/9002)
//   /root/mme/config/{mme,ims,ue_db}.cfg -> service `ltemme` (port 9000)
//   /root/ue/config/ue.cfg              -> service `lteue`  (port 9002)
//
// The deploy is non-destructive in -DryRun mode: it simulates every step
// and returns a structured log so the UI can show what would have happened.

import { NodeSSH } from 'node-ssh';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { InventorySystem } from './inventory';

/**
 * Resolve a private key field to its contents. Accepts either:
 *   - the raw key (anything starting with "-----BEGIN")
 *   - a filesystem path (absolute, or relative to process.cwd() / project root)
 */
function resolvePrivateKey(field: string | undefined): string | undefined {
  if (!field) return undefined;
  const s = field.trim();
  if (s.startsWith('-----BEGIN')) return s;
  // Treat as path. Try as-is, then relative to cwd, then relative to user home.
  const candidates = [
    s,
    path.resolve(process.cwd(), s),
    path.resolve(os.homedir(), s.replace(/^~[\/\\]/, '')),
  ];
  for (const c of candidates) {
    try { return fs.readFileSync(c, 'utf8'); } catch { /* try next */ }
  }
  throw new Error(`private key not found at: ${candidates.join(', ')}`);
}

/** Build the auth half of the SSH connect config for a system. */
function sshAuth(target: InventorySystem): { password?: string; privateKey?: string; passphrase?: string } {
  if (target.authMode === 'privateKey') {
    const pk = resolvePrivateKey(target.privateKey);
    if (!pk) throw new Error(`target ${target.id}: authMode=privateKey but no privateKey set`);
    return { privateKey: pk, passphrase: target.passphrase };
  }
  if (!target.password) throw new Error(`target ${target.id}: no password set`);
  return { password: target.password };
}

/** Build the sudo prefix. Falls back to the SSH password if sudoPassword is unset. */
function sudoPrefix(target: InventorySystem): string {
  const pwd = target.sudoPassword ?? (target.authMode !== 'privateKey' ? target.password : '') ?? '';
  if (!pwd) return 'sudo -n';            // NOPASSWD path; will fail loudly if sudo asks.
  const escaped = pwd.replace(/'/g, "'\\''");
  return `echo '${escaped}' | sudo -S -p ''`;
}

export type ModuleName = 'enb' | 'gnb' | 'mme' | 'ims' | 'ue' | 'ue_db';

interface ModuleEntry {
  configPath: string;
  service: string;     // empty = no restart needed
  checkPort: number;   // 0 = no probe
}

const MODULE_MAP: Record<ModuleName, ModuleEntry> = {
  enb:   { configPath: '/root/enb/config/enb.cfg',   service: 'lte',    checkPort: 9001 },
  gnb:   { configPath: '/root/enb/config/gnb.cfg',   service: 'lte',    checkPort: 9002 },
  mme:   { configPath: '/root/mme/config/mme.cfg',   service: 'ltemme', checkPort: 9000 },
  ims:   { configPath: '/root/mme/config/ims.cfg',   service: 'ltemme', checkPort: 9000 },
  ue:    { configPath: '/root/ue/config/ue.cfg',     service: 'lteue',  checkPort: 9002 },
  ue_db: { configPath: '/root/mme/config/ue_db.cfg', service: '',       checkPort: 0    },
};

export interface DeployStep {
  step: string;
  ok: boolean;
  detail?: string;
  ms?: number;
}

export interface DeployResult {
  ok: boolean;
  module: ModuleName;
  steps: DeployStep[];
  /** Reason the deploy didn't reach success — first failed step's detail. */
  error?: string;
}

export interface DeployOpts {
  /** Don't connect / push; only simulate the steps. */
  dryRun?: boolean;
}

const q = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Push one module to one system and restart its service.
 */
export async function deployModule(
  target: InventorySystem,
  module: ModuleName,
  configContent: string,
  opts: DeployOpts = {},
): Promise<DeployResult> {
  const map = MODULE_MAP[module];
  const steps: DeployStep[] = [];
  const stamp = (step: DeployStep) => { steps.push(step); };

  // Validation
  if (!map) {
    return { ok: false, module, steps, error: `unknown module ${module}` };
  }
  if (!target.host) {
    return { ok: false, module, steps, error: `target ${target.id} has no host` };
  }
  if (!opts.dryRun) {
    if (!target.username) {
      return { ok: false, module, steps, error: `target ${target.id} has no SSH username` };
    }
    const mode = target.authMode ?? 'password';
    if (mode === 'password' && !target.password) {
      return { ok: false, module, steps, error: `target ${target.id} has authMode=password but no password set (or use --dry-run)` };
    }
    if (mode === 'privateKey' && !target.privateKey) {
      return { ok: false, module, steps, error: `target ${target.id} has authMode=privateKey but no privateKey set` };
    }
  }

  // Sanity check on cfg contents
  if (!/\{[\s\S]*\}/.test(configContent)) {
    stamp({ step: 'validate', ok: false, detail: 'config missing top-level { ... } block' });
    return { ok: false, module, steps, error: 'invalid cfg' };
  }
  stamp({ step: 'validate', ok: true, detail: `${configContent.length} bytes` });

  if (opts.dryRun) {
    stamp({ step: 'plan-scp',     ok: true, detail: `would scp -> ${target.host}:${map.configPath}` });
    if (map.service)   stamp({ step: 'plan-restart', ok: true, detail: `would systemctl restart ${map.service}` });
    if (map.checkPort) stamp({ step: 'plan-probe',   ok: true, detail: `would probe :${map.checkPort}` });
    return { ok: true, module, steps };
  }

  // Real deploy. Stage local tmp file, SCP to remote tmp, sudo mv into place,
  // restart service, probe port.
  const localTmp = path.join(os.tmpdir(), `simqa-${module}-${Date.now()}.cfg`);
  fs.writeFileSync(localTmp, configContent, 'utf8');

  const ssh = new NodeSSH();
  try {
    const t0 = Date.now();
    const auth = sshAuth(target);
    await ssh.connect({
      host: target.host,
      port: target.sshPort ?? 22,
      username: String(target.username),
      ...auth,
      readyTimeout: 10000,
    });
    const authLabel = target.authMode === 'privateKey' ? 'privateKey' : 'password';
    stamp({ step: 'connect', ok: true, detail: `auth=${authLabel}`, ms: Date.now() - t0 });

    const remoteTmp = `/tmp/simqa-${module}-${Date.now()}.cfg`;
    const t1 = Date.now();
    await ssh.putFile(localTmp, remoteTmp);
    stamp({ step: 'scp', ok: true, detail: `${localTmp} -> ${target.host}:${remoteTmp}`, ms: Date.now() - t1 });

    const sudo = sudoPrefix(target);

    const mvCmd = `${sudo} mv ${q(remoteTmp)} ${q(map.configPath)} && ${sudo} chown root:root ${q(map.configPath)}`;
    const tMv = Date.now();
    const mvR = await ssh.execCommand(mvCmd);
    if (mvR.code !== 0) {
      stamp({ step: 'mv', ok: false, detail: (mvR.stderr || mvR.stdout || '').slice(-500), ms: Date.now() - tMv });
      return { ok: false, module, steps, error: 'mv failed (sudo / permissions)' };
    }
    stamp({ step: 'mv', ok: true, detail: `-> ${map.configPath}`, ms: Date.now() - tMv });

    if (map.service) {
      const tR = Date.now();
      const rR = await ssh.execCommand(`${sudo} systemctl restart ${map.service}`);
      const ok = rR.code === 0;
      stamp({ step: 'restart', ok, detail: ok ? `systemctl restart ${map.service}` : (rR.stderr || rR.stdout).slice(-500), ms: Date.now() - tR });
      if (!ok) return { ok: false, module, steps, error: `restart ${map.service} failed` };
    }

    if (map.checkPort) {
      const tP = Date.now();
      // Wait up to 15s for the port to come up.
      const probe = `for i in $(seq 1 15); do ss -lnt 2>/dev/null | grep -qE ":${map.checkPort}\\b" && echo OK && exit 0; sleep 1; done; echo TIMEOUT; exit 1`;
      const pR = await ssh.execCommand(probe);
      const ok = pR.code === 0;
      stamp({ step: 'probe', ok, detail: ok ? `:${map.checkPort} listening` : `port ${map.checkPort} not listening within 15s`, ms: Date.now() - tP });
      if (!ok) return { ok: false, module, steps, error: `${map.service} did not bind :${map.checkPort}` };
    }

    return { ok: true, module, steps };
  } catch (e: any) {
    stamp({ step: 'connect', ok: false, detail: e?.message ?? String(e) });
    return { ok: false, module, steps, error: e?.message ?? 'ssh connect failed' };
  } finally {
    try { ssh.dispose(); } catch {}
    try { fs.unlinkSync(localTmp); } catch {}
  }
}

/**
 * Deploy a full bundle (multiple cfgs) to a single target system.
 * Order matters: ue_db first (data only), then mme, then ims, then enb/gnb.
 * If any module fails, subsequent ones are skipped and reported.
 */
export async function deployBundle(
  target: InventorySystem,
  files: Record<string, string>,
  opts: DeployOpts = {},
): Promise<{ ok: boolean; modules: DeployResult[] }> {
  const order: ModuleName[] = ['ue_db', 'mme', 'ims', 'enb', 'gnb', 'ue'];
  const results: DeployResult[] = [];

  for (const m of order) {
    const fname = `${m}.cfg`;
    if (!files[fname]) continue;
    const r = await deployModule(target, m, files[fname], opts);
    results.push(r);
    if (!r.ok) {
      return { ok: false, modules: results };
    }
  }
  return { ok: true, modules: results };
}

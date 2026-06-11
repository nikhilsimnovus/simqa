// POST /api/update
//
// Self-update from GitHub. The Update pill in the sidebar topbar hits
// this, which runs `sudo -n /usr/local/sbin/simqa-update`. The wrapper
// (planted by install.sh) downloads main.tar.gz from
// https://github.com/nikhilsimnovus/simqa, extracts it, then re-runs
// scripts/install.sh from the extracted tree.
//
// install.sh restarts the systemd unit at the end, which often kills our
// own process before the HTTP response is fully flushed — the client
// treats "fetch failed mid-stream" as expected success and reloads after
// a few seconds.
//
// Mirror of the perf-qa (OneClick) self-update pattern in
// perf-qa/scripts/install.sh + perf-qa/ui/app.py.

import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

export const dynamic = 'force-dynamic';
export const maxDuration = 1800;  // up to 30 min for the npm install + build

const UPDATER_PATH = '/usr/local/sbin/simqa-update';
const REPO_TARBALL = process.env.SIMQA_UPDATE_TARBALL
  ?? 'https://github.com/nikhilsimnovus/simqa/archive/refs/heads/main.tar.gz';

interface UpdateResult { ok: boolean; log: string; }

function runUpdater(): Promise<UpdateResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'sudo',
      ['-n', UPDATER_PATH],
      {
        env: { ...process.env, SIMQA_UPDATE_TARBALL: REPO_TARBALL },
        // 29 min — a cold npm ci + next build on a loaded lab host can take
        // well over the old 580s, and a kill BETWEEN build and the systemctl
        // restart strands a fully-built tree with the old service still
        // serving (observed live 2026-06-11). install.sh now also schedules
        // a detached restart right after the build as a second safety net.
        timeout: 1_740_000,
        maxBuffer: 8 * 1024 * 1024, // capture up to 8MB of output
      },
      (err, stdout, stderr) => {
        const tailStdout = (stdout ?? '').slice(-4000);
        const tailStderr = (stderr ?? '').slice(-2000);
        const log = `${tailStdout}${tailStderr ? '\n--- stderr ---\n' + tailStderr : ''}`;
        if (err) {
          resolve({ ok: false, log: log + `\n[update] exited ${(err as any).code ?? '?'}: ${err.message}` });
        } else {
          resolve({ ok: true, log: log + '\n[update] done' });
        }
      },
    );
    // Belt-and-suspenders: if execFile sticks for any reason, settle the
    // promise on the timeout signal.
    child.on('error', (e) => resolve({ ok: false, log: `[update] spawn FAILED: ${e.message}` }));
  });
}

export async function POST() {
  if (!fs.existsSync(UPDATER_PATH)) {
    return NextResponse.json({
      ok: false,
      log: `[update] ${UPDATER_PATH} missing — this install isn't on the self-update layout. Run scripts/install.sh once on the host to plant the wrapper + sudoers entry.`,
    }, { status: 500 });
  }
  const r = await runUpdater();
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}

/** GET — surface whether the self-update wrapper is installed at all,
 *  so the UI can hide / disable the Update button when this is just a
 *  dev workstation. */
export async function GET() {
  const present = fs.existsSync(UPDATER_PATH);
  return NextResponse.json({
    ok: true,
    available: present,
    updaterPath: UPDATER_PATH,
    repoTarball: REPO_TARBALL,
  });
}

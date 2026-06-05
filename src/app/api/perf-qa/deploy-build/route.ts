/**
 * Build + stream a deployable perf-qa tarball on demand.
 *
 * Spawns `tar` against the repo's `perf-qa/` subdirectory and streams the
 * gzipped output straight back to the browser. The tarball includes a
 * one-shot installer script (`scripts/install.sh`) the customer runs as
 * root to lay everything down — distro detection + apt/dnf prereq install +
 * user/dirs + Python venv with Flask + Playwright + systemd unit on 8080.
 *
 * Re-runs on every click so the tarball always reflects the current
 * checked-in state of `perf-qa/` — no stale `dist/` artifact to forget.
 */
import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

// Whitelist exactly the files we package — never glob, since we don't want
// to accidentally ship `profiles.json` (live creds) or `__pycache__/` or
// anything the user might dump into perf-qa/ later.
const PACKAGED_FILES = [
  'INSTALL.md',
  'README.md',
  'collect_perf_data.sh',
  'analyze_bundle.py',
  'build_system_md.py',
  'beszel_screenshot.py',
  'simnovator_screenshot.py',
  'setup.conf.example',
  'scripts/install.sh',
  'ui/app.py',
  'ui/perf-qa-ui.service',
  'ui/favicon.png',
  'ui/logo_light.svg',
  'ui/logo_dark.svg',
];

export const dynamic = 'force-dynamic';   // Always rebuild, never cache.
export const runtime = 'nodejs';          // child_process needs Node runtime.

export async function GET() {
  // Resolve perf-qa/ relative to the simqa repo root. process.cwd() is the
  // Next.js project root (next.config.mjs is alongside it).
  const repoRoot = process.cwd();
  const perfQaDir = path.join(repoRoot, 'perf-qa');

  // Sanity: confirm perf-qa/ exists + the headline file is there. Without
  // this a misconfigured install would silently return a 0-byte tarball.
  try {
    const stat = await fs.stat(path.join(perfQaDir, 'collect_perf_data.sh'));
    if (!stat.isFile()) throw new Error('not a file');
  } catch (e) {
    return NextResponse.json(
      { error: 'perf-qa/collect_perf_data.sh missing at repo root', repoRoot },
      { status: 500 },
    );
  }

  // Pre-flight: every file in PACKAGED_FILES must exist. If any is missing
  // we'd silently produce a broken tarball, so 500 instead.
  const missing: string[] = [];
  for (const rel of PACKAGED_FILES) {
    try { await fs.stat(path.join(perfQaDir, rel)); }
    catch { missing.push(rel); }
  }
  if (missing.length) {
    return NextResponse.json(
      { error: 'tarball would be incomplete — missing files', missing },
      { status: 500 },
    );
  }

  // Pre-staged Playwright browsers (~150 MB) live at perf-qa/vendor/
  // playwright-browsers/. Auto-include them if present — the customer's
  // install.sh will copy them into the perfqa user's Playwright cache so
  // the browser download never happens at the customer site.
  // Populated locally by:  bash perf-qa/scripts/fetch-vendor.sh
  const vendorDir = path.join(perfQaDir, 'vendor', 'playwright-browsers');
  let vendorBytes = 0;
  let vendorPresent = false;
  try {
    const s = await fs.stat(vendorDir);
    vendorPresent = s.isDirectory();
    if (vendorPresent) {
      // Sum size for the X-Vendor-Bytes response header so the UI can show
      // "Tarball includes 152 MB of pre-staged browsers" or similar.
      async function dirSize(p: string): Promise<number> {
        const entries = await fs.readdir(p, { withFileTypes: true });
        let total = 0;
        for (const e of entries) {
          const ep = path.join(p, e.name);
          if (e.isDirectory()) total += await dirSize(ep);
          else if (e.isFile()) total += (await fs.stat(ep)).size;
        }
        return total;
      }
      vendorBytes = await dirSize(vendorDir);
    }
  } catch {
    vendorPresent = false;
  }

  // Spawn tar with --transform so paths inside the archive start with
  // "perf-qa/" — that's what install.sh expects when the customer cds
  // into the unpacked dir.
  const tarTargets: string[] = [
    ...PACKAGED_FILES.map((f) => path.posix.join('perf-qa', f)),
  ];
  if (vendorPresent) {
    tarTargets.push('perf-qa/vendor/playwright-browsers');
  }
  const tarArgs = [
    'czf', '-',
    '-C', repoRoot,
    '--owner=0', '--group=0',  // reproducible — no user from the build host
    ...tarTargets,
  ];

  const tar = spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Capture stderr so a tar failure surfaces in the simqa server log.
  const stderrChunks: Buffer[] = [];
  tar.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
  tar.on('exit', (code) => {
    if (code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[deploy-build] tar exited', code,
        Buffer.concat(stderrChunks).toString('utf8'));
    }
  });

  // Convert Node's Readable to a Web ReadableStream so we can hand it to
  // NextResponse. Node 18+ has Readable.toWeb().
  const webStream = Readable.toWeb(tar.stdout) as ReadableStream<Uint8Array>;

  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '_');
  const filename = `perf-qa-deploy-${ts}.tar.gz`;

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // The tarball is streamed before we know its full size — explicitly
      // disable any intermediate caching so we always re-run the build.
      'Cache-Control': 'no-store, max-age=0',
      // Surface whether Playwright browsers are bundled. The Perf QA page
      // reads these via a HEAD on this endpoint to show the user a hint
      // like "Bundled (152 MB)" or "Not bundled — run fetch-vendor.sh".
      'X-Vendor-Browsers': vendorPresent ? 'bundled' : 'missing',
      'X-Vendor-Bytes': String(vendorBytes),
    },
  });
}

#!/usr/bin/env node
/**
 * Build a release tarball for distribution.
 *
 * Output: dist/qakabaap-<YYYYMMDD>-<short-sha>.tar.gz
 *
 * The tarball, when extracted, produces a single qakabaap-<version>/
 * directory containing every tracked file at HEAD plus install.cjs and
 * INSTALL.md. The user runs `node install.cjs` inside it to set everything
 * up.
 *
 * Excluded automatically (via git archive): node_modules, .next, data/,
 * output/, .out/, inventory.yaml, *.tsbuildinfo, etc. — anything in
 * .gitignore that git doesn't track.
 *
 * Cross-platform: uses system `tar` (built into Windows 10+, present on
 * any Linux / macOS) and system `git`. No npm deps.
 *
 * Usage:
 *   node scripts/release.cjs
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m',
};

function ok(s)   { console.log(`${C.green}✓${C.reset} ${s}`); }
function info(s) { console.log(`${C.dim}  ${s}${C.reset}`); }
function fail(s) { console.error(`\n${C.red}✗ ${s}${C.reset}\n`); process.exit(1); }

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

// ── Version: date + short sha (or "nogit" if not a git checkout) ─────────
let sha;
try { sha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); }
catch { sha = 'nogit'; }
const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const version = `qakabaap-${date}-${sha}`;
ok(`Version: ${C.bold}${version}${C.reset}`);

// ── Stage everything under a temp/<version>/ so the tarball extracts as a
// single clean directory. ───────────────────────────────────────────────────
const distDir  = path.join(ROOT, 'dist');
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qakabaap-rel-'));
const relDir   = path.join(stageDir, version);
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(relDir,  { recursive: true });
info(`Staging in: ${stageDir}`);

// ── Pull tracked files at HEAD via `git archive`. Respects .gitignore by
// definition — only tracked files get included. ─────────────────────────────
info('Exporting tracked files from git HEAD...');
const archiveFile = path.join(stageDir, 'src.tar');
const ga = spawnSync('git', ['archive', '--format=tar', '-o', archiveFile, 'HEAD'], { stdio: 'inherit' });
if (ga.status !== 0) fail('git archive failed. Is this a git checkout?');

info('Unpacking into stage directory...');
// On Windows, passing an absolute path like `C:\...` to `-C` makes tar
// interpret the colon as a remote host. Avoid by changing directory via
// child_process cwd:, and pass the archive file as a relative path.
const archiveRelToRelDir = path.relative(relDir, archiveFile);
const ux = spawnSync('tar', ['-xf', archiveRelToRelDir], { stdio: 'inherit', cwd: relDir });
if (ux.status !== 0) fail('tar extraction failed.');
fs.unlinkSync(archiveFile);
ok('Source staged');

// ── Drop install.cjs + INSTALL.md at the root of the staged dir. They're
// already in the repo at the root, so git archive includes them — but we
// also chmod install.cjs so it's executable on Linux/macOS. ──────────────
const installPath = path.join(relDir, 'install.cjs');
if (fs.existsSync(installPath)) {
  fs.chmodSync(installPath, 0o755);
  ok('install.cjs marked executable');
} else {
  fail('install.cjs not found in staged tree. Did you commit it?');
}

if (!fs.existsSync(path.join(relDir, 'INSTALL.md'))) {
  fail('INSTALL.md not found in staged tree. Did you commit it?');
}
ok('INSTALL.md present');

// ── Stamp the version into SIMQA_VERSION.txt at the staged root. ──────────
// src/lib/version.ts reads this at runtime; that way even if the user
// renames the extracted dir off the qakabaap-<date>-<sha> pattern the
// sidebar still shows the right version.
const versionTxt = {
  version: `${date}-${sha}`,
  sha,
  date,
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(relDir, 'SIMQA_VERSION.txt'), JSON.stringify(versionTxt, null, 2) + '\n');
ok(`SIMQA_VERSION.txt written (${versionTxt.version})`);

// Sanity: must not include inventory.yaml or data/ — those are user / runtime.
const banned = ['inventory.yaml', 'data', '.next', 'node_modules', 'output'];
for (const b of banned) {
  if (fs.existsSync(path.join(relDir, b))) {
    fail(`Release would include "${b}" which must not ship. Fix .gitignore.`);
  }
}
ok('No user/runtime artifacts leaked');

// ── Pack the tarball. Same Windows-colon caveat: run tar from stageDir so
// the version dir is just a relative name, and write the output to a path
// relative to stageDir to keep the C:\ out of tar's argv. ──────────────────
const outFile = path.join(distDir, `${version}.tar.gz`);
info(`Packing ${path.relative(ROOT, outFile)}...`);
const outRelToStage = path.relative(stageDir, outFile);
const pack = spawnSync('tar', ['-czf', outRelToStage, version], { stdio: 'inherit', cwd: stageDir });
if (pack.status !== 0) fail('tar pack failed.');
const sizeBytes = fs.statSync(outFile).size;
const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
ok(`Built: ${C.bold}${path.relative(ROOT, outFile)}${C.reset} (${sizeMB} MB)`);

// ── Cleanup stage. ─────────────────────────────────────────────────────────
fs.rmSync(stageDir, { recursive: true, force: true });

// ── Summary. ───────────────────────────────────────────────────────────────
const sep = '─'.repeat(60);
console.log(`
${C.green}${sep}${C.reset}
${C.bold}Release ready.${C.reset}

  File:  ${C.bold}${path.relative(ROOT, outFile)}${C.reset}
  Size:  ${sizeMB} MB
  Sha:   ${sha}

Share this file with whoever needs to test/run QA Ka BAAP elsewhere.

On the target machine (Windows / Linux / macOS, Node 18+):
  ${C.cyan}1.${C.reset} tar -zxvf ${version}.tar.gz
  ${C.cyan}2.${C.reset} cd ${version}
  ${C.cyan}3.${C.reset} node install.cjs
  ${C.cyan}4.${C.reset} edit inventory.yaml
  ${C.cyan}5.${C.reset} npm run dev   →  http://localhost:4000

See INSTALL.md inside the tarball for the full guide.
${C.green}${sep}${C.reset}
`);

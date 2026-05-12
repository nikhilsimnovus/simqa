#!/usr/bin/env node
/**
 * Cross-platform installer for QA Ka BAAP.
 *
 * Run after extracting the release tarball. Works on Windows, Linux, macOS —
 * the only prerequisite is Node 18+, which you need anyway to run the app.
 *
 * Usage:
 *   tar -zxvf qakabaap-<version>.tar.gz
 *   cd qakabaap-<version>
 *   node install.cjs
 *
 * Optional flags:
 *   --skip-playwright   skip Playwright Chromium download (use system Chrome
 *                       at runtime, or accept that browser-driven features
 *                       won't be available — see the feature matrix below)
 *   --port <n>          set the default port (writes .env.local with PORT=n)
 *                       — overrides the built-in default of 4000
 *   --no-prompt         non-interactive; never ask before doing things
 *
 * Feature matrix when Chromium / system Chrome / Edge are ALL unavailable
 * (offline, locked-down customer site):
 *
 *   ✓ Tools → UE-sim cfg patcher  (SSH only, no browser)
 *   ✓ API Tests                    (HTTP only)
 *   ✓ Test Cases / Inventory / Systems Mgmt / Runs / Settings
 *   ✗ Build Check                  (drives Cockpit terminal via Playwright)
 *   ✗ UI Tests                     (Playwright drives the Simnovator web UI)
 *
 * If the box has Chrome or Edge installed, Build Check + UI Tests still
 * work — Playwright launches the system browser via channel: 'chrome' /
 * 'msedge'. Only the bundled-Chromium download itself is skipped.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rawArgs   = process.argv.slice(2);
const argv      = new Set(rawArgs);
const SKIP_PW   = argv.has('--skip-playwright');
const NO_PROMPT = argv.has('--no-prompt');
const PORT_IDX  = rawArgs.indexOf('--port');
const CUSTOM_PORT = PORT_IDX >= 0 ? rawArgs[PORT_IDX + 1] : null;

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

function header(s) { console.log(`\n${C.bold}${C.cyan}${s}${C.reset}`); }
function ok(s)     { console.log(`${C.green}✓${C.reset} ${s}`); }
function info(s)   { console.log(`${C.dim}  ${s}${C.reset}`); }
function warn(s)   { console.warn(`${C.yellow}!${C.reset} ${s}`); }
function fail(s)   { console.error(`\n${C.red}✗ ${s}${C.reset}\n`); process.exit(1); }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) fail(`Command failed (exit ${r.status}): ${cmd} ${args.join(' ')}`);
}

// ───── 1. Node version check ─────
header('1. Node version');
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  fail(`Node 18+ required, you have ${process.versions.node}.\n  Install from https://nodejs.org/ and re-run this script.`);
}
ok(`Node ${process.versions.node} on ${process.platform}-${process.arch}`);

// ───── 2. Sanity checks ─────
header('2. Sanity checks');
if (!fs.existsSync('package.json')) {
  fail('package.json not found. Run this from the extracted tarball directory.');
}
ok('package.json found');

if (!fs.existsSync('package-lock.json')) {
  warn('package-lock.json missing — npm install will resolve versions fresh. This is fine but slower.');
} else {
  ok('package-lock.json found (reproducible install)');
}

// ───── 3. npm install ─────
header('3. Installing dependencies');
info('This downloads ~200 MB of npm packages. Takes 1-3 minutes on a fast network.');
const useCi = fs.existsSync('package-lock.json');
run('npm', [useCi ? 'ci' : 'install']);
ok(`Dependencies installed (npm ${useCi ? 'ci' : 'install'})`);

// ───── 4. Playwright Chromium ─────
//
// Optional. Only Build Check + UI Tests need a browser. Runtime fallback
// order: system Chrome → system Edge → bundled Chromium → bundled Firefox.
// So if either Chrome or Edge is installed on the box (which is the case on
// virtually all Windows machines), browser features work even WITHOUT this
// download. Most customer sites hit this path because corporate firewalls
// block playwright.azureedge.net.
if (SKIP_PW) {
  header('4. Playwright Chromium (skipped via --skip-playwright)');
  info('Build Check + UI Tests will try system Chrome / Edge at launch time.');
  info('If neither is installed, those two features will fail with a clear error;');
  info('every other feature (API Tests, Tools, Inventory, Test Cases) still works.');
} else {
  header('4. Installing Playwright Chromium');
  info('Used by Build Check (Cockpit terminal automation) and UI Tests. ~150 MB.');
  info('Fine to skip behind a firewall: re-run with --skip-playwright. System Chrome');
  info('or Edge will be used at runtime instead.');
  const r = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    warn('Playwright Chromium download failed (likely firewalled). Not fatal —');
    warn('the app will try system Chrome / Edge at runtime. If neither is');
    warn('installed, Build Check + UI Tests will be unavailable; everything');
    warn('else (API Tests, Tools, Inventory, Test Cases) still works.');
  } else {
    ok('Playwright Chromium installed');
  }
}

// ───── 4.5. Port preference (.env.local) ─────
//
// Default is 4000. If the user passed --port <n>, persist it in .env.local
// so `npm run dev` / `npm run start` pick it up via the PORT env var. .env.local
// is gitignored so this is per-install.
if (CUSTOM_PORT) {
  header(`4.5. Setting default port to ${CUSTOM_PORT}`);
  if (!/^\d+$/.test(CUSTOM_PORT)) {
    fail(`--port value "${CUSTOM_PORT}" is not a number`);
  }
  const envFile = '.env.local';
  let existing = '';
  if (fs.existsSync(envFile)) existing = fs.readFileSync(envFile, 'utf-8');
  // Replace any existing PORT= line, or append.
  if (/^PORT=/m.test(existing)) {
    existing = existing.replace(/^PORT=.*$/m, `PORT=${CUSTOM_PORT}`);
  } else {
    if (existing.length > 0 && !existing.endsWith('\n')) existing += '\n';
    existing += `PORT=${CUSTOM_PORT}\n`;
  }
  fs.writeFileSync(envFile, existing);
  ok(`Wrote PORT=${CUSTOM_PORT} to ${envFile}`);
} else {
  header('4.5. Port');
  info('Default is 4000. To use a different port:');
  info('  • One-off:   npm run dev -- -p 8080');
  info('  • Persistent: re-run install.cjs --port 8080  (writes .env.local)');
  info('  • Env var:   PORT=8080 npm run dev');
}

// ───── 5. inventory.yaml ─────
header('5. Inventory file');
if (fs.existsSync('inventory.yaml')) {
  ok('inventory.yaml already exists — leaving it alone');
} else if (fs.existsSync('inventory.example.yaml')) {
  fs.copyFileSync('inventory.example.yaml', 'inventory.yaml');
  ok('Created inventory.yaml from inventory.example.yaml');
  warn('Edit inventory.yaml before running — at minimum add one SIMNOVATOR system.');
} else {
  warn('No inventory.example.yaml found. You will need to create inventory.yaml manually.');
}

// ───── 6. Done ─────
const here = process.cwd();
const sep = '─'.repeat(60);
const effectivePort = CUSTOM_PORT || '4000';
console.log(`
${C.green}${sep}${C.reset}
${C.bold}QA Ka BAAP installed.${C.reset}

Installed at:
  ${C.dim}${here}${C.reset}

Next steps:
  ${C.cyan}1.${C.reset} Edit ${C.bold}inventory.yaml${C.reset} — add your lab's Simnovator / UESIM / Callbox systems
  ${C.cyan}2.${C.reset} Run: ${C.bold}npm run dev${C.reset}
  ${C.cyan}3.${C.reset} Open: ${C.bold}http://localhost:${effectivePort}${C.reset}

If port ${effectivePort} is blocked / in use, pick another one:
  ${C.bold}npm run dev -- -p 8080${C.reset}              (one-off)
  ${C.bold}PORT=8080 npm run dev${C.reset}                (Linux / macOS)
  ${C.bold}$env:PORT=8080; npm run dev${C.reset}          (PowerShell)
  ${C.bold}node install.cjs --port 8080${C.reset}         (persistent)

For production / always-on:
  ${C.bold}npm run build && npm run start${C.reset}

Docs: README.md  ·  Source: https://github.com/nikhilsimnovus/simqa
${C.green}${sep}${C.reset}
`);

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
 *   --skip-playwright   skip Playwright Chromium download (use system Chrome)
 *   --no-prompt         non-interactive; never ask before doing things
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = new Set(process.argv.slice(2));
const SKIP_PW   = argv.has('--skip-playwright');
const NO_PROMPT = argv.has('--no-prompt');

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
if (SKIP_PW) {
  header('4. Playwright Chromium (skipped via --skip-playwright)');
  info('Build Check + UI Tests will try system Chrome/Edge first before falling back.');
} else {
  header('4. Installing Playwright Chromium');
  info('Used by Build Check (drives Cockpit) and UI Tests. ~150 MB download.');
  info('If this fails behind a firewall, re-run with --skip-playwright and ensure system Chrome is installed.');
  const r = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    warn('Playwright download failed. Continuing — the app will try system Chrome / Edge at runtime.');
  } else {
    ok('Playwright Chromium installed');
  }
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
console.log(`
${C.green}${sep}${C.reset}
${C.bold}QA Ka BAAP installed.${C.reset}

Installed at:
  ${C.dim}${here}${C.reset}

Next steps:
  ${C.cyan}1.${C.reset} Edit ${C.bold}inventory.yaml${C.reset} — add your lab's Simnovator / UESIM / Callbox systems
  ${C.cyan}2.${C.reset} Run: ${C.bold}npm run dev${C.reset}
  ${C.cyan}3.${C.reset} Open: ${C.bold}http://localhost:4000${C.reset}

For production / always-on:
  ${C.bold}npm run build && npm run start${C.reset}

Docs: README.md  ·  Source: https://github.com/nikhilsimnovus/simqa
${C.green}${sep}${C.reset}
`);

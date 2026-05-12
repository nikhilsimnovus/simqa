#!/usr/bin/env node
/**
 * Cross-platform wrapper around `next dev` / `next start` that respects the
 * PORT environment variable. Defaults to 4000 to match the historical port,
 * but at customer sites where 4000 is firewalled the user can:
 *
 *   PORT=8080 npm run dev           # Linux/macOS
 *   $env:PORT=8080; npm run dev     # PowerShell
 *   set PORT=8080 && npm run dev    # cmd.exe
 *
 * Or pass a flag through (npm forwards args after `--`):
 *
 *   npm run dev -- -p 8080
 *
 * Usage:  node scripts/run.cjs <mode>   where <mode> is "dev" or "start"
 */

'use strict';

const { spawn } = require('node:child_process');

const mode = process.argv[2];
if (!['dev', 'start'].includes(mode)) {
  console.error(`Usage: node scripts/run.cjs <dev|start>`);
  process.exit(2);
}

// Forward any extra argv (after the mode) to next — so `npm run dev -- -p 9000`
// still works and overrides our PORT-based default.
const passthrough = process.argv.slice(3);
const wantsPort   = passthrough.includes('-p') || passthrough.includes('--port');
const port        = process.env.PORT ? String(process.env.PORT) : '4000';

const args = [mode];
if (!wantsPort) args.push('-p', port);
args.push(...passthrough);

console.log(`> next ${args.join(' ')}   (PORT=${port}${wantsPort ? ' overridden by -p flag' : ''})`);

// Use shell on Windows so `next` resolves via .cmd shim in node_modules\.bin\.
const child = spawn('next', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  console.error('Failed to launch next:', err.message);
  process.exit(1);
});

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

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Pre-load .env.local so PORT (and any other env the wrapper itself cares
// about) is available before we decide what to pass to next. Next.js will
// load this file too at startup — we're not breaking that, just reading
// it earlier so the wrapper's PORT logic sees the value. Lines that look
// like KEY=VALUE win unless the var is already set in the process env.
const envFile = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && process.env[m[1]] === undefined) {
      // Strip optional surrounding quotes — matches Next.js / dotenv behaviour.
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

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

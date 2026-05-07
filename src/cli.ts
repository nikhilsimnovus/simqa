#!/usr/bin/env node
// simqa CLI. Pulls testcases from a UESIM box, generates cfg bundles, and
// (optionally) drives the full execute / poll / collect loop.
//
// Subcommands:
//   simqa list                              List testcases on the box
//   simqa pull <id...> [--out <dir>]        Pull raw testcase JSON(s)
//   simqa generate <id> [--out <dir>]       Generate enb/gnb/mme/ims/ue_db
//   simqa run <id> [--no-deploy]            Generate -> push -> trigger -> poll -> collect
//   simqa status <executionId>              Get simulator runtime status
//
// All commands honor:
//   --host <ip>     UESIM host (default: env UESIM_HOST or 192.168.1.95)
//   --user <name>   UESIM user (default: env UESIM_USER or admin)
//   --pass <pwd>    UESIM password (default: env UESIM_PASS or admin)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  ensureToken, listTestcases, getTestcase, listSimulators,
  startExecution, stopExecution, getSimulatorStatus, uesimEnvOpts,
} from './lib/uesimClient.js';
import { generateConfigs, type UesimTestDefinition } from './lib/cfgGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------- Argv parsing ----------

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

function apiOptsFromFlags(flags: Record<string, string | boolean>) {
  return uesimEnvOpts({
    host:     typeof flags.host === 'string' ? flags.host : undefined,
    username: typeof flags.user === 'string' ? flags.user : undefined,
    password: typeof flags.pass === 'string' ? flags.pass : undefined,
  });
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function safeSlug(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function ts(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

// ---------- Commands ----------

async function cmdList(parsed: ParsedArgs): Promise<void> {
  const opts = apiOptsFromFlags(parsed.flags);
  const limit = Number(parsed.flags.limit ?? 200);
  const r = await listTestcases(opts, limit, 0);
  console.log(`Found ${r.items.length}${r.total ? `/${r.total}` : ''} testcases on ${opts.host}:`);
  for (const tc of r.items) {
    const last = (tc.metadata as any)?.lastExecution;
    const verdict = last?.result ?? '-';
    const when = last?.executedOn?.slice(0, 10) ?? '';
    console.log(`  ${tc.id.padEnd(40)} ${verdict.padEnd(10)} ${when}`);
  }
}

async function cmdPull(parsed: ParsedArgs): Promise<void> {
  if (parsed.positional.length === 0) throw new Error('pull requires at least one testcase id');
  const opts = apiOptsFromFlags(parsed.flags);
  const outDir = String(parsed.flags.out ?? path.join(PROJECT_ROOT, 'data', 'testcases'));
  ensureDir(outDir);
  for (const id of parsed.positional) {
    const tc = await getTestcase(opts, id);
    const dest = path.join(outDir, `${safeSlug(id)}.json`);
    fs.writeFileSync(dest, JSON.stringify(tc, null, 2), 'utf8');
    console.log(`  ${id} -> ${dest}`);
  }
}

async function cmdGenerate(parsed: ParsedArgs): Promise<void> {
  if (parsed.positional.length === 0) throw new Error('generate requires a testcase id');
  const id = parsed.positional[0];
  const opts = apiOptsFromFlags(parsed.flags);
  const outDir = String(parsed.flags.out ?? path.join(PROJECT_ROOT, 'output', safeSlug(id)));
  ensureDir(outDir);

  const tc = await getTestcase(opts, id);
  if (!tc.testDefinition) throw new Error(`testcase ${id} returned no testDefinition`);
  const bundle = generateConfigs(tc.testDefinition as UesimTestDefinition, id);

  for (const [name, content] of Object.entries(bundle.files)) {
    const dest = path.join(outDir, name);
    fs.writeFileSync(dest, content, 'utf8');
    console.log(`  wrote ${dest}`);
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(bundle.summary, null, 2), 'utf8');
  console.log(`Done. ${Object.keys(bundle.files).length} cfg(s), ${bundle.summary.cells}-cell ${bundle.summary.ratType}, ${bundle.summary.ueCount} UE${bundle.summary.ueCount === 1 ? '' : 's'}`);
  if (bundle.summary.notes.length > 0) {
    console.log('Notes:');
    for (const n of bundle.summary.notes) console.log(`  - ${n}`);
  }
}

async function cmdSimulators(parsed: ParsedArgs): Promise<void> {
  const opts = apiOptsFromFlags(parsed.flags);
  const r = await listSimulators(opts);
  console.log(`Simulators on ${opts.host}:`);
  for (const s of r.items) {
    console.log(`  id=${String(s.id).padEnd(4)} ${s.name.padEnd(20)} type=${s.type.padEnd(6)} ${s.connectivity ?? ''} ${s.stability ?? ''} ${s.availability ?? ''}`);
  }
}

async function cmdRun(parsed: ParsedArgs): Promise<void> {
  if (parsed.positional.length === 0) throw new Error('run requires a testcase id');
  const id = parsed.positional[0];
  const opts = apiOptsFromFlags(parsed.flags);
  const noDeploy = !!parsed.flags['no-deploy'];
  const outDir = String(parsed.flags.out ?? path.join(PROJECT_ROOT, 'output', safeSlug(id) + '_' + ts().replace(/[:T]/g, '-')));
  ensureDir(outDir);

  console.log(`[${ts()}] preflight: login`);
  await ensureToken(opts.host, opts.username, opts.password);

  console.log(`[${ts()}] generate: pulling testcase + emitting cfgs`);
  const tc = await getTestcase(opts, id);
  if (!tc.testDefinition) throw new Error(`no testDefinition`);
  const bundle = generateConfigs(tc.testDefinition as UesimTestDefinition, id);
  for (const [name, content] of Object.entries(bundle.files)) {
    fs.writeFileSync(path.join(outDir, name), content, 'utf8');
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(bundle.summary, null, 2), 'utf8');
  console.log(`  wrote ${Object.keys(bundle.files).join(', ')}`);

  if (noDeploy) {
    console.log(`[${ts()}] deploy: skipped (--no-deploy)`);
    console.log(`[${ts()}] trigger: skipped (--no-deploy)`);
    return;
  }

  console.log(`[${ts()}] deploy: pending — inventory.yaml not yet wired into CLI (next slice)`);
  console.log(`[${ts()}] trigger: POST /v2/testcases/${id}/executions`);
  const start = await startExecution(opts, id, {});
  console.log(`  ${JSON.stringify(start)}`);

  // Poll the testcase's last execution status via the simulator runtime endpoint.
  // We rely on the testcase record's lastExecution.simulatorId (set by the box
  // when an execution starts).
  const maxPolls = Number(parsed.flags['max-polls'] ?? 60);
  const intervalSec = Number(parsed.flags['interval'] ?? 5);
  let terminal = false;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
    const refreshed = await getTestcase(opts, id);
    const last = (refreshed.metadata as any)?.lastExecution;
    const status = last?.status ?? '?';
    const result = last?.result ?? '?';
    console.log(`[${ts()}] poll ${i + 1}/${maxPolls}: status=${status} result=${result}`);
    if (status === 'COMPLETED' || status === 'ABORTED' || status === 'STOPPED') {
      fs.writeFileSync(path.join(outDir, 'execution.json'), JSON.stringify(last, null, 2), 'utf8');
      terminal = true;
      break;
    }
  }
  if (!terminal) {
    console.log(`[${ts()}] poll timeout — execution still in progress; last state saved`);
  }
}

async function cmdStop(parsed: ParsedArgs): Promise<void> {
  const exId = parsed.positional[0] ?? 'current';
  const simId = typeof parsed.flags.simulator === 'string' ? parsed.flags.simulator : undefined;
  const opts = apiOptsFromFlags(parsed.flags);
  const r = await stopExecution(opts, exId, simId);
  console.log(JSON.stringify(r, null, 2));
}

async function cmdSimStatus(parsed: ParsedArgs): Promise<void> {
  if (parsed.positional.length === 0) throw new Error('sim-status requires a simulatorId');
  const opts = apiOptsFromFlags(parsed.flags);
  const r = await getSimulatorStatus(opts, parsed.positional[0]);
  console.log(JSON.stringify(r, null, 2));
}

function help(): void {
  console.log([
    'simqa - QA tooling for Simnovator UESIM',
    '',
    'Commands:',
    '  list                          List testcases on the UESIM box',
    '  simulators                    List registered simulators',
    '  pull <id...> [--out DIR]      Save raw testcase JSON',
    '  generate <id> [--out DIR]     Pull testcase + emit cfgs (no deploy)',
    '  run <id>                      Pull + generate + trigger + poll execution',
    '  run <id> --no-deploy          Pull + generate only (smoke test)',
    '  stop <executionId>            Stop a running execution (id or "current")',
    '  sim-status <simulatorId>      Get runtime status of a simulator',
    '',
    'Common flags:',
    '  --host IP   --user NAME   --pass PWD',
    '              (default: env UESIM_HOST/UESIM_USER/UESIM_PASS or 192.168.1.95/admin/admin)',
    '',
    'Examples:',
    '  simqa list',
    '  simqa generate Demo-5G-SA-Attach_',
    '  simqa run Demo-5G-SA-Attach_ --no-deploy',
  ].join('\n'));
}

// ---------- Main ----------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  try {
    switch (parsed.command) {
      case 'list':         await cmdList(parsed); break;
      case 'pull':         await cmdPull(parsed); break;
      case 'generate':     await cmdGenerate(parsed); break;
      case 'simulators':   await cmdSimulators(parsed); break;
      case 'run':          await cmdRun(parsed); break;
      case 'stop':         await cmdStop(parsed); break;
      case 'sim-status':   await cmdSimStatus(parsed); break;
      case 'help':
      case '-h':
      case '--help':
        help();
        break;
      default:
        console.error(`unknown command: ${parsed.command}\n`);
        help();
        process.exit(2);
    }
  } catch (e: any) {
    console.error(`error: ${e?.message ?? e}`);
    process.exit(1);
  }
}

main();

// Autonomous config-fidelity matrix run. Builds a large matrix (1000+ cases),
// runs each sequentially against the Simnovator under test (the box serialises
// executions), validates the generated ue.cfg, and writes an incremental
// tabular report. For every FAIL/ERROR it stores the testcase.json (input
// config) + the retrieved ue.cfg for retrieval.
//
// Run (detached, ~4h window):
//   CF_MINUTES=220 node node_modules/tsx/dist/cli.mjs scripts/cf-matrix-run.ts
//
// Outputs under data/cf-report/<runId>/:
//   report.csv      one row per case (Test ID, name, RAT, Traffic, verdict, ...)
//   report.html     same, browsable
//   summary.json    counts + build + timing
//   failures/<id>/  testcase.json + ue.cfg + diff.json (only for FAIL/ERROR)

import * as fs from 'fs';
import * as path from 'path';
import { loadInventory } from '../src/lib/inventory';
import { generateMatrix, generateBandSweep } from '../src/lib/configFidelity/paramSpace';
import type { BandRat } from '../src/lib/configFidelity/bandTable';
import { createTestCase, deleteTestCase, CreateError, type ApiOpts } from '../src/lib/configFidelity/testCreator';
import { generateAndRetrieveUeCfg } from '../src/lib/configFidelity/ueCfg';
import { validateConfig, detectConfigErrors } from '../src/lib/configFidelity/validate';
import { listSimulators, getBoxVersion } from '../src/lib/uesimClient';
import type { Case } from '../src/lib/configFidelity/types';

const API_SYSTEM_ID = process.env.CF_API_SYSTEM ?? 'simnovator-202';
const UESIM_SYSTEM_ID = process.env.CF_UESIM_SYSTEM ?? 'uesim-101';
const MINUTES = Number(process.env.CF_MINUTES ?? 220);
const POLL_TIMEOUT_MS = Number(process.env.CF_POLL_MS ?? 30000);
const DEADLINE = Date.now() + MINUTES * 60_000;

function ts() { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildMatrix(): Case[] {
  // CF_BAND_SWEEP=1 → one case per band from the vetted master table.
  if (process.env.CF_BAND_SWEEP) {
    const rats = process.env.CF_BAND_RATS ? (process.env.CF_BAND_RATS.split(',') as BandRat[]) : undefined;
    const cap = process.env.CF_CAP ? Number(process.env.CF_CAP) : undefined;
    return generateBandSweep({ rats, dataType: (process.env.CF_BAND_DT as any) || 'no_data', cap });
  }
  const nr = generateMatrix({ rats: ['nr-sa'], mode: 'full',
    bandwidths: [20, 40, 50, 60, 80, 100], antennas: [[1, 1], [2, 1], [2, 2], [4, 2]],
    ueCounts: [1, 2, 4, 8, 16, 32], dataTypes: ['no_data', 'udp', 'tcp'], featureFlags: ['networkSlicing'] });
  const lte = generateMatrix({ rats: ['lte'], mode: 'full',
    bandwidths: [5, 10, 15, 20], antennas: [[1, 1], [2, 1], [4, 1]], // LTE: ul antenna must be 1
    ueCounts: [1, 2, 4, 8, 16, 32], dataTypes: ['no_data', 'udp', 'tcp'] });
  return [...nr, ...lte];
}

function rowOf(c: Case) {
  const cell = c.input.cellConfig?.cells?.[0] ?? {};
  const sub = c.input.subsConfig?.subs?.[0] ?? {};
  const up = c.input.userPlaneConfig?.profiles?.[0] ?? {};
  const traffic = up.dataType === 'no_data' || !up.dataType ? 'no_data' : `${up.dataType}/${up.transportProtocol ?? ''}`;
  return {
    rat: c.rat,
    bandwidth: cell.bandwidth, antennas: `${cell.antennas?.dl}x${cell.antennas?.ul}`,
    ueCount: sub.ueCount, slicing: sub.networkSlicing ?? '-', traffic,
  };
}

const CSV_HEADER = ['#', 'Test ID', 'Testcase Name', 'RAT', 'Traffic', 'Bandwidth(MHz)', 'Antennas', 'UE Count', 'Slicing', 'Verdict', 'Honoured', 'Mismatch', 'Missing', 'ConfigErrors', 'Duration(ms)', 'BoxTestCaseId', 'Note'];
function csvCell(s: unknown) { const v = String(s ?? ''); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }

async function main() {
  const runId = `run-${ts()}`;
  const dir = path.join(process.cwd(), 'data', 'cf-report', runId);
  const failDir = path.join(dir, 'failures');
  fs.mkdirSync(failDir, { recursive: true });
  const csvPath = path.join(dir, 'report.csv');
  fs.writeFileSync(csvPath, CSV_HEADER.join(',') + '\n');
  // Stable pointer to the latest run.
  try { fs.writeFileSync(path.join(process.cwd(), 'data', 'cf-report', 'LATEST.txt'), runId); } catch {}

  const inv = loadInventory();
  const apiSys = inv.systems.find((s) => s.id === API_SYSTEM_ID);
  const ueSim = inv.systems.find((s) => s.id === UESIM_SYSTEM_ID);
  if (!apiSys || !ueSim) { console.error('missing systems in inventory:', API_SYSTEM_ID, UESIM_SYSTEM_ID); process.exit(1); }
  const api: ApiOpts = { host: apiSys.host, username: apiSys.uesim?.username ?? 'admin', password: apiSys.uesim?.password ?? 'admin' };

  let simulatorId: string | undefined;
  try { simulatorId = (await listSimulators(api)).items?.[0]?.id; } catch {}
  let build: any; try { build = await getBoxVersion(api); } catch {}

  const cases = buildMatrix();
  // Give every case a UNIQUE box name (settings finalises the name and the box
  // rejects duplicates across runs). input.settings is the same object ref as
  // the settings body, so this one mutation keeps the validator consistent.
  const stamp = runId.replace(/^run-/, '');
  for (const c of cases) {
    const uniq = `${c.id}-${stamp}`;
    if (c.settings?.settings) { c.settings.settings.testCaseName = uniq; c.settings.settings.test_name = uniq; }
  }
  const summary: any = {
    runId, startedAt: new Date().toISOString(), apiHost: api.host, ueSimHost: ueSim.host,
    build, totalPlanned: cases.length, deadlineMin: MINUTES,
    counts: { done: 0, pass: 0, fail: 0, error: 0 }, lastUpdate: new Date().toISOString(),
  };
  const writeSummary = () => fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeSummary();
  console.log(`[cf] runId=${runId} planned=${cases.length} deadline=${MINUTES}min api=${api.host} uesim=${ueSim.host} sim=${simulatorId ?? '?'}`);

  let i = 0;
  for (const c of cases) {
    if (Date.now() > DEADLINE) { console.log('[cf] deadline reached — stopping'); break; }
    i++;
    const r = rowOf(c);
    const t0 = Date.now();
    let verdict = 'ERROR'; let honoured = 0, mismatch = 0, missing = 0, cfgErrCount = 0; let note = ''; let boxId = '';
    let testCaseId: string | undefined;
    let rawUeCfg: string | undefined; let diff: any;
    try {
      const created = await createTestCase(api, c);
      testCaseId = created.testCaseId; boxId = testCaseId;
      const gen = await generateAndRetrieveUeCfg({ api, ueSimSystem: ueSim as any, testCaseId, simulatorId, pollTimeoutMs: POLL_TIMEOUT_MS, expectedName: c.settings?.settings?.testCaseName });
      rawUeCfg = gen.rawUeCfg;
      const cfgErrs = detectConfigErrors(gen.signals);
      cfgErrCount = cfgErrs.length;
      if (gen.ueCfg) {
        diff = validateConfig(c.input, gen.ueCfg);
        honoured = diff.counts.honoured; mismatch = diff.counts.mismatch; missing = diff.counts.missing;
        const pass = cfgErrs.length === 0 && diff.ok;
        verdict = pass ? 'PASS' : 'FAIL';
        if (!pass) note = [cfgErrs.map((e) => e.message).join('; '), diff.params.filter((p: any) => p.status !== 'honoured').map((p: any) => `${p.label}:${p.status}`).join(', ')].filter(Boolean).join(' | ').slice(0, 300);
      } else {
        verdict = 'FAIL'; note = (cfgErrs.map((e) => e.message).join('; ') || 'no ue.cfg retrieved').slice(0, 300);
      }
    } catch (e: any) {
      if (e instanceof CreateError) { verdict = 'FAIL'; cfgErrCount = 1; note = ('create rejected: ' + e.message).slice(0, 300); }
      else { verdict = 'ERROR'; note = (e?.message ?? String(e)).slice(0, 300); }
    } finally {
      if (testCaseId) await deleteTestCase(api, testCaseId).catch(() => {});
    }
    const dur = Date.now() - t0;

    // Persist failure artifacts.
    if (verdict !== 'PASS') {
      const fd = path.join(failDir, c.id.replace(/[^A-Za-z0-9_.-]/g, '_'));
      try {
        fs.mkdirSync(fd, { recursive: true });
        fs.writeFileSync(path.join(fd, 'testcase.json'), JSON.stringify(c.input, null, 2));
        if (rawUeCfg) fs.writeFileSync(path.join(fd, 'ue.cfg'), rawUeCfg);
        if (diff) fs.writeFileSync(path.join(fd, 'diff.json'), JSON.stringify(diff, null, 2));
      } catch {}
    }

    // Append CSV row.
    const row = [i, c.id, c.id, r.rat, r.traffic, r.bandwidth, r.antennas, r.ueCount, r.slicing, verdict, honoured, mismatch, missing, cfgErrCount, dur, boxId, note];
    fs.appendFileSync(csvPath, row.map(csvCell).join(',') + '\n');

    summary.counts.done++;
    if (verdict === 'PASS') summary.counts.pass++; else if (verdict === 'FAIL') summary.counts.fail++; else summary.counts.error++;
    summary.lastUpdate = new Date().toISOString();
    summary.etaNote = `~${Math.round(dur / 1000)}s/case`;
    writeSummary();
    // Refresh the browsable HTML every few cases so it's viewable mid-run.
    if (summary.counts.done % 3 === 0) { try { writeHtml(dir, csvPath, summary); } catch {} }
    console.log(`[cf] ${i}/${cases.length} ${c.id} -> ${verdict} (${honoured}✓/${mismatch}✗/${missing}gap, ${Math.round(dur / 1000)}s)${note ? ' :: ' + note.slice(0, 80) : ''}`);

    await sleep(2000); // settle: let the box finish teardown before the next create
  }

  summary.finishedAt = new Date().toISOString();
  writeSummary();
  writeHtml(dir, csvPath, summary);
  console.log(`[cf] DONE ${summary.counts.done} done | ${summary.counts.pass} pass | ${summary.counts.fail} fail | ${summary.counts.error} error -> ${dir}`);
}

function writeHtml(dir: string, csvPath: string, summary: any) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const rows = lines.slice(1).map((l) => { const m = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []; return m.map((x) => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')); });
  const color = (v: string) => v === 'PASS' ? '#16a34a' : v === 'FAIL' ? '#dc2626' : '#d97706';
  const body = rows.map((r) => `<tr>${r.map((c, i) => head[i] === 'Verdict' ? `<td style="color:${color(c)};font-weight:600">${c}</td>` : `<td>${c.replace(/</g, '&lt;')}</td>`).join('')}</tr>`).join('\n');
  const html = `<!doctype html><meta charset=utf8><title>Config Fidelity report ${summary.runId}</title>
<style>body{font:13px system-ui;margin:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:4px 8px;text-align:left}th{background:#f1f5f9;position:sticky;top:0}tr:nth-child(even){background:#fafafa}</style>
<h2>Config Fidelity — ${summary.runId}</h2>
<p>Build: <b>${summary.build?.version ?? '?'} (${summary.build?.build ?? '?'})</b> · API ${summary.apiHost} · UE-sim ${summary.ueSimHost}<br>
Planned ${summary.totalPlanned} · Done <b>${summary.counts.done}</b> · <span style="color:#16a34a">PASS ${summary.counts.pass}</span> · <span style="color:#dc2626">FAIL ${summary.counts.fail}</span> · <span style="color:#d97706">ERROR ${summary.counts.error}</span><br>
Started ${summary.startedAt} · Finished ${summary.finishedAt ?? '(running)'}</p>
<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  fs.writeFileSync(path.join(dir, 'report.html'), html);
}

main().catch((e) => { console.error('[cf] fatal', e); process.exit(1); });

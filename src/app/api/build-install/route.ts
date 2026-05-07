// POST /api/build-install
//
// Streaming install endpoint. The client POSTs the install request body and
// reads the response as a stream of newline-delimited JSON events
// (one InstallEvent per line) so the UI can render a live log without
// polling.
//
// Each event is one of:
//   { type: 'log',  stream: 'stdout'|'stderr'|'info'|'error', line: string, ts }
//   { type: 'step', step: 'connect'|'fetch'|'extract'|'install', status: 'start'|'ok'|'fail', detail?, durationMs?, ts }
//   { type: 'done', ok: boolean, durationMs, ts }
//
// The stream also persists the full log to data/builds/<buildId>/install.log
// for later inspection.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { loadInventory } from '@/lib/inventory';
import { runBuildInstall, type InstallEvent, type BuildInstallRequest } from '@/lib/buildInstaller';

export const dynamic = 'force-dynamic';
// The install can take 5–10 minutes (download + tar + ./install).
export const maxDuration = 1800;

export async function POST(req: Request) {
  let body: BuildInstallRequest;
  try { body = (await req.json()) as BuildInstallRequest; }
  catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }

  const inv = loadInventory();
  const buildId = `build-${new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 19)}`;
  const buildDir = path.resolve(process.cwd(), 'data', 'builds', buildId);
  fs.mkdirSync(buildDir, { recursive: true });
  const logPath = path.join(buildDir, 'install.log');
  const eventsPath = path.join(buildDir, 'events.ndjson');
  const requestPath = path.join(buildDir, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify({ ...body, _capturedAt: new Date().toISOString() }, null, 2));

  const logStream  = fs.createWriteStream(logPath,    { flags: 'a' });
  const eventStream = fs.createWriteStream(eventsPath, { flags: 'a' });

  const encoder = new TextEncoder();
  // The client may close the response (browser refresh, navigate away, network
  // blip) while the install is still running. We watch for that and flip
  // `clientGone` so the installer can short-circuit its polling loops and
  // close the browser instead of looping for the full per-step timeout.
  let clientGone = false;
  const stream = new ReadableStream({
    start(controller) {
      // Wrap an emit() that writes to both:
      //   - the HTTP response stream (line-delimited JSON for the UI)
      //   - the on-disk log + events files (for later inspection)
      const emit = (e: InstallEvent) => {
        if (clientGone) {
          // Still write to disk so the run is auditable, but don't try to
          // enqueue into a closed controller (it throws 'Invalid state').
          try { eventStream.write(JSON.stringify(e) + '\n'); } catch { /* ignore */ }
          if (e.type === 'log') {
            const stamp = new Date(e.ts).toISOString();
            const tag = e.stream === 'stderr' ? '[err] ' : e.stream === 'error' ? '[ERR] ' : e.stream === 'info' ? '[--] ' : '';
            try { logStream.write(`${stamp} ${tag}${e.line}\n`); } catch { /* ignore */ }
          }
          return;
        }
        const json = JSON.stringify(e);
        try { controller.enqueue(encoder.encode(json + '\n')); } catch { clientGone = true; }
        try { eventStream.write(json + '\n'); } catch { /* ignore */ }
        if (e.type === 'log') {
          const stamp = new Date(e.ts).toISOString();
          const tag = e.stream === 'stderr' ? '[err] ' : e.stream === 'error' ? '[ERR] ' : e.stream === 'info' ? '[--] ' : '';
          try { logStream.write(`${stamp} ${tag}${e.line}\n`); } catch { /* ignore */ }
        } else if (e.type === 'step') {
          const stamp = new Date(e.ts).toISOString();
          try { logStream.write(`${stamp} -- ${e.step.toUpperCase()} ${e.status}${e.durationMs ? ` (${e.durationMs}ms)` : ''}${e.detail ? ` :: ${e.detail}` : ''}\n`); } catch { /* ignore */ }
        }
      };

      // Header line so the client knows the buildId immediately.
      emit({ type: 'log', stream: 'info', line: `buildId=${buildId}`, ts: Date.now() });

      runBuildInstall({ inv, req: body, emit, buildDir, isCanceled: () => clientGone })
        .catch((e: any) => emit({ type: 'log', stream: 'error', line: `unexpected: ${e?.message ?? e}`, ts: Date.now() }))
        .finally(() => {
          try { logStream.end(); } catch { /* ignore */ }
          try { eventStream.end(); } catch { /* ignore */ }
          if (!clientGone) {
            try { controller.close(); } catch { /* ignore */ }
          }
        });
    },
    cancel() {
      // Browser closed the stream — flag the installer so it bails out and
      // closes its Chromium instance rather than running to completion.
      clientGone = true;
      try { logStream.write(`${new Date().toISOString()} -- CLIENT_DISCONNECTED — install will abort at next checkpoint\n`); } catch { /* ignore */ }
      try { logStream.end(); } catch { /* ignore */ }
      try { eventStream.end(); } catch { /* ignore */ }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Build-Id': buildId,
    },
  });
}

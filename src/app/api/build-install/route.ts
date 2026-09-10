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
  // Cancelling is a deliberate act, and it is a FILE, not a closed socket.
  //
  // This used to abort the install whenever the response stream closed, which
  // meant a browser refresh killed a ten-minute install on the box — the thing
  // the operator was least likely to intend and most likely to do. Now a lost
  // client only stops the live rendering: the run keeps going, keeps writing
  // to events.ndjson, and GET below lets the page rejoin it. Cancel writes
  // this marker (DELETE), which is the only thing that stops a run.
  const cancelPath = path.join(buildDir, 'CANCELED');

  const encoder = new TextEncoder();
  // Tracks only whether we can still enqueue into the response controller —
  // it no longer decides whether the install continues.
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

      runBuildInstall({ inv, req: body, emit, buildDir, isCanceled: () => fs.existsSync(cancelPath) })
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
      // The browser stopped reading (refresh, navigate away, network blip).
      // The install continues — only the live rendering stops. The write
      // streams stay open so the run is complete on disk for GET to replay.
      clientGone = true;
      try { logStream.write(`${new Date().toISOString()} -- CLIENT_DISCONNECTED — install continues; reload the page to rejoin it\n`); } catch { /* ignore */ }
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

/**
 * GET /api/build-install?systemId=…
 *
 * The most recent install run for that system, replayed from disk.
 *
 * Why: the POST above streams the install to whoever started it, and that is
 * the ONLY copy the page had — reload it and the whole log vanished, even
 * though every event was already written to data/builds/<buildId>. This reads
 * it back so a refresh (or a second person opening the page) sees the install
 * that happened, and an install still in flight keeps updating.
 *
 * `running` is inferred from the file rather than from a live handle: the
 * installer writes `done` last, so a run with no `done` whose events file is
 * still being appended to is still going.
 */
export async function GET(req: Request) {
  const systemId = (new URL(req.url).searchParams.get('systemId') ?? '').trim();
  const root = path.join(process.cwd(), 'data', 'builds');

  try {
    if (!fs.existsSync(root)) return NextResponse.json({ ok: true, run: null });

    // Newest first. Directory names are build-<timestamp>, so they sort
    // lexicographically in time order.
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith('build-')).sort().reverse();

    for (const dir of dirs) {
      const base = path.join(root, dir);
      let request: any = {};
      try { request = JSON.parse(fs.readFileSync(path.join(base, 'request.json'), 'utf8')); } catch { /* older run */ }
      // No systemId asked for → newest run of any system.
      if (systemId && request?.systemId && request.systemId !== systemId) continue;

      const eventsPath = path.join(base, 'events.ndjson');
      if (!fs.existsSync(eventsPath)) continue;

      const events: InstallEvent[] = fs.readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as InstallEvent; } catch { return null; } })
        .filter((e): e is InstallEvent => !!e);

      const done = events.find((e) => e.type === 'done');
      // runBuildInstall emits `done` on every exit path, including its catch,
      // so a run with no `done` either is still going or died with the process
      // (dev-server restart mid-install). Tell those apart by how long the
      // events file has been silent — five minutes is generous, the installer
      // echoes terminal output every few seconds even during ./install.
      const silentMs = Date.now() - fs.statSync(eventsPath).mtimeMs;
      const stalled = !done && silentMs > 5 * 60_000;
      return NextResponse.json({
        ok: true,
        run: {
          buildId: dir,
          systemId: request?.systemId,
          buildUrl: request?.buildUrl,
          startedAt: request?._capturedAt,
          running: !done && !stalled,
          stalled,
          ok: done ? (done as any).ok === true : undefined,
          events,
        },
      });
    }
    return NextResponse.json({ ok: true, run: null });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

/**
 * DELETE /api/build-install?buildId=…
 *
 * Cancel a running install. Writes a CANCELED marker into the build directory;
 * the installer checks for it at each of its checkpoints and bails out, closing
 * its Chromium rather than running to completion.
 *
 * A marker file rather than an in-memory flag because the operator who cancels
 * may not be the request that started the install — after a page refresh the
 * original stream is long gone, but the run is still going.
 */
export async function DELETE(req: Request) {
  const buildId = (new URL(req.url).searchParams.get('buildId') ?? '').trim();
  // Anchor to the builds directory and take the basename only — a buildId is
  // a directory name, never a path.
  if (!/^build-[\w.\-]+$/.test(buildId)) {
    return NextResponse.json({ ok: false, error: 'buildId is required' }, { status: 400 });
  }
  const buildDir = path.join(process.cwd(), 'data', 'builds', buildId);
  if (!fs.existsSync(buildDir)) {
    return NextResponse.json({ ok: false, error: `no run "${buildId}"` }, { status: 404 });
  }
  try {
    fs.writeFileSync(path.join(buildDir, 'CANCELED'), new Date().toISOString());
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

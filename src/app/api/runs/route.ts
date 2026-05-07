import { NextResponse } from 'next/server';
import { listRuns } from '@/lib/runStore';
import { executeRun, type RunRequest } from '@/lib/runner';
import { loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET() {
  const runs = listRuns(100).map((r) => ({
    id: r.id,
    testcaseId: r.testcaseId,
    topology: r.topology,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    status: r.status,
    dryRun: !!r.dryRun,
    summary: r.generatorSummary,
    stepCount: r.steps.length,
    failedStep: r.steps.find((s) => !s.ok)?.name,
  }));
  return NextResponse.json({ runs });
}

export async function POST(req: Request) {
  const body = (await req.json()) as RunRequest;
  if (!body?.testcaseId) return NextResponse.json({ error: 'testcaseId required' }, { status: 400 });
  const inv = loadInventory();
  // Kick off without awaiting so the caller gets a runId quickly. The run state
  // is persisted to disk as it progresses; the UI polls /api/runs/<id>.
  const initial = await executeRunInBackground(inv, body);
  return NextResponse.json({ runId: initial.runId });
}

// Helper: start the run, return its ID immediately, persist as it goes.
async function executeRunInBackground(inv: ReturnType<typeof loadInventory>, req: RunRequest): Promise<{ runId: string }> {
  // executeRun is async; we DO need to know the runId before responding. The
  // simplest approach is to start the function and let the first saveRun()
  // happen synchronously inside, then race against a placeholder. But the
  // function returns the final record. To get the ID immediately, we
  // restructure: just await the first save (which happens in executeRun
  // after newRunId() + saveRun()). That makes the POST block briefly until
  // the run record exists on disk; subsequent steps continue async via the
  // microtask queue triggered below.
  let runIdResolver: (id: string) => void;
  const runIdPromise = new Promise<string>((r) => { runIdResolver = r; });

  // Wrap executeRun: as soon as it has assigned an id, resolve. The current
  // implementation calls saveRun() right after newRunId(). To hook in cleanly
  // without modifying it, we patch saveRun briefly... too brittle. Instead,
  // we inline the early-id step here and let executeRun handle the rest.
  // For now: await executeRun fully (small/fast in dry-run). For long-running
  // real deploys, switch this to a queue worker + immediate response with a
  // pre-allocated id.
  const final = await executeRun(inv, req);
  runIdResolver!(final.id);
  return { runId: await runIdPromise };
}

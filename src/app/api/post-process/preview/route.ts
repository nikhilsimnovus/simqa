// POST /api/post-process/preview
//
// Run post-processing rules against one execution's log and return the
// result, WITHOUT storing anything. This is how a rule is checked before it
// is attached to a suite row — point it at an execution that has already
// happened, see the counts the log really gives, and adjust the expected
// numbers to match reality rather than to a guess.
//
// It is the honest way to answer "would this rule have passed", because it
// goes through postProcessExecution() — the same fetcher and the same
// evaluator the automatic run uses when a row finishes. If it computed the
// answer its own way, a rule could preview PASS and then run FAIL, which
// would make the preview worse than useless.
//
// Nothing here touches API Tests or API Validation, and no code is shared
// with them.

import { NextResponse } from 'next/server';
import { getSystem, uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';
import { postProcessExecution, asRules } from '@/lib/postProcess/afterExecution';

export const dynamic = 'force-dynamic';

/** The box's token, through the same client every other read uses. */
async function tokenFor(host: string, username: string, password: string): Promise<string> {
  const { ensureToken } = await import('@/lib/uesimClient');
  return ensureToken(host, username, password);
}

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* reported below */ }

  const systemId = String(body.systemId ?? '').trim();
  const executionId = String(body.executionId ?? '').trim();
  const rules = asRules(Array.isArray(body.rules) ? body.rules : []);
  if (!systemId || !executionId) {
    return NextResponse.json(
      { ok: false, error: 'systemId and executionId are both required' }, { status: 400 });
  }

  const inv = loadInventory();
  const sys = getSystem(inv, systemId);
  const opts = uesimApiOptsForSystem(inv, systemId, body.boxUserId ? String(body.boxUserId) : undefined);
  if (!sys || !opts) {
    return NextResponse.json(
      { ok: false, error: `system "${systemId}" is not a testable Simnovator` }, { status: 404 });
  }

  try {
    const token = await tokenFor(opts.host, opts.username, opts.password);
    const report = await postProcessExecution({
      host: opts.host, token, executionId, rules,
      // A preview should answer quickly: one attempt unless asked otherwise,
      // because the operator is sitting in front of it. The runner asks for
      // several, because it arrives before the box has finished writing.
      attempts: Number(body.attempts) > 0 ? Number(body.attempts) : 1,
      executionResult: body.executionResult ? String(body.executionResult) : undefined,
    });

    return NextResponse.json({
      ok: true,
      host: opts.host,
      executionId,
      log: { ...report.log, problem: report.problem },
      // What the log actually contains, so an expected count can be set from
      // the evidence instead of from memory.
      messages: report.log.messages,
      tally: report.tally,
      results: report.results,
      postProcessing: report.outcome,
      ...(report.executionResult === undefined
        ? {}
        : { executionResult: report.executionResult, finalResult: report.finalResult }),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

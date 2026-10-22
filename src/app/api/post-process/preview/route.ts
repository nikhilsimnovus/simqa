// POST /api/post-process/preview
//
// Run post-processing rules against one execution's log and return the
// result, WITHOUT storing anything. This is how a rule is checked before it
// is attached to a suite row — point it at an execution that has already
// happened, see the counts the log really gives, and adjust the expected
// numbers to match reality rather than to a guess.
//
// It is also the honest way to answer "would this rule have passed", because
// it reads the same log, through the same fetcher, with the same evaluator
// the automatic run will use.
//
// Nothing here touches API Tests or API Validation, and no code is shared
// with them.

import { NextResponse } from 'next/server';
import { getSystem, uesimApiOptsForSystem, loadInventory } from '@/lib/inventory';
import { fetchExecutionLogWithRetry } from '@/lib/postProcess/fetchLogs';
import { parseMessages, messageTally } from '@/lib/postProcess/otaParse';
import { evaluateRule, overallOutcome, finalResult, type PostRule } from '@/lib/postProcess/rules';

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
  const rules: PostRule[] = Array.isArray(body.rules) ? body.rules : [];
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
    const log = await fetchExecutionLogWithRetry({
      host: opts.host, token, executionId,
      // A preview should answer quickly: one attempt unless asked otherwise,
      // because the operator is sitting in front of it.
      attempts: Number(body.attempts) > 0 ? Number(body.attempts) : 1,
    });
    const messages = parseMessages(log.records);
    const usable = { usable: log.complete && log.records.length > 0, problem: log.problem };
    const results = rules.map((r) => evaluateRule(r, messages, usable));
    const post = overallOutcome(results, rules.length, usable.usable);

    return NextResponse.json({
      ok: true,
      host: opts.host,
      executionId,
      log: {
        records: log.records.length,
        perLayer: log.perLayer,
        requests: log.requests,
        complete: log.complete,
        problem: log.problem,
      },
      // What the log actually contains, so an expected count can be set from
      // the evidence instead of from memory.
      messages: messages.length,
      tally: messageTally(messages),
      results,
      postProcessing: post,
      ...(body.executionResult
        ? { executionResult: body.executionResult, finalResult: finalResult(String(body.executionResult), post) }
        : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

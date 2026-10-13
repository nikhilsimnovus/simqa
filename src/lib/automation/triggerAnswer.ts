// What POST /v2/testcases/{id}/executions actually tells you.
//
// The HTTP status is not the answer. Measured on 192.168.1.95, both of these
// are HTTP 200:
//
//   started, after ~20s:
//     {"status":"success","message":"Test case started successfully",
//      "executionId":"01a1340f-f3db-71c7-a2fd-30709b5f9aa9"}
//
//   refused, immediately:
//     {"status":"Failure",
//      "message":"The test uses sdr4, which is not assigned to this simulator"}
//
// The runner used to abort that POST after 3 seconds and treat the AbortError
// as a 202, because a successful start is slow and the box runs the test even
// if you stop listening. So it never read either body: every refusal was
// recorded as "triggered", and the row then waited out its whole window for an
// execution that had never begun before reporting "no terminal state within
// 280s". NSA_3cell_Mobility_UDP_1UEs_automation failed that way on 13 October
// — the box had refused it instantly, because its three cells name RF cards 0,
// 2 and 4 while simulator "simuser" owns only 0 and 1.
//
// Waiting ~20s for the real answer costs nothing that matters (the run then
// sleeps longer than that before the attach check) and buys two things: the
// box's own words when it refuses, and the executionId when it starts — which
// is the one unambiguous way to know a polled record belongs to this run
// rather than to the row's previous one. See ownExecution.ts.
//
// Pure, imports nothing, so node --test loads it directly.

export interface TriggerAnswer {
  /** Did the box say it started the test? */
  started: boolean;
  /** The execution it started, when it named one. */
  executionId?: string;
  /** The box's own message, to show the operator verbatim. */
  message?: string;
  /** True when the answer was unreadable and `started` is a guess from the
   *  HTTP status rather than something the box said. */
  assumed?: boolean;
}

/** Field values that mean "I did not start it". The box has used both
 *  "Failure" and "success" — inconsistent capitalisation included. */
function saysFailure(status: string): boolean {
  return /^(fail|error|refus|reject)/i.test(status);
}

function saysSuccess(status: string): boolean {
  return /^(succ|ok|start|accept)/i.test(status);
}

/**
 * Read the trigger's answer.
 *
 * `httpStatus` is only a fallback: it decides nothing when the body says
 * something, because the box returns 200 for a refusal.
 */
export function readTriggerAnswer(httpStatus: number, body: string): TriggerAnswer {
  let j: any;
  try { j = JSON.parse(body); } catch { j = undefined; }

  if (j && typeof j === 'object') {
    const status = String(j.status ?? j.result ?? '');
    const message = typeof j.message === 'string' && j.message.trim() ? j.message.trim() : undefined;
    const executionId = typeof j.executionId === 'string' && j.executionId
      ? j.executionId
      : (typeof j.execution_id === 'string' && j.execution_id ? j.execution_id : undefined);

    if (saysFailure(status)) return { started: false, message };
    if (saysSuccess(status)) return { started: true, executionId, message };
    // An id and no verdict still means it started — nothing else would mint one.
    if (executionId) return { started: true, executionId, message };
    // A body we can parse but not interpret: fall back to the HTTP status, and
    // record that this is what happened.
    const ok = httpStatus >= 200 && httpStatus < 300;
    return { started: ok, message: message ?? (ok ? undefined : body.slice(0, 300)), assumed: true };
  }

  // Not JSON at all.
  const ok = httpStatus >= 200 && httpStatus < 300;
  const text = body.trim().slice(0, 300);
  return {
    started: ok,
    message: ok ? undefined : (text || `HTTP ${httpStatus}`),
    assumed: true,
  };
}

/** One line for the row detail, in the box's own words where there are any. */
export function refusalDetail(a: TriggerAnswer, httpStatus: number): string {
  if (a.message) return `the box refused to start it: ${a.message}`;
  if (httpStatus === 409) return 'a test case is already running on the simulator';
  return `the box refused to start it (HTTP ${httpStatus})`;
}

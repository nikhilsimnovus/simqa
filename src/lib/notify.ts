// Run-finish notifications — fire the configured webhook with a summary.
//
// The payload is Slack-compatible ({text: "..."}) but also carries a
// structured `run` object so a generic receiver (n8n, a lab dashboard,
// curl | jq) doesn't have to parse the prose.
//
// Design rules:
//   • Never block or fail the run — notification errors are logged and
//     swallowed. A run that passed but whose webhook 500'd still passed.
//   • Bounded — a hung webhook endpoint must not pin the runner.

import { getSettings } from './settings';

export interface RunNotification {
  surface: string;            // 'end-to-end', 'automation-suite', …
  runId: string;
  ok: boolean;
  title: string;              // e.g. testcase or suite name
  detail?: string;            // one-liner: verdict / failing check
  host?: string;
  counts?: { total?: number; passed?: number; failed?: number; skipped?: number };
}

const WEBHOOK_TIMEOUT_MS = 10_000;

/** Fire-and-forget. Returns whether a webhook was actually attempted —
 *  callers use that only for logging, never for control flow. */
export async function notifyRunFinished(n: RunNotification): Promise<boolean> {
  const s = getSettings();
  if (!s.notifyWebhookUrl) return false;
  if (n.ok && !s.notifyOnSuccess) return false;

  const status = n.ok ? 'PASSED' : 'FAILED';
  const c = n.counts;
  const countsTxt = c ? ` (${c.passed ?? 0} pass / ${c.failed ?? 0} fail / ${c.skipped ?? 0} skip)` : '';
  const text =
    `simqa ${n.surface} run ${status}: ${n.title}${countsTxt}` +
    (n.host ? ` on ${n.host}` : '') +
    (n.detail ? ` — ${n.detail}` : '') +
    ` [${n.runId}]`;

  try {
    const res = await fetch(s.notifyWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, run: n }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[notify] webhook ${res.status} for ${n.runId}`);
    }
    return true;
  } catch (e: any) {
    console.error(`[notify] webhook failed for ${n.runId}:`, e?.message ?? e);
    return true;
  }
}

// What a failed check actually means, in a sentence.
//
// Every check writes a `detail` aimed at whoever is debugging the check:
//
//   "DL throughput unstable: mean=710.7M min=0 (0% of mean) cv=0.88 over 22
//    samples — drops/oscillation beyond tolerance"
//
// That is the right thing to keep — it is the evidence — but it is not an
// answer to "what went wrong?". This turns each one into a plain sentence that
// names the problem and keeps the numbers that matter:
//
//   "Download speed kept collapsing — it averaged 710.7M but dropped to 0
//    during the run instead of holding steady."
//
// The technical detail is not replaced, only demoted: the UI shows this line
// and keeps the original under "View technical details".
//
// A check id with no rule here returns undefined and the UI falls back to the
// raw detail, so adding a check degrades to today's behaviour rather than
// showing nothing.
//
// IMPORTS: none. Pure, so it unit-tests under `node --test`.

/** "2m 08s" from seconds — long runs are unreadable as raw seconds. */
function secs(n: number): string {
  const s = Math.round(n);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** First capture group as a number, or undefined when the pattern misses. */
function num(detail: string, re: RegExp): number | undefined {
  const m = detail.match(re);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** "5.948812543232649" → "5.9". The checks record full float precision, which
 *  is right for the evidence line and unreadable in a sentence. */
function round1(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : v;
}

type Rule = (detail: string) => string | undefined;

/**
 * Per-check translations. Each reads the numbers out of the check's own detail
 * rather than being handed them, so this layer stays in the UI and the checks
 * keep writing one string.
 */
const RULES: Record<string, Rule> = {
  // ── Before the test ──────────────────────────────────────────────
  'preflight-login': (d) => {
    const code = num(d, /login returned (\d+)/);
    if (code === 401 || code === 403) return 'The Simnovator rejected the username and password. Check the credentials for this box in Systems Management.';
    if (code) return `The Simnovator did not accept the login (HTTP ${code}). The box is answering but the login endpoint is failing.`;
    if (/no access_token/.test(d)) return 'The login succeeded but the Simnovator returned no token, so nothing else could be checked.';
    return 'Could not log in to the Simnovator — the box did not answer the login request.';
  },
  'preflight-testcase-exists': (d) => {
    const code = num(d, /got (\d+)/);
    if (code === 404) return 'This testcase no longer exists on the box. It may have been deleted or it belongs to a different Simnovator.';
    return code ? `The box could not return this testcase (HTTP ${code}).` : undefined;
  },
  'preflight-api-responsive': (d) => {
    const code = num(d, /got (\d+)/);
    return code ? `The Simnovator's API is not healthy — it answered HTTP ${code} instead of listing its simulators.` : undefined;
  },
  'preflight-simulators-available': (d) => {
    if (/0 simulators registered/.test(d)) return 'This Simnovator has no simulators registered, so it has nothing to run the test on.';
    const code = num(d, /simulators returned (\d+)/);
    if (code) return `Could not read the simulator list from the box (HTTP ${code}).`;
    if (/BUSY/i.test(d)) return 'Another test is already running on this box. The Simnovator runs one at a time, so this one could not start.';
    return undefined;
  },
  'preflight-cfg-bring-up': (d) =>
    /no callbox bound/.test(d)
      ? 'No callbox is linked to this Simnovator, so the selected enb/mme/ims files could not be put in place. Set the topology in Systems Management.'
      : `The chosen configuration could not be applied to the callbox, so the test would have run against whatever was already linked. ${d}`,
  'preflight-ftp-anon-locked': (d) =>
    /SUCCEEDED/.test(d)
      ? 'Anyone can log in to this box over FTP without a password. That is a security hole, not a test problem — worth raising separately (SIM40-2227).'
      : undefined,

  // ── Starting ─────────────────────────────────────────────────────
  'trigger-start-execution': (d) => {
    const code = num(d, /start returned (\d+)/);
    if (!code) return undefined;
    // The box puts the real reason in the JSON body — "failed to start UE" is
    // the answer; "HTTP 500" only says it went wrong.
    const why = d.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
    return why
      ? `The Simnovator refused to start the test: ${why} (HTTP ${code}).`
      : `The Simnovator refused to start the test (HTTP ${code}).`;
  },
  'trigger-execution-id-discovered': (d) => {
    const after = num(d, /after ([\d.]+)s/);
    return `The test was requested but the box never registered an execution${after ? ` within ${secs(after)}` : ''} — so there was nothing to watch.`;
  },
  'during-status-running': (d) => {
    const after = num(d, /after ([\d.]+)s/);
    return `The execution was created but never started running${after ? ` within ${secs(after)}` : ''}. It sat queued instead of going live.`;
  },

  // ── While it runs ────────────────────────────────────────────────
  'during-ue-attach': (d) => {
    const after = num(d, /after ([\d.]+)s/);
    return `No UE ever connected${after ? ` in ${secs(after)}` : ''}. The test ran, but no device attached to the network — so nothing was actually exercised.`;
  },
  'during-all-ues-attach': (d) => {
    const m = d.match(/only (\d+)\/(\d+) UEs attached/);
    if (!m) return undefined;
    const got = Number(m[1]);
    const want = Number(m[2]);
    return `Only ${got} of ${want} UEs connected — ${want - got} never attached. The run went ahead with a partial fleet, so its figures are not for ${want} UEs.`;
  },
  'during-ue-count-stable': (d) => {
    const m = d.match(/from peak (\d+) to (\d+)/);
    if (!m) return undefined;
    const peak = Number(m[1]);
    const low = Number(m[2]);
    return low === 0
      ? `All ${peak} UEs disconnected before the test finished. They attached, then dropped off mid-run — so the results only cover part of the test.`
      : `${peak - low} of ${peak} UEs dropped off during the test (down to ${low}). They attached, then lost the network without the test noticing.`;
  },
  'during-throughput-flowing': (d) => {
    const m = d.match(/DL peaked at ([\d.]+) kbps.*?never reached ([\d.]+) kbps/);
    if (!m) return undefined;
    return `Download traffic never got going — it peaked at ${m[1]} kbps against a ${m[2]} kbps minimum. Either no data flowed or the link could not carry it.`;
  },
  'during-ul-throughput-flowing': (d) => {
    const m = d.match(/UL peaked at ([\d.]+) kbps.*?never reached ([\d.]+) kbps/);
    if (!m) return undefined;
    return `Upload traffic never got going — it peaked at ${m[1]} kbps against a ${m[2]} kbps minimum.`;
  },
  'during-bler-zero': (d) => {
    const m = d.match(/BLER reached ([\d.]+)% on cell (\S+).*?within ([\d.]+)%/);
    if (!m) return undefined;
    return `Too many blocks failed on the radio link — BLER hit ${round1(m[1])}% on cell ${m[2]}, above the ${m[3]}% limit. The connection was there but unreliable.`;
  },
  'during-throughput-stability': (d) => {
    const mean = d.match(/mean=(\S+)/)?.[1];
    const min = d.match(/min=(\S+?)[\s(]/)?.[1];
    if (!mean || min === undefined) return undefined;
    return Number(min) === 0
      ? `Download speed kept collapsing — it averaged ${mean} but fell to zero during the run instead of holding steady. Traffic stopped and restarted rather than flowing throughout.`
      : `Download speed was unstable — it averaged ${mean} but dropped as low as ${min}, swinging more than a healthy run should.`;
  },
  'during-per-cell-traffic': (d) => {
    const n = num(d, /^(\d+) per-cell traffic problem/);
    return n ? `${n} cell${n === 1 ? '' : 's'} did not carry the traffic ${n === 1 ? 'it was' : 'they were'} configured for — a direction was dead or one cell carried almost nothing.` : undefined;
  },
  'during-stats-consistency': () =>
    "The box's own UE figures contradict each other — it reported UEs deregistering while also reporting a full fleet connected. One of the two is wrong, so neither can be trusted for this run.",
  'during-zombie-execution': () =>
    'The execution kept counting down with no UEs registered at all. The test carried on running against nothing.',

  // ── Finishing ────────────────────────────────────────────────────
  'completion-status-terminal': (d) => {
    const after = num(d, /in ([\d.]+)s/);
    return `The test never reached a finished state${after ? ` — still running after ${secs(after)}` : ''}. It may still be going on the box, or it hung.`;
  },
  'completion-duration-sane': (d) => {
    const observed = num(d, /observed=([\d.]+)s/);
    const configured = num(d, /configured=([\d.]+)s/);
    if (observed === undefined || configured === undefined) return undefined;
    return observed < configured
      ? `The test stopped early — it ran ${secs(observed)} but was set up for ${secs(configured)}. Something ended it before its time.`
      : `The test overran — it took ${secs(observed)} against a configured ${secs(configured)}.`;
  },
  'completion-verdict-present': () =>
    'The Simnovator finished the run but recorded no pass/fail result for it, so the box has no verdict of its own to report.',

  // ── After ────────────────────────────────────────────────────────
  'post-logs-exportable': (d) => {
    if (/empty body/.test(d)) return 'The box returned an empty log file, so there are no logs to investigate this run with.';
    const code = num(d, /got (\d+)/);
    return code ? `Logs could not be downloaded from the box (HTTP ${code}).` : 'Logs could not be downloaded from the box.';
  },
  'post-all-ues-power-off': (d) => {
    const m = d.match(/(\d+) of (\d+) UE\(s\) still connected/);
    if (!m) return undefined;
    return `${m[1]} of ${m[2]} UEs were still attached after the test ended — they did not shut down cleanly and may interfere with the next run.`;
  },
  'post-per-ue-stats-sane': (d) => {
    const n = num(d, /^(\d+) per-UE stats problem/);
    return n ? `${n} of the per-UE readings cannot be right — figures like zero traffic on a UE that was carrying data, or an identical SNR on every UE.` : undefined;
  },

  // ── UI checks ────────────────────────────────────────────────────
  'ui-during-no-5xx': (d) => {
    const n = num(d, /^(\d+) 5xx response/);
    return n ? `The web UI hit ${n} server error${n === 1 ? '' : 's'} while the test was running.` : undefined;
  },
  'ui-during-no-console-errors': (d) => {
    const n = num(d, /^(\d+) console error/);
    return n ? `The web UI logged ${n} browser error${n === 1 ? '' : 's'} during the test.` : undefined;
  },
  'ui-during-notification-consistency': () =>
    'The UI announced the test as complete while it was still running — the notification and the real status disagreed.',
  'ui-during-stop-affordance': () =>
    'There was no Stop or Cancel button on the box’s own page while the test was running, so it could not be stopped from there.',
  'ui-during-export-buttons': (d) => {
    const m = d.match(/(\d+) of (\d+) export buttons failed/);
    return m ? `${m[1]} of ${m[2]} export buttons on the box’s page did not produce a file.` : undefined;
  },
  'ui-post-deep-link-shareable': (d) =>
    /bounced to/.test(d)
      ? 'A link straight to the statistics page bounces back to the login screen, so it cannot be shared with a colleague.'
      : 'The statistics link loses its execution id, so sharing it does not open the same run.',
};

/**
 * A plain-language statement of what went wrong, or undefined when this check
 * has no rule — in which case the caller should fall back to `detail`.
 */
export function explainFailure(id: string, detail?: string): string | undefined {
  if (!detail) return undefined;
  try {
    return RULES[id]?.(detail) || undefined;
  } catch {
    // A translation is a convenience; never let a bad regex hide the failure.
    return undefined;
  }
}

// ── The box's own success conditions ─────────────────────────────────
//
// A run started from the Simnovator carries its own pass/fail conditions
// instead of SimQA's checks, and they arrive as raw field names:
//
//   Achieved_Avg_DL_Throughput   Achieved_Avg_DL_Throughput>=95%   44 vs 95
//
// Same treatment, different source: a readable name, and a sentence saying
// what did not hold.

const BOX_METRIC_NAMES: Record<string, string> = {
  Achieved_Avg_DL_Throughput: 'Download Throughput',
  Achieved_Avg_UL_Throughput: 'Upload Throughput',
  Avg_DL_BLER: 'Download Block Error Rate',
  Avg_UL_BLER: 'Upload Block Error Rate',
  DL_BLER: 'Download Block Error Rate',
  UL_BLER: 'Upload Block Error Rate',
};

/** A readable title for one of the box's own conditions. Falls back to the
 *  field with underscores opened up, so an unmapped metric still reads as
 *  words rather than as a symbol. */
export function boxMetricName(msgname: string): string {
  return BOX_METRIC_NAMES[msgname] ?? msgname.replace(/_/g, ' ');
}

/**
 * Why one of the box's conditions failed, in a sentence.
 *
 * `demand` and `achieved` are unitless in the box's payload — the unit lives
 * in the condition string ("...>=95%") — so the direction of the comparison is
 * read from there rather than assumed.
 */
export function explainBoxCheck(
  msgname: string,
  condition: string | undefined,
  demand: number | undefined,
  achieved: number | undefined,
): string | undefined {
  if (demand === undefined || achieved === undefined) return undefined;
  const label = boxMetricName(msgname);
  const pct = /%/.test(condition ?? '') ? '%' : '';
  const wantsAtLeast = /(>=|>|≥)/.test(condition ?? '');
  return wantsAtLeast
    ? `${label} reached only ${achieved}${pct}, short of the ${demand}${pct} this testcase requires.`
    : `${label} was ${achieved}${pct}, over the ${demand}${pct} limit this testcase allows.`;
}

// ── Why a check was skipped ──────────────────────────────────────────
//
// A skip is not a failure, but "Test Started Successfully — SKIPPED" reads
// like one, and the reason underneath is written for whoever wrote the check:
//
//   "attached to execution 01a07b2b-9e02-76ac-8d83-08699b7a01eb already
//    running on the box — not triggering another"
//
// The execution id is the least useful thing in that sentence. Same treatment
// as the failures: say what happened and why it is fine (or, for the cfg case,
// why it is not).

const SKIP_RULES: Record<string, Rule> = {
  'trigger-start-execution': (d) =>
    /attached to execution/.test(d)
      ? 'Nothing to check — this run was started on the Simnovator, not by SimQA, so SimQA never sent a start request. The execution it is validating was already under way.'
      : undefined,
  'preflight-cfg-bring-up': (d) => {
    if (/already running this execution/.test(d)) {
      const not = d.match(/— (.+?) were NOT applied/)?.[1];
      return not
        ? `The test was already running when SimQA joined it, so the configuration could not be changed — ${not} were NOT applied. This run used whatever was linked on the callbox when it started.`
        : 'The test was already running when SimQA joined it, so its configuration is whatever was linked on the callbox at the time. Nothing was changed mid-run.';
    }
    if (/no cfg files selected/.test(d)) {
      return 'No enb/mme/ims files were chosen, so nothing was linked — the test ran against whatever the callbox already had in place.';
    }
    return undefined;
  },
  'during-zombie-execution': (d) =>
    /already finished/.test(d)
      ? 'The run ended before this check had a window to sample, so there was nothing to watch for.'
      : undefined,
  'preflight-ftp-anon-locked': (d) =>
    /no usable FTP/.test(d) ? 'No FTP service is running on this box, so there was nothing to test.' : undefined,
};

/** A plain-language reason a check was skipped, or undefined to fall back to
 *  the raw `skippedReason`. */
export function explainSkip(id: string, reason?: string): string | undefined {
  if (!reason) return undefined;
  try {
    return SKIP_RULES[id]?.(reason) || undefined;
  } catch {
    return undefined;
  }
}

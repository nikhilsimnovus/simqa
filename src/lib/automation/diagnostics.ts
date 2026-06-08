// Fire-and-track diagnostic collection by delegating to perf-qa.
//
// perf-qa already runs as a separate Flask app (typically at
// http://192.168.1.36:4000); it shells out to collect_perf_data.sh which
// SSHes into the lab roles + tars a per-host diagnostic bundle. We don't
// re-implement that here — simqa's suite runner just POSTs to perf-qa's
// /run endpoint with the testcase name + iteration id, gets back a
// job_id, and stores it on the run record so the user can jump to the
// bundle on perf-qa.
//
// Default URL is configurable via SIMQA_PERFQA_URL env var or per-call.

export interface TriggerOpts {
  perfQaUrl?: string;
  testCaseName: string;
  iterationId?: string;
  /** Profile to write into setup.conf before the collection fires.
   *  Optional — perf-qa will use its existing setup.conf if omitted. */
  profile?: string;
}

export interface TriggerResult {
  ok: boolean;
  perfQaUrl: string;
  jobId?: string;
  error?: string;
}

export const DEFAULT_PERFQA_URL = process.env.SIMQA_PERFQA_URL ?? 'http://192.168.1.36:4000';

export async function triggerPerfQaCollection(opts: TriggerOpts): Promise<TriggerResult> {
  const url = (opts.perfQaUrl ?? DEFAULT_PERFQA_URL).replace(/\/$/, '');
  // perf-qa expects application/x-www-form-urlencoded.
  const form = new URLSearchParams();
  if (opts.profile)     form.set('_profile', opts.profile);
  if (opts.testCaseName) form.set('test_case_name', opts.testCaseName);
  if (opts.iterationId)  form.set('iteration_id', opts.iterationId);
  // Collect everything by default — the user can fine-tune from the
  // perf-qa UI by editing the profile.
  for (const s of ['ue', 'simnovator', 'callbox', 'app_server', 'rest_api', 'iperf', 'heat', 'analyze']) {
    form.set(`collect_${s}`, 'on');
  }
  try {
    const r = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      // perf-qa's /run returns quickly with just the job_id; collection
      // continues in a background thread on the perf-qa side.
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, perfQaUrl: url, error: `${r.status} ${typeof j === 'object' ? JSON.stringify(j).slice(0, 200) : ''}` };
    }
    return { ok: true, perfQaUrl: url, jobId: j?.job_id };
  } catch (e: any) {
    return { ok: false, perfQaUrl: url, error: e?.message ?? String(e) };
  }
}

/** Poll perf-qa's manifest endpoint to find out the bundle filename
 *  once the job has finished. Returns the bundle name when ready, or
 *  null if still running / failed. */
export async function tryFetchPerfQaBundle(perfQaUrl: string, jobId: string): Promise<string | null> {
  try {
    const r = await fetch(`${perfQaUrl.replace(/\/$/, '')}/jobs/${encodeURIComponent(jobId)}/manifest`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    return j?.bundle ?? j?.tarball ?? null;
  } catch { return null; }
}

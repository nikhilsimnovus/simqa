// Simnovator build identification, shared by every surface that records a run.
//
// Run History has to answer "which build was this run against?", and that
// only means something if every surface stamps it the same way. Before this
// existed, automation-suite fetched /v2/version with its own private helper
// and the API/UI sweeps recorded nothing at all — so the Build column was
// blank for most rows and useless for the comparison it exists to support.
//
// The box reports:
//   GET /v2/version -> { simnovator: { version: "4.0.0_2608251705",
//                                      build: "Build 2026-08-25-4948" }, ... }
//
// `version` is the value QA quotes and the one Run History displays; `build`
// is kept alongside it for provenance. Everything here is best-effort: a
// missing build version must never fail or delay the run that produced it,
// so every path resolves to undefined rather than throwing.

export interface BoxBuild {
  /** e.g. "4.0.0_2608251705" — the value shown in the Build column. */
  version: string;
  /** e.g. "Build 2026-08-25-4948" — provenance, not shown by default. */
  build?: string;
}

const TIMEOUT_MS = 5_000;

/** Fetch the build with a token already in hand. */
export async function fetchBoxBuild(host: string, token: string): Promise<BoxBuild | undefined> {
  try {
    const r = await fetch(`http://${host}/v2/version`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return undefined;
    const j: any = await r.json();
    const version = j?.simnovator?.version;
    if (typeof version !== 'string' || !version) return undefined;
    const build = typeof j?.simnovator?.build === 'string' ? j.simnovator.build : undefined;
    return { version, build };
  } catch {
    return undefined;
  }
}

/** Fetch the build when there is no token yet, logging in first. Used by
 *  surfaces whose runner does not keep a token around by the time the run
 *  record is written. */
export async function resolveBoxBuild(host: string, username?: string, password?: string): Promise<BoxBuild | undefined> {
  if (!host) return undefined;
  try {
    const login = await fetch(`http://${host}/v2/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username ?? 'admin', password: password ?? 'admin' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!login.ok) return undefined;
    const token = (await login.json())?.access_token;
    if (!token) return undefined;
    return await fetchBoxBuild(host, token);
  } catch {
    return undefined;
  }
}

/** Normalise whatever a surface stored into the bare version string.
 *  automation-suite has historically written "4.0.0_x (Build y)" into a
 *  single field, so Run History rows written before this module existed
 *  still render as one consistent value instead of two visual formats. */
export function displayBuild(raw?: string): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^([^\s(]+)/);
  return m ? m[1] : raw;
}

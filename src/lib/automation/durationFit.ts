// How long a row runs, and what the box will accept.
//
// A suite row asks for a POWER-ON DURATION and everything else is derived from
// it. The arithmetic lives here, apart from the HTTP lifecycle that uses it, so
// node --test can load it: a row that asked for 210s and carried a 500s VoLTE
// call was refused by the box outright and never ran, which is the kind of
// mistake a test catches and a live run finds only after someone's suite is
// half finished.
/** Voice profiles — the ones whose traffic is a call. */
const VOICE_DATA_TYPES = new Set(['volte', 'vonr', 'voice', 'vt', 'video']);
/** Floor for a voice profile that does not say how long its call is. */
const VOICE_MIN_SESSION_SEC = 75;
/** Room the box wants around the traffic itself — registration, setup,
 *  teardown. A VoNR profile with callDuration 500 and callSetupDelay 5 was
 *  refused below a 520s session, which this clears by five seconds. */
const SESSION_MARGIN_SEC = 20;

/**
 * How long the traffic this profile defines actually takes.
 *
 * The box refuses any session too short to hold it, and says so in the
 * profile's own terms — "should be greater than 520s for VOLTE" for a 500s
 * call, "greater than NoOfPackets * Interval + StartDelay i.e, 600 for PING"
 * for 595 pings a second apart. Both answer the same question: how long is the
 * work? 0 when the profile does not say, which leaves the duration as asked.
 */
function profileWorkSeconds(p: any): number {
  const num = (v: any) => Number(v ?? 0) || 0;
  const type = String(p?.dataType ?? '').toLowerCase();
  if (VOICE_DATA_TYPES.has(type)) {
    const call = num(p?.callDuration);
    return call > 0 ? call + num(p?.callSetupDelay) : 0;
  }
  if (type === 'ping') {
    const packets = num(p?.numberOfPackets);
    // interval may be fractional (0.2s); the box counts it the same way.
    const interval = num(p?.interval) || 1;
    return packets > 0 ? packets * interval + num(p?.startDelay) : 0;
  }
  return 0;
}

/** The shortest session a profile can run in: its traffic plus the box's
 *  margin. Voice keeps a floor of its own for profiles that name no call. */
function sessionFloorFor(p: any): number {
  const work = profileWorkSeconds(p);
  const voiceFloor = VOICE_DATA_TYPES.has(String(p?.dataType ?? '').toLowerCase())
    ? VOICE_MIN_SESSION_SEC : 0;
  return Math.max(voiceFloor, work > 0 ? Math.ceil(work) + SESSION_MARGIN_SEC : 0);
}

/** The floor the box names when it refuses a session. It states it either as a
 *  bare number — "sessionDuration 200 should be greater than 520s for VOLTE" —
 *  or as the formula it used: "should be greater than NoOfPackets * Interval +
 *  StartDelay i.e, 600 for PING". Either way the figure wanted is the first
 *  number after the phrase, and it is the box's own arithmetic, so it is
 *  followed rather than guessed at. */
export function sessionFloorFromError(text: string): number | null {
  const m = /sessionDuration\s+[\d.]+\s+should be greater than[^\d]*([\d.]+)/i.exec(text ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.ceil(n) : null;
}

/** Shortest power-on duration a row may ask for. Below this there is no room
 *  for the UEs to come up and still pass traffic. */
export const MIN_POWER_ON_SEC = 20;

/**
 * Rewrite a testDefinition's duration in place.
 *
 * The figure the suite asks for is the POWER-ON DURATION — how long the UEs are
 * powered on, i.e. powerCycleConfig.powerOnTime. The user-plane session is
 * derived from it: traffic has to start after the profile's startDelay (and,
 * for voice, its call-setup delay) and finish before the UEs power off, so
 *
 *     sessionDuration = powerOnTime - startDelay - callSetupDelay
 *
 * That is the opposite of the earlier mapping, which took the session as given
 * and grew the power-on window around it.
 *
 * Returns notes describing anything that had to be adjusted upward.
 */
export function applyDuration(td: any, seconds: number): string[] {
  const notes: string[] = [];
  let powerOn = Math.max(1, Math.floor(seconds));
  if (powerOn < MIN_POWER_ON_SEC) {
    notes.push(`power-on duration raised from ${powerOn}s to the ${MIN_POWER_ON_SEC}s minimum`);
    powerOn = MIN_POWER_ON_SEC;
  }

  const profiles = (td?.userPlaneConfig?.profiles ?? []).filter((p: any) => p && typeof p === 'object');

  // The session has to hold the traffic the profile defines — a 500s call, 595
  // pings a second apart — and the session is what is left of the power-on
  // window after the delays, so such a row can force the whole window up. A
  // 210s row carrying a 500s call is not a 210s test: the box refuses it
  // outright and the row never runs. Raised to fit and said out loud, rather
  // than cutting the traffic the testcase defines.
  for (const p of profiles) {
    const type = String(p.dataType ?? '').toLowerCase();
    const floor = sessionFloorFor(p);
    if (floor <= 0) continue;
    const lead = (Number(p.startDelay ?? 0) || 0) + (Number(p.callSetupDelay ?? 0) || 0);
    const needed = floor + lead;
    if (powerOn < needed) {
      const work = Math.ceil(profileWorkSeconds(p));
      notes.push(work > 0
        ? `${type} profile carries ${work}s of traffic — power-on duration raised from ${powerOn}s to ${needed}s to fit it`
        : `${type} profile needs a session over ${VOICE_MIN_SESSION_SEC}s — power-on duration raised from ${powerOn}s to ${needed}s`);
      powerOn = needed;
    }
  }

  for (const p of profiles) {
    const lead = (Number(p.startDelay ?? 0) || 0) + (Number(p.callSetupDelay ?? 0) || 0);
    p.sessionDuration = Math.max(1, powerOn - lead);
  }

  for (const p of td?.powerCycleConfig?.profiles ?? []) {
    if (!p || typeof p !== 'object') continue;
    p.powerOnTime = powerOn;
    // durationP is the traffic window inside the power-on window: it ends when
    // the last profile's session ends, never after the UEs power off.
    const attachDelay = Number(p.attachDelay ?? 0) || 0;
    p.durationP = Math.max(1, powerOn - attachDelay);
    // A time-based loop profile also caps the whole test; keep it consistent
    // or the box rejects totalTestDuration < powerOnTime * cycles.
    if (p.loopProfile === 'time' && typeof p.totalTestDuration === 'number') {
      p.totalTestDuration = (p.powerOnTime + (Number(p.powerOffTime) || 0)) * 2 + 80;
    }
  }
  return notes;
}

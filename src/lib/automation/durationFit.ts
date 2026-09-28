// How long a row runs, and what the box will accept.
//
// A suite row asks for a POWER-ON DURATION and everything else is derived from
// it. The arithmetic lives here, apart from the HTTP lifecycle that uses it, so
// node --test can load it: a row that asked for 210s and carried a 500s VoLTE
// call was refused by the box outright and never ran, which is the kind of
// mistake a test catches and a live run finds only after someone's suite is
// half finished.
/** Voice user-plane profiles the box refuses to create with a short session:
 *  "sessionDuration N should be greater than Ms for VOLTE". A call needs
 *  setup + ring + media inside the session, so a 10s row is not creatable. */
const VOICE_DATA_TYPES = new Set(['volte', 'vonr', 'voice', 'vt', 'video']);
/** Floor for a voice profile that does not say how long its call is. */
const VOICE_MIN_SESSION_SEC = 75;
/** Room the box wants around the call itself — registration, setup, teardown.
 *  A VoNR profile with callDuration 500 and callSetupDelay 5 was refused below
 *  a 520s session, which this clears by five seconds. */
const VOICE_SESSION_MARGIN_SEC = 20;

/** The session a voice profile needs: its whole call, plus the box's margin. */
function voiceSessionFloor(p: any): number {
  const call = Number(p?.callDuration ?? 0) || 0;
  const setup = Number(p?.callSetupDelay ?? 0) || 0;
  return Math.max(VOICE_MIN_SESSION_SEC, call > 0 ? call + setup + VOICE_SESSION_MARGIN_SEC : 0);
}

/** The floor the box names when it refuses a session, e.g.
 *  "UserPlaneConfig: userPlane[0]: sessionDuration 200 should be greater than
 *  520s for VOLTE" — 520. The box's own arithmetic, so it is followed rather
 *  than guessed at: a profile may carry delays this code knows nothing about. */
export function sessionFloorFromError(text: string): number | null {
  const m = /sessionDuration\s+\d+\s+should be greater than\s+(\d+)/i.exec(text ?? '');
  return m ? Number(m[1]) : null;
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

  // A voice profile's session has to hold its whole CALL, and the session is
  // what is left of the power-on window after the delays — so a voice row can
  // force the whole window up. A 210s row carrying a 500s call is not a 210s
  // test: the box refuses it outright, and the row never ran at all. Raised to
  // fit and said out loud, rather than cutting the call the testcase defines.
  for (const p of profiles) {
    const type = String(p.dataType ?? '').toLowerCase();
    if (!VOICE_DATA_TYPES.has(type)) continue;
    const lead = (Number(p.startDelay ?? 0) || 0) + (Number(p.callSetupDelay ?? 0) || 0);
    const needed = voiceSessionFloor(p) + lead;
    if (powerOn < needed) {
      const call = Number(p.callDuration ?? 0) || 0;
      notes.push(call > 0
        ? `${type} profile places a ${call}s call — power-on duration raised from ${powerOn}s to ${needed}s to fit it`
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

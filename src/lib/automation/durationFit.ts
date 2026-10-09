// How long a row runs, and what the box will accept.
//
// A suite row asks for a POWER-ON DURATION and everything else is derived from
// it. The arithmetic lives here, apart from the code that uses it, so
// node --test can load it directly.
//
// ── Where these formulas come from ────────────────────────────────────────
//
// Not from the error messages, and not from guesswork. The Simnovator ships no
// schema for this, but its own web form does the arithmetic in the browser, so
// the rules were read out of the SPA bundle on 192.168.1.95
// (/assets/index-*.js, build 4.1.0-qadrop.3) and are transcribed below
// verbatim. Reading them from the bundle matters: the earlier version of this
// file inferred the rules from refusals it had seen, got the VOLTE loop case
// and the meaning of durationP wrong, and had no way to know it.
//
// The box computes, per user-plane profile, the power-on window that profile
// needs — `hNe` in the bundle, requiredPowerOn() here:
//
//   no_data (and sms without a loop)  0
//   volte                             sessionDuration + startDelay + 5
//   anything else, no loop            sessionDuration + startDelay
//   anything else, looping            (sessionDuration + interSessionGap)
//                                       × loopCount + startDelay + 5
//
// then takes the largest over the profiles that share the power-cycle entry's
// subscriber group and stores it as `durationP`, and refuses the test unless
//
//   powerOnTime >= durationP
//     "Minimum Power On Time is N seconds (Start Delay + Duration)" — or,
//     when the busiest profile loops, "(Start Delay + (Duration + Inter-loop
//     Interval) x No. of Loops + 5-second buffer)"
//
// A voice profile has a second rule of its own (`XNt`), which is the one
// behind "Duration should be greater than Ns for VOLTE":
//
//   sessionDuration >= callDuration + 2×callSetupDelay + startDelay + 5
//   looping:        >= (callDuration + callSetupDelay + interSessionGap + 5)
//                        × loopCount + startDelay + 5
//
// and a ping profile does not really have a packet count: the form derives it
// (`yfe`) from the window every time either changes,
//
//   numberOfPackets = max(1, floor((sessionDuration − startDelay) / interval))
//
// which is also what keeps its sibling rule true — the box refuses
// `numberOfPackets × interval + startDelay > sessionDuration` with "Interval
// Ns is too high for the given session duration".
//
// ── What this module does with them ───────────────────────────────────────
//
// The power-on duration the row asks for is AUTHORITATIVE, and the traffic is
// fitted into it. Ask for 100s and the test runs for 100s: a 100s window with
// a 5s start delay gets a 95s session, and a voice profile's call is shortened
// to fit rather than the window being grown to hold the call it was authored
// with. That is a deliberate reversal of how this worked before, when a row
// asking for 210s and carrying a 500s call was quietly turned into a 535s run.
//
// Fitting is only ever refused by arithmetic: a window too small to hold even
// the shortest legal traffic raises the power-on duration to the smallest one
// that works, and says so. Everything else is honoured exactly.

/** Shortest power-on duration a row may ask for. Below this there is no room
 *  for the UEs to come up and still pass traffic. */
export const MIN_POWER_ON_SEC = 20;

/** The 5-second buffer the box adds around looping and voice traffic. Its own
 *  message calls it a "5-second buffer". */
const BUFFER = 5;

/** Floors for the values this module derives. All are > 0 in the box's schema
 *  (`exclusiveMinimum: 0`), and a one-second call or session would be legal but
 *  useless, so the shortest thing worth producing is a few seconds. */
const MIN_SESSION = 5;
const MIN_CALL = 5;
const MIN_GAP = 1;
/** callDuration is capped at 3600 in the box's schema. */
const MAX_CALL = 3600;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const int = (v: unknown, fallback = 0): number => {
  const n = Math.floor(num(v));
  return n > 0 ? n : fallback;
};
const type = (p: any): string => String(p?.dataType ?? '').toLowerCase();
const looping = (p: any): boolean => p?.dataLoop === true;

/** A profile whose traffic is a call. The box's own check keys on the literal
 *  dataType "volte" — VoNR and ViNR are that same type with ratTypeP "sa" and
 *  a videoCodec — so the names an operator uses are accepted here too. */
const VOICE_TYPES = new Set(['volte', 'vonr', 'vinr', 'voice', 'vt', 'video']);
const isVoice = (p: any): boolean => VOICE_TYPES.has(type(p));

/** Profiles the box gives no window at all: there is no traffic to time. */
const isIdle = (p: any): boolean => type(p) === 'no_data' || (type(p) === 'sms' && !looping(p));

/**
 * The shortest session worth giving this profile.
 *
 * Ping needs more than the bare floor, because its packet count is derived as
 * floor((session − startDelay) / interval) and then forced up to 1: a session
 * that leaves no room for a single packet still gets one, and the box then
 * refuses the interval for being "too high for the given session duration".
 * So the session has to hold the delay and at least one interval.
 */
function minSessionFor(p: any): number {
  if (type(p) !== 'ping') return MIN_SESSION;
  return Math.max(MIN_SESSION, Math.ceil(num(p?.startDelay) + (num(p?.interval) || 1)));
}

/**
 * The power-on window this profile needs — the box's `hNe`, which is what it
 * stores as durationP and compares powerOnTime against.
 */
export function requiredPowerOn(p: any): number {
  if (isIdle(p)) return 0;
  const session = num(p?.sessionDuration);
  const start = num(p?.startDelay);
  if (isVoice(p)) return session + start + BUFFER;
  if (!looping(p)) return session + start;
  const loops = Math.max(1, int(p?.loopCount, 1));
  return (session + num(p?.interSessionGap)) * loops + start + BUFFER;
}

/**
 * The shortest session a voice profile's own call fits in — the box's `XNt`,
 * the rule behind "Duration should be greater than Ns for VOLTE".
 *
 * 0 for anything that is not a call, and for a registration-only profile,
 * which the box exempts.
 */
export function voiceSessionFloor(p: any): number {
  if (!isVoice(p) || p?.registrationOnly) return 0;
  const call = num(p?.callDuration);
  const setup = num(p?.callSetupDelay);
  const start = num(p?.startDelay);
  if (call <= 0) return 0;
  if (looping(p)) {
    const loops = Math.max(1, int(p?.loopCount, 1));
    return (call + setup + num(p?.interSessionGap) + BUFFER) * loops + start + BUFFER;
  }
  return call + 2 * setup + start + BUFFER;
}

/** The packet count the box's own form derives — `yfe`. Writing the JSON
 *  directly skips that form, so a stale count is left behind and the box then
 *  refuses the interval for being "too high for the given session duration". */
export function pingPackets(p: any): number {
  const session = num(p?.sessionDuration);
  const start = num(p?.startDelay);
  const interval = num(p?.interval) || 1;
  return Math.max(1, Math.floor((session - start) / interval));
}

/** Does this user-plane profile belong to the given power-cycle entry? The
 *  box matches on subscriber group, where a lone -1 means "apply to all". */
function sharesGroup(pcGroups: unknown, upGroups: unknown): boolean {
  const toNums = (v: unknown): number[] => {
    if (Array.isArray(v)) return v.map(Number).filter((n) => Number.isFinite(n));
    // The lab's testcases also carry it as the string "[1]".
    if (typeof v === 'string') {
      const m = v.match(/-?\d+/g);
      return m ? m.map(Number) : [];
    }
    if (typeof v === 'number') return [v];
    return [];
  };
  const a = toNums(pcGroups);
  const b = toNums(upGroups);
  const allA = a.length === 1 && a[0] === -1;
  const allB = b.length === 1 && b[0] === -1;
  if (allA || allB) return true;
  const set = new Set(a);
  return b.some((n) => set.has(n));
}

/**
 * Fit one profile into a power-on window.
 *
 * Returns the window this profile would need if it cannot be made to fit —
 * the caller then raises the duration for everybody and tries again — or 0
 * when it fitted.
 *
 * Mutates the profile. Which fields move depends on the type, and is exactly
 * what the box's rules leave free:
 *
 *   idle         nothing. no_data has no session to set, and the two shapes on
 *                the boxes disagree about whether the field is even present.
 *   plain        sessionDuration
 *   looping      sessionDuration and interSessionGap, scaled together so the
 *                authored shape of the loop survives, and loopCount only when
 *                even the shortest loops will not fit
 *   voice        sessionDuration, then callDuration — and for a looping call
 *                the gap and loop count as well
 *   ping         plus the derived packet count
 */
function fitProfile(p: any, powerOn: number, notes: string[]): number {
  if (isIdle(p)) return 0;
  const start = num(p?.startDelay);
  const label = type(p) || 'traffic';

  if (isVoice(p)) {
    // The window has to hold the session, and the session has to hold the call.
    const session = powerOn - start - BUFFER;
    if (session < MIN_SESSION) return start + BUFFER + MIN_SESSION;
    const setup = num(p?.callSetupDelay) || BUFFER;
    const was = num(p?.callDuration);

    if (looping(p)) {
      let loops = Math.max(1, int(p?.loopCount, 5));
      let gap = num(p?.interSessionGap) || 20;
      // (call + setup + gap + 5) × loops + start + 5 <= session
      const budget = session - start - BUFFER;
      // Shrink the loop count only when the loops cannot be made short enough.
      while (loops > 1 && Math.floor(budget / loops) < MIN_CALL + setup + MIN_GAP + BUFFER) loops--;
      const perLoop = Math.floor(budget / loops);
      if (perLoop < MIN_CALL + setup + MIN_GAP + BUFFER) {
        return start + BUFFER + (MIN_CALL + setup + MIN_GAP + BUFFER) + start + BUFFER;
      }
      // Keep the authored call-to-gap proportion where there is room for it.
      const room = perLoop - setup - BUFFER;                 // call + gap
      const authored = Math.max(1, was + gap);
      gap = Math.min(Math.max(MIN_GAP, Math.round(room * (gap / authored))), room - MIN_CALL);
      const call = Math.min(MAX_CALL, room - gap);
      p.sessionDuration = session;
      p.interSessionGap = gap;
      p.loopCount = loops;
      p.callDuration = call;
      notes.push(`${label}: ${loops} loop${loops === 1 ? '' : 's'} of a ${call}s call with a ${gap}s gap, in a ${session}s session`
        + (was && was !== call ? ` — the call was ${was}s` : ''));
    } else {
      // call + 2 × setup + start + 5 <= session
      const call = Math.min(MAX_CALL, session - 2 * setup - start - BUFFER);
      if (call < MIN_CALL) {
        return (MIN_CALL + 2 * setup + start + BUFFER) + start + BUFFER;
      }
      p.sessionDuration = session;
      p.callDuration = call;
      notes.push(`${label}: a ${call}s call in a ${session}s session`
        + (was && was !== call ? ` — the call was ${was}s` : ''));
    }
    return 0;
  }

  if (looping(p)) {
    let loops = Math.max(1, int(p?.loopCount, 5));
    let gap = num(p?.interSessionGap) || 20;
    const was = num(p?.sessionDuration);
    const floor = minSessionFor(p);
    // (session + gap) × loops + start + 5 <= powerOn
    const budget = powerOn - start - BUFFER;
    while (loops > 1 && Math.floor(budget / loops) < floor + MIN_GAP) loops--;
    const perLoop = Math.floor(budget / loops);
    if (perLoop < floor + MIN_GAP) return start + BUFFER + floor + MIN_GAP;
    const authored = Math.max(1, was + gap);
    gap = Math.min(Math.max(MIN_GAP, Math.round(perLoop * (gap / authored))), perLoop - floor);
    const session = perLoop - gap;
    p.sessionDuration = session;
    p.interSessionGap = gap;
    p.loopCount = loops;
    if (type(p) === 'ping') p.numberOfPackets = pingPackets(p);
    notes.push(`${label}: ${loops} loop${loops === 1 ? '' : 's'} of ${session}s with a ${gap}s gap`
      + (type(p) === 'ping' ? `, ${p.numberOfPackets} packets each` : ''));
    return 0;
  }

  // The plain case, and the one the row usually is: the session is the window
  // minus the delay before traffic starts.
  const session = powerOn - start;
  if (session < minSessionFor(p)) return start + minSessionFor(p);
  p.sessionDuration = session;
  if (type(p) === 'ping') p.numberOfPackets = pingPackets(p);
  return 0;
}

/** Everything the box checks, asked of a finished definition. Used to prove
 *  the fit rather than trust the algebra above — anything left over is a bug
 *  here, and better found by a test than by a refused run. */
export function boxComplaints(td: any): string[] {
  const out: string[] = [];
  const ups = profilesOf(td?.userPlaneConfig);
  for (const [i, p] of ups.entries()) {
    if (isIdle(p)) continue;
    const session = num(p?.sessionDuration);
    if (session <= 0) out.push(`userPlane[${i}]: sessionDuration must be greater than 0`);
    const floor = voiceSessionFloor(p);
    if (floor > 0 && session < floor) {
      out.push(`userPlane[${i}]: Duration should be greater than ${floor}s for VOLTE`);
    }
    if (type(p) === 'ping') {
      const packets = num(p?.numberOfPackets);
      const interval = num(p?.interval) || 1;
      if (packets * interval + num(p?.startDelay) > session) {
        out.push(`userPlane[${i}]: Interval ${interval}s is too high for the given session duration ${session}s`);
      }
    }
    if (looping(p)) {
      if (num(p?.interSessionGap) <= 0) out.push(`userPlane[${i}]: a looping profile needs an interSessionGap above 0`);
      if (int(p?.loopCount, 0) < 1) out.push(`userPlane[${i}]: a looping profile needs a loopCount of at least 1`);
    }
    if (isVoice(p) && num(p?.callDuration) > MAX_CALL) {
      out.push(`userPlane[${i}]: callDuration ${num(p.callDuration)} is above the ${MAX_CALL}s maximum`);
    }
  }
  for (const [i, pc] of profilesOf(td?.powerCycleConfig).entries()) {
    const mine = ups.filter((u) => sharesGroup(pc?.subscriberGroup, u?.subscriberGroup));
    const needed = mine.reduce((max, u) => Math.max(max, requiredPowerOn(u)), 0);
    if (num(pc?.powerOnTime) < needed) {
      out.push(`powerCycle[${i}]: Minimum Power On Time is ${needed} seconds`);
    }
    if (pc?.totalTestDuration !== undefined && pc?.totalTestDuration !== null) {
      const floor = (num(pc.powerOnTime) + num(pc.powerOffTime)) * Math.max(1, int(pc.noOfPowerOnCycles, 1)) + num(pc.attachDelay);
      if (num(pc.totalTestDuration) < floor) {
        out.push(`powerCycle[${i}]: Total Test Duration should be at least ${floor}s`);
      }
    }
  }
  for (const [i, m] of profilesOf(td?.mobilityConfig).entries()) {
    const powerOn = num(profilesOf(td?.powerCycleConfig)[0]?.powerOnTime);
    if (powerOn > 0 && num(m?.duration) > powerOn - BUFFER) {
      out.push(`mobility[${i}]: Duration should be at least 5 seconds less than Power On Time (${powerOn})`);
    }
  }
  return out;
}

function profilesOf(section: any): any[] {
  return (section?.profiles ?? []).filter((p: any) => p && typeof p === 'object');
}

/**
 * The power-on duration a definition already holds, and enough context to say
 * what it is made of.
 *
 * A test case may carry several power-cycle profiles — one per subscriber
 * group — with different windows. The one that decides how long the test runs
 * is the LONGEST, so that is the figure offered; the rest come back too, so a
 * caller can say when they disagree rather than silently showing one of them.
 *
 * Here rather than in the route that serves it, because the suite wizard reads
 * an uploaded test case the same way in the browser, and one reading of a
 * definition is better than two that can drift apart.
 */
export function powerOnOf(td: any): {
  powerOnTime: number | null;
  powerOnTimes: number[];
  dataTypes: string[];
  loops: boolean;
} {
  const powerOnTimes = profilesOf(td?.powerCycleConfig)
    .map((p) => num(p?.powerOnTime))
    .filter((n) => n > 0);
  const ups = profilesOf(td?.userPlaneConfig);
  return {
    powerOnTime: powerOnTimes.length ? Math.max(...powerOnTimes) : null,
    powerOnTimes,
    dataTypes: [...new Set(ups.map((p) => type(p)).filter(Boolean))],
    loops: ups.some((p) => looping(p)),
  };
}

/**
 * How long this definition will actually keep the box busy, by the box's own
 * sum — the one behind "Total Test Duration should be at least equal to the
 * total time taken for all power on/off cycles":
 *
 *   (powerOnTime + powerOffTime) × noOfPowerOnCycles + attachDelay
 *
 * This is NOT the figure the row asked for, and the difference is what made a
 * finished test look unfinished. A row asking for 100s whose power-on was
 * grown to 630s to hold its traffic ran for 630s while the runner listened for
 * 100s + slack, gave up, and stopped an execution the Simnovator went on to
 * complete — so the box said COMPLETED and the suite said ABORTED. Whatever
 * the row asked for, the wait has to be built on this.
 */
export function expectedRunSeconds(td: any): number {
  let worst = 0;
  for (const pc of profilesOf(td?.powerCycleConfig)) {
    const cycles = Math.max(1, int(pc?.noOfPowerOnCycles, 1));
    worst = Math.max(worst, (num(pc?.powerOnTime) + num(pc?.powerOffTime)) * cycles + num(pc?.attachDelay));
  }
  // A time-based power-cycle profile states its own total and may outlast the
  // sum above.
  for (const pc of profilesOf(td?.powerCycleConfig)) worst = Math.max(worst, num(pc?.totalTestDuration));
  return Math.ceil(worst);
}

/** The floor the box names when it refuses a session, read back out of the
 *  refusal. Kept as a safety net: the arithmetic above is the box's own, but a
 *  build that changes a constant would say so here first. */
export function sessionFloorFromError(text: string): number | null {
  const m = /(?:sessionDuration|Duration)\s+[\d.]*\s*should be greater than[^\d]*([\d.]+)/i.exec(text ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.ceil(n) : null;
}

/**
 * Rewrite a testDefinition's durations in place, for a requested power-on
 * duration in seconds.
 *
 * Returns notes describing anything that was derived or adjusted — they go
 * into the run log, because a row that asked for 100s and got 135s should say
 * why, and a call that was shortened to fit should say that too.
 */
export function applyDuration(td: any, seconds: number): string[] {
  const notes: string[] = [];
  let powerOn = Math.max(1, Math.floor(num(seconds)));
  if (powerOn < MIN_POWER_ON_SEC) {
    notes.push(`power-on duration raised from ${powerOn}s to the ${MIN_POWER_ON_SEC}s minimum`);
    powerOn = MIN_POWER_ON_SEC;
  }

  const ups = profilesOf(td?.userPlaneConfig);

  // Fit every profile into the window. A profile that cannot fit names the
  // window it would need; the largest such wins and everything is fitted
  // again, so one demanding profile does not leave the others mismatched.
  // Bounded: each pass either fits everything or raises the window.
  for (let pass = 0; pass < 6; pass++) {
    const passNotes: string[] = [];
    let needed = 0;
    for (const p of ups) needed = Math.max(needed, fitProfile(p, powerOn, passNotes));
    if (needed <= powerOn) {
      notes.push(...passNotes);
      break;
    }
    notes.push(`power-on duration raised from ${powerOn}s to ${needed}s — the shortest window this test's traffic fits in`);
    powerOn = needed;
  }

  // The power-cycle section is what the box calls Traffic, and powerOnTime is
  // the figure the row asked for. durationP is NOT a window of our choosing:
  // it is the minimum the box computes from the user-plane profiles, and it
  // compares powerOnTime against it. Writing anything else there — the old
  // code wrote powerOn − attachDelay — happened to pass only because the test
  // was then valid for the wrong reason.
  for (const pc of profilesOf(td?.powerCycleConfig)) {
    const mine = ups.filter((u) => sharesGroup(pc?.subscriberGroup, u?.subscriberGroup));
    const busiest = mine.reduce(
      (best: any, u: any) => (requiredPowerOn(u) > requiredPowerOn(best ?? {}) ? u : best),
      undefined as any,
    );
    pc.durationP = busiest ? requiredPowerOn(busiest) : 0;
    pc.powerOnTime = Math.max(powerOn, num(pc.durationP));
    if (busiest) pc.dataLoopP = looping(busiest);
    // A total that has to cover every power-on/off cycle, by the box's own sum.
    if (pc.totalTestDuration !== undefined && pc.totalTestDuration !== null) {
      const cycles = Math.max(1, int(pc.noOfPowerOnCycles, 1));
      pc.totalTestDuration = (num(pc.powerOnTime) + num(pc.powerOffTime)) * cycles + num(pc.attachDelay);
    }
  }

  // Mobility runs inside the power-on window and the box wants five seconds of
  // daylight. Only ever shortened: a mobility leg the test authored shorter
  // than the window is the author's choice.
  const powerOnTime = num(profilesOf(td?.powerCycleConfig)[0]?.powerOnTime) || powerOn;
  for (const m of profilesOf(td?.mobilityConfig)) {
    if (m.duration === undefined || m.duration === null) continue;
    const cap = powerOnTime - BUFFER;
    if (num(m.duration) > cap && cap > 0) {
      notes.push(`mobility leg shortened from ${num(m.duration)}s to ${cap}s to stay inside the power-on window`);
      m.duration = cap;
    }
  }

  return notes;
}

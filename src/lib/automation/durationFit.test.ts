// A row asks for a power-on duration; everything the box times is derived
// from it. These are the cases that matter, per data type.
//
// Every case ends with boxComplaints() — the box's own checks, transcribed
// from its form bundle — so a fit that would be refused fails here instead of
// three minutes into a run. The arithmetic is the box's; this is the proof
// that the inversion of it is right.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  applyDuration, sessionFloorFromError, boxComplaints, powerOnOf,
  requiredPowerOn, voiceSessionFloor, pingPackets, MIN_POWER_ON_SEC,
} = await import('./durationFit.ts');

/** Nothing the box would object to, after a fit. */
const accepted = (td: any) => assert.deepEqual(boxComplaints(td), []);

const pc = (over: Record<string, unknown> = {}) => ({
  powerOnTime: 600, durationP: 600, attachDelay: 0, loopProfile: 'disable',
  subscriberGroup: [-1], ...over,
});
const def = (profile: Record<string, unknown>, pcOver: Record<string, unknown> = {}) => ({
  userPlaneConfig: { profiles: [{ subscriberGroup: [-1], ...profile }] },
  powerCycleConfig: { profiles: [pc(pcOver)] },
});

// ── no data ───────────────────────────────────────────────────────────────

test('no_data: the power-on duration is the whole story, and the user plane is left alone', () => {
  // The box gives a no_data profile no window at all (its own durationP is 0),
  // and the two shapes in the lab disagree about whether sessionDuration is
  // even present — so nothing there is ours to set.
  const td: any = def({ dataType: 'no_data', pdnType: 'ipv4' });
  const notes = applyDuration(td, 100);
  assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, 100);
  assert.equal(td.powerCycleConfig.profiles[0].durationP, 0);
  assert.equal('sessionDuration' in td.userPlaneConfig.profiles[0], false);
  assert.deepEqual(notes, []);
  accepted(td);
});

test('no_data that happens to carry a session keeps it untouched', () => {
  const td: any = def({ dataType: 'no_data', sessionDuration: 600 });
  applyDuration(td, 100);
  assert.equal(td.userPlaneConfig.profiles[0].sessionDuration, 600);
  assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, 100);
  accepted(td);
});

// ── ping ──────────────────────────────────────────────────────────────────

test('ping: 100s with a 5s start delay is a 95s session', () => {
  const td: any = def({
    dataType: 'ping', startDelay: 5, interval: 1, numberOfPackets: 605,
    sessionDuration: 635, dataLoop: false,
  });
  applyDuration(td, 100);
  const p = td.userPlaneConfig.profiles[0];
  assert.equal(p.sessionDuration, 95);
  assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, 100);
  // The packet count is the box's own derivation — floor((95 − 5) / 1) — and
  // leaving the authored 605 behind is what made it refuse the interval.
  assert.equal(p.numberOfPackets, 90);
  accepted(td);
});

test('ping: no start delay means the session is the whole window', () => {
  const td: any = def({ dataType: 'ping', startDelay: 0, interval: 1, numberOfPackets: 10 });
  applyDuration(td, 100);
  assert.equal(td.userPlaneConfig.profiles[0].sessionDuration, 100);
  assert.equal(td.userPlaneConfig.profiles[0].numberOfPackets, 100);
  accepted(td);
});

test('ping: a sub-second interval gives proportionally more packets', () => {
  const td: any = def({ dataType: 'ping', startDelay: 5, interval: 0.2, numberOfPackets: 100 });
  applyDuration(td, 100);
  assert.equal(td.userPlaneConfig.profiles[0].sessionDuration, 95);
  assert.equal(td.userPlaneConfig.profiles[0].numberOfPackets, 450);   // (95 − 5) / 0.2
  accepted(td);
});

test('ping with loop false: only the session moves', () => {
  const td: any = def({
    dataType: 'ping', startDelay: 5, interval: 1, numberOfPackets: 25,
    sessionDuration: 30, dataLoop: false, loopCount: 5, interSessionGap: 20,
  });
  applyDuration(td, 100);
  const p = td.userPlaneConfig.profiles[0];
  assert.equal(p.sessionDuration, 95);
  assert.equal(p.loopCount, 5, 'a loop that is switched off is not rewritten');
  assert.equal(p.interSessionGap, 20);
  accepted(td);
});

test('ping with loop true: the session, the loop count and the gap all follow the window', () => {
  // The real shape on .95: 5 loops of a 30s session with a 20s gap, authored
  // inside a 695s window. Asked for 100s, five loops of 50s cannot fit, so the
  // loop is scaled — the authored 30:20 session-to-gap proportion survives.
  const td: any = def({
    dataType: 'ping', startDelay: 5, interval: 1, numberOfPackets: 25,
    sessionDuration: 30, dataLoop: true, loopCount: 5, interSessionGap: 20,
  }, { powerOnTime: 695 });
  const notes = applyDuration(td, 100);
  const p = td.userPlaneConfig.profiles[0];
  assert.equal(p.loopCount, 5);
  assert.equal((p.sessionDuration + p.interSessionGap) * p.loopCount + p.startDelay + 5, 100);
  assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, 100);
  assert.equal(td.powerCycleConfig.profiles[0].dataLoopP, true);
  assert.equal(p.numberOfPackets, pingPackets(p));
  assert.match(notes.join(' '), /5 loops of \d+s with a \d+s gap/);
  accepted(td);
});

test('ping with loop true: loops are dropped only when they cannot be made short enough', () => {
  const td: any = def({
    dataType: 'ping', startDelay: 5, interval: 1,
    sessionDuration: 30, dataLoop: true, loopCount: 20, interSessionGap: 20,
  });
  applyDuration(td, 60);
  const p = td.userPlaneConfig.profiles[0];
  assert.ok(p.loopCount < 20, `20 loops cannot fit in 60s — got ${p.loopCount}`);
  assert.ok(p.sessionDuration >= 5 && p.interSessionGap >= 1);
  assert.ok(requiredPowerOn(p) <= 60);
  accepted(td);
});

// ── http, iperf, ftp, rtsp ────────────────────────────────────────────────

for (const dataType of ['http', 'iperf', 'ftp', 'rtsp', 'tcp', 'udp']) {
  test(`${dataType}: the window is honoured and nothing is left for the box to refuse`, () => {
    const td: any = def({ dataType, startDelay: 5, sessionDuration: 600, dataLoop: false });
    const notes = applyDuration(td, 100);
    assert.equal(td.userPlaneConfig.profiles[0].sessionDuration, 95);
    assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, 100);
    assert.equal(td.powerCycleConfig.profiles[0].durationP, 100);
    assert.deepEqual(notes, []);
    accepted(td);
  });
}

test('iperf with loop true: the longevity shape scales into a short window', () => {
  // LONGEVITY_72_HOURS…: 4320 loops of 30s with a 30s gap. Asked for 300s,
  // 4320 loops is impossible, so the count comes down and the rest follows.
  const td: any = def({
    dataType: 'iperf', startDelay: 15, sessionDuration: 30,
    dataLoop: true, loopCount: 4320, interSessionGap: 30,
  }, { powerOnTime: 259225, attachDelay: 1 });
  applyDuration(td, 300);
  const p = td.userPlaneConfig.profiles[0];
  assert.ok(p.loopCount >= 1 && p.loopCount < 4320);
  assert.ok(requiredPowerOn(p) <= 300);
  accepted(td);
});

// ── VoNR / ViNR ───────────────────────────────────────────────────────────

test('voice: 100s shortens the call to fit, rather than growing the window to 535s', () => {
  // The old behaviour: a 210s row carrying a 500s call quietly became a 535s
  // run. Now 100s means 100s — session 90, and a call that fits inside it.
  const td: any = def({
    dataType: 'volte', callDuration: 500, callSetupDelay: 5, startDelay: 5,
    sessionDuration: 600, vonrSupportP: true,
  });
  const notes = applyDuration(td, 100);
  const p = td.userPlaneConfig.profiles[0];
  assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, 100);
  assert.equal(p.sessionDuration, 90);                      // 100 − 5 − 5
  assert.equal(p.callDuration, 70);                         // 90 − 2×5 − 5 − 5
  assert.ok(p.sessionDuration >= voiceSessionFloor(p));
  assert.match(notes.join(' '), /a 70s call in a 90s session — the call was 500s/);
  accepted(td);
});

test('voice: a call already short enough is still re-derived, and still fits', () => {
  const td: any = def({
    dataType: 'volte', callDuration: 50, callSetupDelay: 5, startDelay: 5, sessionDuration: 600,
  });
  applyDuration(td, 900);
  const p = td.userPlaneConfig.profiles[0];
  assert.equal(p.sessionDuration, 890);
  assert.equal(p.callDuration, 870);
  accepted(td);
});

test('voice: the call is capped at the box maximum however long the window is', () => {
  const td: any = def({ dataType: 'volte', callDuration: 500, callSetupDelay: 5, startDelay: 5 });
  applyDuration(td, 9000);
  assert.equal(td.userPlaneConfig.profiles[0].callDuration, 3600);
  accepted(td);
});

test('voice with loop true: duration, call, gap and loop count all follow the window', () => {
  // SIT_TC_312_VoNR_Short_call_loop…: 10 loops of a 300s call, 5s gap, in a
  // 3600s session. Asked for 600s it has to come down, and by the box's loop
  // rule — (call + setup + gap + 5) × loops + start + 5 — not the plain one.
  const td: any = def({
    dataType: 'volte', callDuration: 300, callSetupDelay: 5, startDelay: 5,
    sessionDuration: 3600, dataLoop: true, loopCount: 10, interSessionGap: 5,
  }, { powerOnTime: 3700, noOfPowerOnCycles: 0, powerOffTime: 0, totalTestDuration: 0 });
  const notes = applyDuration(td, 600);
  const p = td.userPlaneConfig.profiles[0];
  assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, 600);
  assert.equal(p.sessionDuration, 590);
  assert.equal(p.loopCount, 10);
  assert.ok(p.sessionDuration >= voiceSessionFloor(p),
    `session ${p.sessionDuration} must clear the loop floor ${voiceSessionFloor(p)}`);
  assert.match(notes.join(' '), /10 loops of a \d+s call/);
  accepted(td);
});

test('voice with loop true: loops come down when the window cannot hold them', () => {
  const td: any = def({
    dataType: 'volte', callDuration: 300, callSetupDelay: 5, startDelay: 5,
    sessionDuration: 3600, dataLoop: true, loopCount: 10, interSessionGap: 5,
  });
  applyDuration(td, 120);
  const p = td.userPlaneConfig.profiles[0];
  assert.ok(p.loopCount < 10, `10 loops cannot fit in 120s — got ${p.loopCount}`);
  assert.ok(p.callDuration >= 5);
  accepted(td);
});

test('voice: a window too small for the shortest legal call is raised, and says so', () => {
  const td: any = def({ dataType: 'volte', callDuration: 500, callSetupDelay: 5, startDelay: 5 });
  const notes = applyDuration(td, MIN_POWER_ON_SEC);
  assert.ok(td.powerCycleConfig.profiles[0].powerOnTime > MIN_POWER_ON_SEC);
  assert.match(notes.join(' '), /shortest window this test's traffic fits in/);
  accepted(td);
});

test('registration-only voice has no call to fit, so only the session moves', () => {
  const td: any = def({
    dataType: 'volte', registrationOnly: true, callDuration: 500,
    callSetupDelay: 5, startDelay: 5, sessionDuration: 600,
  });
  applyDuration(td, 100);
  assert.equal(td.userPlaneConfig.profiles[0].sessionDuration, 90);
  assert.equal(voiceSessionFloor(td.userPlaneConfig.profiles[0]), 0);
  accepted(td);
});

// ── the power-cycle section ───────────────────────────────────────────────

test('durationP is the box’s minimum, not a window we choose', () => {
  // It used to be written as powerOn − attachDelay, which passed validation by
  // accident. The box computes it from the user-plane profiles and compares
  // powerOnTime against it.
  const td: any = def({ dataType: 'iperf', startDelay: 15, sessionDuration: 600 }, { attachDelay: 7 });
  applyDuration(td, 200);
  const p = td.powerCycleConfig.profiles[0];
  assert.equal(p.durationP, 200);                 // 185 session + 15 start
  assert.equal(p.powerOnTime, 200);
  accepted(td);
});

test('the busiest profile sets durationP, and its loop flag sets dataLoopP', () => {
  const td: any = {
    userPlaneConfig: {
      profiles: [
        { dataType: 'ping', subscriberGroup: [0], startDelay: 5, interval: 1 },
        { dataType: 'volte', subscriberGroup: [1], startDelay: 5, callSetupDelay: 5, callDuration: 50 },
      ],
    },
    powerCycleConfig: { profiles: [pc({ subscriberGroup: [-1] })] },
  };
  applyDuration(td, 300);
  // ping needs 300 (295 + 5); voice needs 300 (290 + 5 + 5). Equal, and both fit.
  assert.equal(td.powerCycleConfig.profiles[0].durationP, 300);
  assert.equal(td.powerCycleConfig.profiles[0].dataLoopP, false);
  accepted(td);
});

test('a profile in another subscriber group does not set this entry’s minimum', () => {
  const td: any = {
    userPlaneConfig: {
      profiles: [
        { dataType: 'iperf', subscriberGroup: [0], startDelay: 5, sessionDuration: 100 },
        { dataType: 'iperf', subscriberGroup: [1], startDelay: 60, sessionDuration: 100 },
      ],
    },
    powerCycleConfig: { profiles: [pc({ subscriberGroup: [0] }), pc({ subscriberGroup: [1] })] },
  };
  applyDuration(td, 200);
  assert.equal(td.powerCycleConfig.profiles[0].durationP, 200);
  assert.equal(td.powerCycleConfig.profiles[1].durationP, 200);
  accepted(td);
});

test('the lab’s "[1]" subscriber group string is matched like the array it means', () => {
  const td: any = {
    userPlaneConfig: { profiles: [{ dataType: 'iperf', subscriberGroup: '[1]', startDelay: 5 }] },
    powerCycleConfig: { profiles: [pc({ subscriberGroup: '[1]' })] },
  };
  applyDuration(td, 150);
  assert.equal(td.powerCycleConfig.profiles[0].durationP, 150);
  accepted(td);
});

test('a total test duration covers every power-on/off cycle, by the box’s own sum', () => {
  const td: any = def({ dataType: 'iperf', startDelay: 5 }, {
    totalTestDuration: 100, powerOffTime: 10, noOfPowerOnCycles: 3, attachDelay: 2,
  });
  applyDuration(td, 200);
  const p = td.powerCycleConfig.profiles[0];
  assert.equal(p.totalTestDuration, (200 + 10) * 3 + 2);
  accepted(td);
});

test('a mobility leg is shortened to stay five seconds inside the window', () => {
  const td: any = def({ dataType: 'iperf', startDelay: 5 });
  (td as any).mobilityConfig = { profiles: [{ duration: 600, speed: 10 }] };
  const notes = applyDuration(td, 200);
  assert.equal(td.mobilityConfig.profiles[0].duration, 195);
  assert.match(notes.join(' '), /mobility leg shortened/);
  accepted(td);
});

test('a mobility leg already inside the window is the author’s choice', () => {
  const td: any = def({ dataType: 'iperf', startDelay: 5 });
  (td as any).mobilityConfig = { profiles: [{ duration: 60 }] };
  applyDuration(td, 200);
  assert.equal(td.mobilityConfig.profiles[0].duration, 60);
  accepted(td);
});

// ── the floor, and the box's own words ───────────────────────────────────

test('nothing runs below the power-on floor', () => {
  const td: any = def({ dataType: 'iperf', startDelay: 5 });
  const notes = applyDuration(td, 5);
  assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, MIN_POWER_ON_SEC);
  assert.match(notes.join(' '), /minimum/);
  accepted(td);
});

test('the floor the box names is read back out of its refusal', () => {
  assert.equal(
    sessionFloorFromError('{"message":"UserPlaneConfig: userPlane[0]: sessionDuration 200 should be greater than 520s for VOLTE"}'),
    520,
  );
  assert.equal(sessionFloorFromError('Duration should be greater than 3105s for VOLTE'), 3105);
  assert.equal(
    sessionFloorFromError('userPlane[0]: sessionDuration 205 should be greater than NoOfPackets * Interval + StartDelay i.e, 600 for PING'),
    600,
  );
  assert.equal(sessionFloorFromError('some other rejection entirely'), null);
  assert.equal(sessionFloorFromError(''), null);
});

// ── the box's formulas, as transcribed ───────────────────────────────────

test('requiredPowerOn is the box’s own per-profile window', () => {
  assert.equal(requiredPowerOn({ dataType: 'no_data', sessionDuration: 600, startDelay: 5 }), 0);
  assert.equal(requiredPowerOn({ dataType: 'sms', sessionDuration: 600, startDelay: 5 }), 0);
  assert.equal(requiredPowerOn({ dataType: 'volte', sessionDuration: 600, startDelay: 5 }), 610);
  assert.equal(requiredPowerOn({ dataType: 'iperf', sessionDuration: 600, startDelay: 5 }), 605);
  assert.equal(
    requiredPowerOn({ dataType: 'ping', sessionDuration: 30, startDelay: 5, dataLoop: true, loopCount: 5, interSessionGap: 20 }),
    260,                                     // (30 + 20) × 5 + 5 + 5
  );
});

test('voiceSessionFloor is the box’s own VOLTE rule, both branches', () => {
  assert.equal(
    voiceSessionFloor({ dataType: 'volte', callDuration: 500, callSetupDelay: 5, startDelay: 5 }),
    520,                                     // 500 + 2×5 + 5 + 5
  );
  assert.equal(
    voiceSessionFloor({ dataType: 'volte', callDuration: 300, callSetupDelay: 5, startDelay: 5, dataLoop: true, loopCount: 10, interSessionGap: 5 }),
    3160,                                    // (300 + 5 + 5 + 5) × 10 + 5 + 5
  );
  assert.equal(voiceSessionFloor({ dataType: 'iperf', callDuration: 500 }), 0);
});

test('pingPackets is the box’s own derivation', () => {
  assert.equal(pingPackets({ sessionDuration: 635, startDelay: 30, interval: 1 }), 605);
  assert.equal(pingPackets({ sessionDuration: 30, startDelay: 5, interval: 1 }), 25);
  assert.equal(pingPackets({ sessionDuration: 10, startDelay: 9, interval: 5 }), 1);   // never 0
});

test('boxComplaints catches what the box would have caught', () => {
  // A session too short for its call: the VOLTE refusal.
  assert.match(
    boxComplaints(def({ dataType: 'volte', callDuration: 500, callSetupDelay: 5, startDelay: 5, sessionDuration: 100 })).join(' '),
    /should be greater than 520s for VOLTE/,
  );
  // A stale packet count: the interval refusal.
  assert.match(
    boxComplaints(def({ dataType: 'ping', numberOfPackets: 605, interval: 1, startDelay: 5, sessionDuration: 95 })).join(' '),
    /Interval 1s is too high/,
  );
  // A window smaller than the box's own minimum.
  assert.match(
    boxComplaints(def({ dataType: 'iperf', startDelay: 5, sessionDuration: 600 }, { powerOnTime: 100 })).join(' '),
    /Minimum Power On Time is 605 seconds/,
  );
  // A loop with no gap.
  assert.match(
    boxComplaints(def({ dataType: 'ping', dataLoop: true, loopCount: 5, interSessionGap: 0, sessionDuration: 30, startDelay: 5, interval: 1, numberOfPackets: 25 })).join(' '),
    /needs an interSessionGap above 0/,
  );
});

// ── what a test case already holds ───────────────────────────────────────

test('powerOnOf reports the duration a test case already runs for', () => {
  const td = def({ dataType: 'ping', startDelay: 5, interval: 1, dataLoop: false }, { powerOnTime: 605 });
  const got = powerOnOf(td);
  assert.equal(got.powerOnTime, 605);
  assert.deepEqual(got.powerOnTimes, [605]);
  assert.deepEqual(got.dataTypes, ['ping']);
  assert.equal(got.loops, false);
});

test('powerOnOf takes the longest window, because that is what governs the run', () => {
  const td: any = {
    userPlaneConfig: {
      profiles: [
        { dataType: 'iperf', subscriberGroup: [0], dataLoop: true },
        { dataType: 'volte', subscriberGroup: [1] },
      ],
    },
    powerCycleConfig: { profiles: [pc({ powerOnTime: 120 }), pc({ powerOnTime: 900 })] },
  };
  const got = powerOnOf(td);
  assert.equal(got.powerOnTime, 900);
  assert.deepEqual(got.powerOnTimes, [120, 900]);
  assert.deepEqual(got.dataTypes, ['iperf', 'volte']);
  assert.equal(got.loops, true, 'a looping profile anywhere is worth saying');
});

test('powerOnOf says nothing rather than guessing when a definition names no window', () => {
  assert.equal(powerOnOf({}).powerOnTime, null);
  assert.equal(powerOnOf({ powerCycleConfig: { profiles: [{ attachDelay: 0 }] } }).powerOnTime, null);
  // A zero is not a window either — the lab has testcases carrying one.
  assert.equal(powerOnOf({ powerCycleConfig: { profiles: [{ powerOnTime: 0 }] } }).powerOnTime, null);
});

test('what powerOnOf reads is what applyDuration would put back', () => {
  // Round trip: a 605s test case offered as 605 and left alone comes back 605.
  const td: any = def({ dataType: 'ping', startDelay: 5, interval: 1, sessionDuration: 600 }, { powerOnTime: 605 });
  const asked = powerOnOf(td).powerOnTime as number;
  applyDuration(td, asked);
  assert.equal(powerOnOf(td).powerOnTime, 605);
  assert.equal(td.userPlaneConfig.profiles[0].sessionDuration, 600);
  accepted(td);
});

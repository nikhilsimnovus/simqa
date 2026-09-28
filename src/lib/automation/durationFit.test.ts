// A row asks for a duration; the box decides whether that duration can hold
// the test. These are the cases where the two disagree.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applyDuration, sessionFloorFromError, MIN_POWER_ON_SEC } =
  await import('./durationFit.ts');

/** A VoNR row as the box really holds it — 500s call, 5s setup, 5s start. */
const vonr = () => ({
  userPlaneConfig: {
    profiles: [{
      dataType: 'volte', callDuration: 500, callSetupDelay: 5, startDelay: 5,
      sessionDuration: 600, vonrSupportP: true,
    }],
  },
  powerCycleConfig: { profiles: [{ powerOnTime: 610, durationP: 610, attachDelay: 0, loopProfile: 'disable' }] },
});

const data = () => ({
  userPlaneConfig: { profiles: [{ dataType: 'tcp', startDelay: 5, sessionDuration: 100 }] },
  powerCycleConfig: { profiles: [{ powerOnTime: 105, durationP: 105, attachDelay: 0, loopProfile: 'disable' }] },
});

test('a data row runs for exactly as long as it was asked to', () => {
  const td = data();
  const notes = applyDuration(td, 200);
  assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, 200);
  assert.equal(td.userPlaneConfig.profiles[0].sessionDuration, 195);   // 200 − startDelay
  assert.deepEqual(notes, []);
});

test('a voice row too short for its own call is grown to fit it, not refused', () => {
  // The bug: 210s was sent as-is, the box answered "sessionDuration 200 should
  // be greater than 520s for VOLTE", and the row never ran.
  const td = vonr();
  const notes = applyDuration(td, 210);
  const session = td.userPlaneConfig.profiles[0].sessionDuration;
  assert.ok(session > 520, `session ${session} must clear the box's 520s floor`);
  assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, 535);
  assert.match(notes.join(' '), /505s of traffic/);
});

test('a ping row is measured the way the box measures it', () => {
  // 595 packets one second apart plus a 5s start — the box refuses anything
  // under 600 and says so as a formula, not a number.
  const td: any = {
    userPlaneConfig: { profiles: [{ dataType: 'ping', numberOfPackets: 595, interval: 1, startDelay: 5, sessionDuration: 600 }] },
    powerCycleConfig: { profiles: [{ powerOnTime: 605, durationP: 605, attachDelay: 0 }] },
  };
  applyDuration(td, 210);
  assert.ok(td.userPlaneConfig.profiles[0].sessionDuration > 600,
    `session ${td.userPlaneConfig.profiles[0].sessionDuration} must clear the box's 600s floor`);
  assert.equal(td.userPlaneConfig.profiles[0].numberOfPackets, 595, 'packets are never dropped to fit');
});

test('a sub-second ping interval is not rounded away', () => {
  const td: any = {
    userPlaneConfig: { profiles: [{ dataType: 'ping', numberOfPackets: 100, interval: 0.2, startDelay: 5 }] },
    powerCycleConfig: { profiles: [{ powerOnTime: 20, durationP: 20, attachDelay: 0 }] },
  };
  applyDuration(td, 20);
  // 100 × 0.2 + 5 = 25s of traffic, so the window has to exceed that.
  assert.ok(td.powerCycleConfig.profiles[0].powerOnTime > 25);
});

test('the call itself is never cut to fit the requested window', () => {
  const td = vonr();
  applyDuration(td, 30);
  assert.equal(td.userPlaneConfig.profiles[0].callDuration, 500);
});

test('a voice row already long enough is left alone', () => {
  const td = vonr();
  const notes = applyDuration(td, 900);
  assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, 900);
  assert.deepEqual(notes, []);
});

test('a voice profile that names no call still gets a workable session', () => {
  const td: any = {
    userPlaneConfig: { profiles: [{ dataType: 'vonr', startDelay: 5, callSetupDelay: 5 }] },
    powerCycleConfig: { profiles: [{ powerOnTime: 20, durationP: 20, attachDelay: 0 }] },
  };
  applyDuration(td, 20);
  assert.ok(td.userPlaneConfig.profiles[0].sessionDuration >= 75);
});

test('nothing runs below the power-on floor', () => {
  const td = data();
  const notes = applyDuration(td, 5);
  assert.equal(td.powerCycleConfig.profiles[0].powerOnTime, MIN_POWER_ON_SEC);
  assert.match(notes.join(' '), /minimum/);
});

test('the floor the box names is read back out of its refusal', () => {
  assert.equal(
    sessionFloorFromError('{"code":"BAD_REQUEST","message":"UserPlaneConfig: userPlane[0]: sessionDuration 200 should be greater than 520s for VOLTE"}'),
    520,
  );
  // A different profile, a different number — the message is followed, not a constant.
  assert.equal(sessionFloorFromError('sessionDuration 10 should be greater than 70s for VOLTE'), 70);
  // PING states the formula it used rather than a bare figure; the number it
  // arrived at is still what has to be cleared.
  assert.equal(
    sessionFloorFromError('UserPlaneConfig: userPlane[0]: sessionDuration 205 should be greater than NoOfPackets * Interval + StartDelay i.e, 600 for PING'),
    600,
  );
  assert.equal(sessionFloorFromError('some other rejection entirely'), null);
  assert.equal(sessionFloorFromError(''), null);
});

test('a time-based loop keeps a total the box will accept', () => {
  const td: any = data();
  td.powerCycleConfig.profiles[0].loopProfile = 'time';
  td.powerCycleConfig.profiles[0].totalTestDuration = 100;
  td.powerCycleConfig.profiles[0].powerOffTime = 10;
  applyDuration(td, 200);
  const p = td.powerCycleConfig.profiles[0];
  assert.ok(p.totalTestDuration > p.powerOnTime, 'total must outlast one power-on window');
});

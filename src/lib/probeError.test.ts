import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeProbeError, probeErrorLine } from './probeError.ts';

/** What Node's fetch really throws: "fetch failed", with the code buried. */
const fetchFailed = (code: string) => {
  const inner: any = new Error(`connect ${code} 192.168.1.95:80`);
  inner.code = code;
  const outer: any = new TypeError('fetch failed');
  outer.cause = inner;
  return outer;
};

test('a box that accepts and drops the connection is reported as what it is', () => {
  // Measured on 192.168.1.95: SSH answered, port 80 closed without a byte.
  const f = describeProbeError(fetchFailed('ECONNRESET'), { host: '192.168.1.95' });
  assert.match(f.text, /192\.168\.1\.95/);
  assert.match(f.text, /the machine is up, its web service is not/);
  assert.equal(f.code, 'ECONNRESET');
  assert.match(f.hint!, /restart the Simnovator service/i);
});

test('refused, unreachable and timed out are three different sentences', () => {
  const refused = describeProbeError(fetchFailed('ECONNREFUSED'), { host: 'h' });
  const unreach = describeProbeError(fetchFailed('EHOSTUNREACH'), { host: 'h' });
  const timeout = describeProbeError(fetchFailed('ETIMEDOUT'), { host: 'h' });
  assert.match(refused.text, /nothing is listening/);
  assert.match(unreach.text, /off the network/);
  assert.match(timeout.text, /powered off, or a firewall/);
  assert.notEqual(refused.text, unreach.text);
  assert.notEqual(unreach.text, timeout.text);
});

test('a box that answers and refuses the login is not called unreachable', () => {
  // The machine is fine; what is wrong is the credential, and the two need
  // different people to do different things.
  const f = describeProbeError(new Error('login failed: HTTP 401'), { host: '192.168.1.95' });
  assert.match(f.text, /refused the login/);
  assert.equal(f.code, 'HTTP 401');
  assert.match(f.hint!, /System Management/);
});

test('a server error keeps its status', () => {
  const f = describeProbeError(new Error('request failed with status 503'), { host: 'h' });
  assert.match(f.text, /server error \(HTTP 503\)/);
  assert.equal(f.code, 'HTTP 503');
});

test('our own timeout wrapper is recognised, and says how long it waited', () => {
  const f = describeProbeError(new Error('listSimulators 192.168.1.95 timed out'), { host: 'h', timeoutMs: 4000 });
  assert.match(f.text, /did not answer within 4s/);
  assert.equal(f.code, 'timeout');
});

test('a bare "fetch failed" does not pretend to know more than it does', () => {
  const f = describeProbeError(new TypeError('fetch failed'), { host: 'h' });
  assert.equal(f.text, 'h could not be reached');
  assert.equal(f.code, 'fetch failed');
});

test('anything else is passed through rather than swallowed', () => {
  const f = describeProbeError(new Error('socket hang up'), { host: 'h' });
  assert.match(f.text, /socket hang up/);
  assert.equal(probeErrorLine(f), 'h: socket hang up');
  assert.equal(probeErrorLine(undefined), undefined);
});

test('the one-line form carries the code and the hint', () => {
  const line = probeErrorLine(describeProbeError(fetchFailed('ECONNREFUSED'), { host: 'h' }));
  assert.match(line!, /nothing is listening/);
  assert.match(line!, /\(ECONNREFUSED\)/);
});

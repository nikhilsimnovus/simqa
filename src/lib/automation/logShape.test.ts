import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logLines, STAT_KINDS } from './logShape.ts';

test('the four statistics the box serves', () => {
  assert.deepEqual([...STAT_KINDS], ['global', 'cells', 'ues', 'ue-summary']);
});

test('a log blob with newlines becomes lines', () => {
  assert.deepEqual(logLines('one\ntwo\r\nthree'), ['one', 'two', 'three']);
});

test('an array of strings is already lines', () => {
  assert.deepEqual(logLines(['a', 'b']), ['a', 'b']);
});

test('objects are flattened to timestamp, level and message', () => {
  assert.deepEqual(
    logLines([{ timestamp: '12:00:01', level: 'INFO', message: 'UE attached' }]),
    ['12:00:01 INFO UE attached'],
  );
  // Whatever the build calls the message field.
  assert.deepEqual(logLines([{ msg: 'x' }]), ['x']);
  assert.deepEqual(logLines([{ line: 'y' }]), ['y']);
  assert.deepEqual(logLines([{ text: 'z' }]), ['z']);
  // Partial records keep what they have rather than printing "undefined".
  assert.deepEqual(logLines([{ message: 'bare' }]), ['bare']);
});

test('a wrapper object is unwrapped by whichever key it uses', () => {
  for (const key of ['logs', 'lines', 'items', 'data', 'content']) {
    assert.deepEqual(logLines({ [key]: ['a', 'b'] }), ['a', 'b'], key);
  }
  assert.deepEqual(logLines({ logs: 'a\nb' }), ['a', 'b']);
});

test('nothing is nothing, not a line saying so', () => {
  assert.deepEqual(logLines(undefined), []);
  assert.deepEqual(logLines(null), []);
  assert.deepEqual(logLines([]), []);
});

test('an unreadable shape is shown rather than dropped', () => {
  // Better a line of JSON than a viewer that silently shows nothing and lets
  // "no logs" mean two different things.
  assert.deepEqual(logLines({ odd: 1 }), ['{"odd":1}']);
  assert.deepEqual(logLines([{ odd: 1 }]), ['{"odd":1}']);
});

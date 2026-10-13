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

test("the Simnovator's protocol log is decoded, not stringified", () => {
  // Verbatim shape from 192.168.1.95.
  const rec = {
    cellId: 1, direction: 'DL', executionId: '01a12082', index: 1, layer: 'RRC',
    logData: ['BCCH-BCH: Master Information Block\n{\n  message {\n    dl-Bandwidth n100\n  }\n}'],
  };
  const lines = logLines([rec]);
  assert.equal(lines[0], '── RRC · DL · cell 1');
  assert.equal(lines[1], 'BCCH-BCH: Master Information Block');
  assert.ok(lines.includes('    dl-Bandwidth n100'), 'the decode keeps its own lines');
  // The point: no escaped JSON anywhere.
  assert.ok(!lines.some((l) => l.includes('\n')), 'a line still holds escaped newlines');
});

test('several protocol records run together in order', () => {
  const mk = (cell: number, text: string) => ({ cellId: cell, direction: 'UL', layer: 'MAC', logData: [text] });
  const lines = logLines([mk(1, 'first'), mk(2, 'second')]);
  assert.deepEqual(lines, ['── MAC · UL · cell 1', 'first', '── MAC · UL · cell 2', 'second']);
});

test('a protocol record missing its header fields still yields its text', () => {
  assert.deepEqual(logLines([{ logData: ['bare line'] }]), ['bare line']);
});

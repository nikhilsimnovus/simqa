// The port's self-check, taken from test_tool.py of the tool this came from.
//
// These are that tool's own assertions, run against the same openapi.yaml, so
// a difference here means the port behaves differently from the original —
// which is the one thing this integration must not do. They cover the wiring,
// the delete-safety guard, the key-level comparison and the status rules.
//
// The parts of test_tool.py that drive a mock HTTP server are not here; those
// are covered by running against a real Simnovator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

const { Spec, placeholders } = await import('./spec.ts');
const testplan = await import('./testplan.ts');
const { Run } = await import('./runner.ts');

const spec = new Spec(fs.readFileSync('assets/api-validation/openapi.yaml', 'utf8'));
const ops = spec.byId;

/** A stand-in for one HTTP reply, in the shape the runner's check() reads. */
function reply(code: number, body: unknown, contentType = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return {
    status: code, statusText: '', headers: { 'content-type': contentType },
    bytes, text, url: 'http://x', json: () => JSON.parse(text),
  };
}

const probe = new Run(spec, { host: 'x', username: 'u', password: 'p', selected: [] } as never);
const strict = new Run(spec, { host: 'x', username: 'u', password: 'p', selected: [], strictStatus: true } as never);
const labels = (r: { issues: Array<[string, string]> }) => r.issues.map(i => i[0]);

// ---------------------------------------------------------------- wiring --

test('the document holds the 86 operations the tool was written against', () => {
  assert.equal(spec.ops.length, 86);
});

test('every shared value an API needs has an API that produces it', () => {
  for (const op of spec.ops) {
    const d = testplan.defaults(spec, op);
    for (const v of placeholders([d.params, d.bodies])) {
      if (testplan.BUILTIN_VARS.has(v)) continue;
      assert.ok(testplan.producerOf(v), `${op.id} needs '${v}' but no API produces it`);
    }
  }
});

test('the wiring names no API the document does not have', () => {
  const named = [
    ...testplan.CREATORS, ...testplan.CLEANUP_ORDER,
    ...Object.keys(testplan.CAPTURES), ...Object.keys(testplan.BODY_DEFAULTS),
  ];
  for (const id of named) assert.ok(id in ops, `testplan names unknown API ${id}`);
});

// --------------------------------------------------------- delete safety --

test('the safety guard blocks anything this run did not create', () => {
  assert.ok(testplan.guard(ops.deleteUser, { username: 'admin' }, {}, null, new Set(['sat_x'])));
  assert.equal(testplan.guard(ops.deleteUser, { username: 'sat_x' }, {}, null, new Set(['sat_x'])), undefined);
  // Safety off is the operator's call.
  assert.equal(testplan.guard(ops.deleteTestCases, {}, {}, { scope: 'all' }, new Set(), false), undefined);
  assert.ok(testplan.guard(ops.deleteTestCases, {}, {}, { scope: 'multiple', testCaseIds: ['t1', 'other'] }, new Set(['t1'])));
  assert.equal(testplan.guard(ops.deleteTestCases, {}, {}, { scope: 'multiple', testCaseIds: ['t1'] }, new Set(['t1'])), undefined);
  assert.ok(testplan.guard(ops.updateUserPassword, {}, {}, { username: 'admin' }, new Set(['sat_x'])));
  // A read is never guarded.
  assert.equal(testplan.guard(ops.getAllUsers, {}, {}, null, new Set()), undefined);
});

// ------------------------------------------------- key-level comparison --

const E = { $ref: '#/components/schemas/Error' };
const kinds = (value: unknown, types = false) => spec.shapeErrors(E, value, types).map(k => k[0]);

test('bodies are compared by keys: values and types are not judged by default', () => {
  assert.deepEqual(kinds({ code: 'forbidden', message: 'This feature is disabled' }), []);
  assert.deepEqual(kinds({ code: 5, message: 'x' }), []);
  assert.deepEqual(kinds({ code: 5, message: 'x' }, true), ['WRONG_TYPE']);
  assert.deepEqual(kinds({ message: 'x', extra: 1 }), ['MISSING_KEY', 'UNDOCUMENTED_KEY']);
  assert.deepEqual(kinds([{ code: 'a', message: 'b' }]), ['WRONG_STRUCTURE']);
});

test('the same problem in every array item is reported once, with a count', () => {
  const items = { type: 'array', items: E };
  assert.deepEqual(
    spec.shapeErrors(items, [{ code: 'a', message: 'b', x: 1 }, { code: 'a', message: 'b', x: 1 }, { code: 'a', message: 'b', x: 1 }]),
    [['UNDOCUMENTED_KEY', "[]: key 'x' is not in the document (e.g. 1) (×3)"]],
  );
});

test('a oneOf body names the closest documented variant', () => {
  const cells = spec.byId.createCellConfig.body!;
  const found = spec.shapeErrors(cells.schema, cells.examples['SA-UE'], true);
  assert.ok(found.length > 0);
  assert.ok(found.every(([, m]) => m.includes('SA_UE_Cell]')), found.slice(0, 2).map(f => f[1]).join(' | '));
});

// ------------------------------------------------------- the status rule --

test('a positive test passes on another documented code, with a note', () => {
  const users = ops.getAllUsers;
  const positive = probe.makeCase(users, 'positive', 'positive');
  const r = probe.check(users, positive, reply(403, { code: 'FORBIDDEN', message: 'admin role required' }) as never);
  assert.deepEqual(r.issues, []);
  assert.ok(r.note.startsWith('Documented 403'), r.note);
});

test('a negative test that the server accepts is a failure', () => {
  const users = ops.getAllUsers;
  const negative = { ...probe.makeCase(users, 'positive', 'positive'), kind: 'negative' as const, expect: ['401'] };
  assert.equal(labels(probe.check(users, negative, reply(200, {}) as never))[0], 'WRONG_STATUS');
});

test('a code the document does not list always fails', () => {
  const users = ops.getAllUsers;
  assert.deepEqual(
    labels(probe.check(users, probe.makeCase(users, 'positive', 'positive'), reply(418, {}) as never)),
    ['UNDOCUMENTED_STATUS'],
  );
});

test('a negative test must get the code documented for ITS reason', () => {
  const reset = ops.resetUserPassword;
  const error = { code: 'X', message: 'y' };
  const unknownId = { ...probe.makeCase(reset, 'Unknown ID in path', 'negative'), expect: ['404'] };
  assert.deepEqual(probe.check(reset, unknownId, reply(404, error) as never).issues, []);
  // 401 is documented for this API, but it is not the code for an unknown ID.
  assert.deepEqual(labels(probe.check(reset, unknownId, reply(401, error) as never)), ['WRONG_STATUS']);
});

test('strict status codes make a positive test require 2xx', () => {
  const users = ops.getAllUsers;
  const positive = strict.makeCase(users, 'positive', 'positive');
  assert.deepEqual(labels(strict.check(users, positive, reply(403, { code: 'X', message: 'y' }) as never)), ['WRONG_STATUS']);
});

test('keys must be spelled as documented: total_pages vs totalPages is two problems', () => {
  const search = ops.findUser;
  const r = probe.check(search, probe.makeCase(search, 'p', 'positive'), reply(200, {
    users: [{ username: 'u', roles: ['user'] }], total: 2, totalPages: 1,
    pageInfo: { page: 0, totalItems: 2 }, message: 'ok',
  }) as never);
  assert.deepEqual(labels(r).sort(), ['MISSING_KEY', 'MISSING_KEY', 'UNDOCUMENTED_KEY', 'UNDOCUMENTED_KEY']);
});

test('a {code, message, data} envelope is compared inside data', () => {
  const dash = ops.getDashboardMetrics;
  const docSchema = dash.responses['200'].content['application/json'];
  const inner = spec.sample(docSchema);
  const r = probe.check(dash, probe.makeCase(dash, 'p', 'positive'),
    reply(200, { code: 200, message: 'ok', data: { ...inner, extra: 1 } }) as never);
  assert.deepEqual(r.issues.map(i => i[1]), ["data: key 'extra' is not in the document (e.g. 1)"]);
  assert.ok(r.info.includes('envelope'), r.info);
});

test('zip counts as the documented octet-stream', () => {
  const exp = ops.exportCellStatistics;
  const zipped = reply(200, 'PK', 'application/zip');
  assert.deepEqual(probe.check(exp, probe.makeCase(exp, 'p', 'positive'), zipped as never).issues, []);
});

test('GET /testcases checks the first executed and the first not-executed case', () => {
  const executed = {
    id: 'e1', name: 'ran', description: 'd',
    metadata: {
      createdOn: 't', lastModifiedOn: 't', lastExecutedOn: 't',
      lastExecution: { executionId: 'x1', simulatorName: 's', simulatorId: 58, result: 'PASS', status: 'COMPLETED', executedOn: 't', durationSeconds: 33, testDuration: 33 },
      executionHistory: [{ status: 'Completed', simulatorName: 's', startTime: 'a', endTime: 'b', startTimeUnix: 1, endTimeUnix: 2, iterationId: 'x1', execution_result: 'PASS', durationSec: 33 }],
    },
  };
  const fresh = { id: 'n1', name: 'never', metadata: { createdOn: 't', lastModifiedOn: 't' } };
  const listing = ops.getAllTestCases;
  const r = probe.check(listing, probe.makeCase(listing, 'p', 'positive'),
    reply(200, { items: [fresh, executed, executed], total: 3 }) as never);
  assert.ok(r.info.includes('executed test case'), r.info);
  assert.ok(r.info.includes('not-executed test case'), r.info);
  // Three items, two sampled: the rest are reported as unchecked.
  assert.ok(/other 1 test case\(s\)/.test(r.info), r.info);
});

// ------------------------------------------------------------- ordering --

test('the run order is the one the README documents', () => {
  const order = [...spec.ops].sort((a, b) => testplan.compareOrder(testplan.orderKey(a), testplan.orderKey(b)));
  const sections: string[] = [];
  for (const o of order) if (!sections.includes(o.section)) sections.push(o.section);
  // version first, authentication's logout last, deletes in the clean-up phase.
  assert.equal(order[0].id, 'getVersion');
  assert.equal(order[order.length - 1].id, 'logoutUser');
  const firstDelete = order.findIndex(o => o.method === 'delete');
  const lastNonDelete = order.map(o => o.method !== 'delete').lastIndexOf(true);
  assert.ok(firstDelete > 0 && firstDelete < order.length);
  assert.ok(order.slice(firstDelete, lastNonDelete).every(o => o.method === 'delete' || o.id === 'getJobById'),
    'only deletes (and the job lookup that needs one) belong in the clean-up phase');
});

test('the full suite runs each section as the role the plan gives it', () => {
  assert.equal(testplan.suiteRole(ops.getAllUsers), 'admin');
  assert.equal(testplan.suiteRole(ops.getAllTestCases), 'user');
  // update-password is the temporary user's own action, never the admin's.
  assert.equal(testplan.suiteRole(ops.updateUserPassword), 'temp');
});

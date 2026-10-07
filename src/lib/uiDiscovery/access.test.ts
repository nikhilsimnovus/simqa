// Role-based access is a security claim, so the comparison that produces it
// has to be conservative about what it is willing to assert.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pagesOnlyOthersHave, accessChecks } = await import('./access.ts');

const page = (id: string, path: string[], url?: string, over: any = {}) => ({
  id, kind: over.kind ?? 'page', path, label: path[path.length - 1],
  url, reach: url ? { via: 'url', url } : { via: 'click', selector: 'x', fromUrl: 'y' },
  elements: [], ...over,
});

const admin: any = {
  host: '192.168.1.102', username: 'admin', discoveredAt: '2026-10-07T00:00:00.000Z',
  nodes: [
    page('home', ['Home'], 'http://192.168.1.102/tools'),
    page('users', ['Users'], 'http://192.168.1.102/users'),
    page('users/create-user', ['Users', 'Create User'], undefined, { kind: 'section' }),
  ],
};
const simuser: any = {
  host: '192.168.1.102', username: 'simuser', discoveredAt: '2026-10-07T00:00:00.000Z',
  nodes: [page('home', ['Home'], 'http://192.168.1.102/dashboard')],
};

test('a page only the other login has, reachable by URL, is worth asking for', () => {
  const found = pagesOnlyOthersHave(simuser, [{ username: 'admin', map: admin }]);
  assert.deepEqual(found.map(f => f.url), ['http://192.168.1.102/tools', 'http://192.168.1.102/users']);
  assert.equal(found[0].heldBy, 'admin');
});

test('a dialog is not a page — it has no URL of its own to request', () => {
  const found = pagesOnlyOthersHave(simuser, [{ username: 'admin', map: admin }]);
  assert.ok(!found.some(f => f.page.includes('Create User')));
});

test('a page both logins have is not an access question', () => {
  const both: any = { ...simuser, nodes: [...simuser.nodes, page('users', ['Users'], 'http://192.168.1.102/users')] };
  const found = pagesOnlyOthersHave(both, [{ username: 'admin', map: admin }]);
  assert.deepEqual(found.map(f => f.url), ['http://192.168.1.102/tools']);
});

test('comparing a login against itself asks nothing', () => {
  assert.deepEqual(pagesOnlyOthersHave(admin, [{ username: 'admin', map: admin }]), []);
});

test('the check names both readings, because a missing page can be an unfinished crawl', () => {
  const [c] = accessChecks(simuser, [{ username: 'admin', map: admin }]);
  assert.equal(c.section, 'Access');
  assert.equal(c.element, 'admin');
  assert.match(c.test, /as simuser/);
  assert.match(c.expected, /refuses it or sends simuser elsewhere/);
});

test('with no other login on the box there is nothing to compare', () => {
  assert.deepEqual(accessChecks(simuser, []), []);
});

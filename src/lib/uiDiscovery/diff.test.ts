// Build-awareness: the scenario in the requirement is a build that adds SDR
// Management beside Stable / Unstable / Container Hosts, and it has to be
// noticed without anyone writing an SDR Management test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { diffMaps, diffIsEmpty, describeDiff } = await import('./diff.ts');

const page = (id: string, path: string[], elements: any[] = [], parentId?: string) => ({
  id, kind: 'page', path, label: path[path.length - 1],
  reach: { via: 'url', url: 'http://192.168.1.102/x' },
  parentId, elements,
});
const el = (key: string, kind: string, label: string, over: any = {}) =>
  ({ key, kind, label, selector: `[x=${key}]`, risk: 'read', ...over });

const BASE: any = {
  host: '192.168.1.102', build: 'A', discoveredAt: '2026-09-01T00:00:00.000Z',
  nodes: [
    page('tools/sim-mgmt', ['Tools', 'Simnovator Management']),
    page('tools/sim-mgmt/stable', ['Tools', 'Simnovator Management', 'Stable'], [
      el('table:#0', 'table', 'Stable', { columns: ['Name', 'Version'] }),
      el('button:add', 'button', 'Add', { risk: 'open' }),
      el('select:host', 'select', 'Host', { options: ['h1', 'h2'] }),
    ], 'tools/sim-mgmt'),
  ],
};

test('a new page is reported as new', () => {
  const next: any = {
    ...BASE, build: 'B', discoveredAt: '2026-10-06T00:00:00.000Z',
    nodes: [...BASE.nodes, page('tools/sim-mgmt/sdr-management',
      ['Tools', 'Simnovator Management', 'SDR Management'], [], 'tools/sim-mgmt')],
  };
  const d = diffMaps(BASE, next);
  assert.deepEqual(d.addedPages.map(p => p.page), ['Tools → Simnovator Management → SDR Management']);
  assert.equal(d.previousBuild, 'A');
  assert.equal(d.currentBuild, 'B');
  assert.ok(!diffIsEmpty(d));
  assert.match(describeDiff(d), /1 new page/);
});

test('a page that keeps its controls under a new name is a rename, not a churn of two', () => {
  const next: any = {
    ...BASE, build: 'B',
    nodes: [
      BASE.nodes[0],
      page('tools/sim-mgmt/stable-builds', ['Tools', 'Simnovator Management', 'Stable Builds'],
        BASE.nodes[1].elements, 'tools/sim-mgmt'),
    ],
  };
  const d = diffMaps(BASE, next);
  assert.equal(d.renamedPages.length, 1);
  assert.match(d.renamedPages[0].from, /Stable$/);
  assert.match(d.renamedPages[0].to, /Stable Builds$/);
  assert.deepEqual(d.addedPages, []);
  assert.deepEqual(d.removedPages, []);
});

test('two unrelated pages are not mistaken for a rename', () => {
  const next: any = {
    ...BASE, build: 'B',
    nodes: [BASE.nodes[0], page('tools/sim-mgmt/container-hosts',
      ['Tools', 'Simnovator Management', 'Container Hosts'],
      [el('table:#0', 'table', 'Hosts', { columns: ['Host', 'Containers'] })], 'tools/sim-mgmt')],
  };
  const d = diffMaps(BASE, next);
  assert.equal(d.renamedPages.length, 0);
  assert.equal(d.addedPages.length, 1);
  assert.equal(d.removedPages.length, 1);
});

test('a removed page is reported so its checks stop being expected', () => {
  const next: any = { ...BASE, build: 'B', nodes: [BASE.nodes[0]] };
  const d = diffMaps(BASE, next);
  assert.deepEqual(d.removedPages.map(p => p.id), ['tools/sim-mgmt/stable']);
});

test('fields and buttons appearing, disappearing and changing are all named', () => {
  const next: any = {
    ...BASE, build: 'B',
    nodes: [
      BASE.nodes[0],
      page('tools/sim-mgmt/stable', ['Tools', 'Simnovator Management', 'Stable'], [
        el('table:#0', 'table', 'Stable', { columns: ['Name', 'Version', 'Owner'] }),
        el('select:host', 'select', 'Host', { options: ['h1', 'h2', 'h3'] }),
        el('input:label', 'input', 'Label', { required: true }),
      ], 'tools/sim-mgmt'),
    ],
  };
  const d = diffMaps(BASE, next);
  assert.deepEqual(d.addedElements.map(e => e.element), ['Label']);
  assert.deepEqual(d.removedElements.map(e => e.element), ['Add']);
  const what = d.changedElements.map(c => `${c.element}: ${c.what}`).join(' | ');
  assert.match(what, /Stable: columns "Name,Version" → "Name,Version,Owner"/);
  assert.match(what, /Host: options 2 → 3/);
});

test('a disabled control that used to be clickable is a change worth saying out loud', () => {
  const next: any = {
    ...BASE, build: 'B',
    nodes: [BASE.nodes[0], page('tools/sim-mgmt/stable', BASE.nodes[1].path, [
      el('table:#0', 'table', 'Stable', { columns: ['Name', 'Version'] }),
      el('button:add', 'button', 'Add', { risk: 'open', disabled: true }),
      el('select:host', 'select', 'Host', { options: ['h1', 'h2'] }),
    ], 'tools/sim-mgmt')],
  };
  const d = diffMaps(BASE, next);
  assert.equal(d.changedElements.length, 1);
  assert.match(d.changedElements[0].what, /now disabled/);
});

test('the first discovery on a setup has nothing to compare against', () => {
  const d = diffMaps(undefined, BASE);
  assert.ok(diffIsEmpty(d));
  assert.equal(describeDiff(d), 'No UI changes since the last discovery.');
});

// The plan is what makes the module dynamic, so the tests use the page the
// requirement names — Tools → Simnovator Management → Manage Simulators with
// its Stable / Unstable / Container Hosts tabs — and assert that the checks
// come from the map rather than from anything written down here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checksFromMap, planSummary } = await import('./plan.ts');

const node = (over: any) => ({
  id: over.id,
  kind: over.kind ?? 'page',
  path: over.path,
  label: over.path[over.path.length - 1],
  url: over.url,
  parentId: over.parentId,
  reach: over.reach ?? { via: 'url', url: over.url ?? 'http://192.168.1.102/tools' },
  elements: over.elements ?? [],
  apiCalls: over.apiCalls,
  unreachable: over.unreachable,
});

const el = (over: any) => ({
  key: over.key,
  kind: over.kind,
  label: over.label ?? '',
  selector: over.selector ?? `[data-x="${over.key}"]`,
  risk: over.risk ?? 'read',
  disabled: over.disabled,
  required: over.required,
  options: over.options,
  columns: over.columns,
  rowCount: over.rowCount,
});

const MAP: any = {
  host: '192.168.1.102',
  build: '4.1.0-qadrop.3',
  discoveredAt: '2026-10-06T10:00:00.000Z',
  nodes: [
    node({
      id: 'tools/simnovator-management/manage-simulators',
      path: ['Tools', 'Simnovator Management', 'Manage Simulators'],
      url: 'http://192.168.1.102/tools/simulator-management',
      apiCalls: [{ method: 'GET', url: '/v2/simulators', status: 200 }],
      elements: [
        el({ key: 'table:#0', kind: 'table', label: 'Simulators', columns: ['Name', 'Status', 'Host'], rowCount: 4 }),
        el({ key: 'search:search', kind: 'search', label: 'Search' }),
        el({ key: 'button:add-simulator', kind: 'button', label: 'Add Simulator', risk: 'open' }),
        el({ key: 'button:delete', kind: 'button', label: 'Delete', risk: 'mutate' }),
        el({ key: 'select:host', kind: 'select', label: 'Container Host', options: ['host-1', 'host-2'] }),
        el({ key: 'input:name', kind: 'input', label: 'Name', required: true }),
      ],
    }),
    node({
      id: 'tools/simnovator-management/manage-simulators/stable',
      kind: 'tab',
      path: ['Tools', 'Simnovator Management', 'Manage Simulators', 'Stable'],
      parentId: 'tools/simnovator-management/manage-simulators',
      reach: { via: 'click', selector: 'role=tab[name="Stable"]', fromUrl: 'http://192.168.1.102/tools/simulator-management' },
      elements: [el({ key: 'table:#0', kind: 'table', label: 'Stable', columns: ['Name', 'Version'], rowCount: 2 })],
    }),
  ],
};

test('every discovered page gets its own load, console and API checks', () => {
  const checks = checksFromMap(MAP);
  const forPage = checks.filter(c => c.nodeId === 'tools/simnovator-management/manage-simulators');
  const kinds = forPage.map(c => c.kind);
  assert.ok(kinds.includes('page-loads'));
  assert.ok(kinds.includes('page-no-console-errors'));
  assert.ok(kinds.includes('page-api-ok'));
  // The breadcrumb the operator reads, and the menu it hangs under.
  assert.equal(forPage[0].page, 'Tools → Simnovator Management → Manage Simulators');
  assert.equal(forPage[0].section, 'Tools');
});

test('a tab is validated as a tab, not just as a page', () => {
  const checks = checksFromMap(MAP);
  const tab = checks.filter(c => c.nodeId.endsWith('/stable'));
  assert.ok(tab.some(c => c.kind === 'tab-switches'));
  assert.ok(tab.some(c => c.kind === 'page-loads' && c.test.includes('"Stable" tab')));
});

test('each kind of control brings the checks that suit it', () => {
  const kinds = new Set(checksFromMap(MAP).map(c => c.kind));
  for (const k of ['table-headers', 'table-rows-or-empty-state', 'sort-reorders',
                   'search-filters', 'select-has-options', 'select-options-unique',
                   'field-labelled', 'dialog-opens-and-cancels', 'element-present',
                   'element-enabled']) {
    assert.ok(kinds.has(k as any), k);
  }
});

test('a safe button is pressed to see whether it does anything', () => {
  const checks = checksFromMap(MAP);
  const responds = checks.filter(c => c.kind === 'button-responds');
  // The search box and the table are not buttons; Add opens a form and has
  // its own check; Delete is never pressed at all.
  assert.deepEqual(responds.map(c => c.element), []);

  // A plain button with a harmless label is the case this is for.
  const withPlain: any = { ...MAP, nodes: [{ ...MAP.nodes[0], elements: [
    ...MAP.nodes[0].elements,
    el({ key: 'button:refresh-list', kind: 'button', label: 'Refresh List', risk: 'read' }),
    el({ key: 'button:disabled-one', kind: 'button', label: 'Preview', risk: 'read', disabled: true }),
  ] }] };
  const now = checksFromMap(withPlain).filter(c => c.kind === 'button-responds');
  assert.deepEqual(now.map(c => c.element), ['Refresh List']);
  assert.match(now[0].expected, /does nothing is a broken one/);
  assert.equal(checksFromMap(withPlain, { exerciseButtons: false }).filter(c => c.kind === 'button-responds').length, 0);
});

test('a destructive action is reported, never pressed', () => {
  const checks = checksFromMap(MAP);
  const del = checks.filter(c => c.element === 'Delete');
  assert.ok(del.length > 0);
  const action = del.find(c => c.notApplicable);
  assert.ok(action, 'Delete should produce a not-operated row');
  assert.match(action!.notApplicable!, /not operated/);
  // …and nothing in the plan tries to click it.
  assert.ok(!del.some(c => /click/i.test(c.test) && !c.notApplicable));
});

test('mandatory-field probing is off unless asked for', () => {
  const off = checksFromMap(MAP).find(c => c.kind === 'required-field-blocks-submit');
  assert.ok(off?.notApplicable, 'should be planned but not performed');
  const on = checksFromMap(MAP, { probeRequiredFields: true }).find(c => c.kind === 'required-field-blocks-submit');
  assert.equal(on?.notApplicable, undefined);
});

test('the application-level checks are planned once', () => {
  const app = checksFromMap(MAP).filter(c => c.section === 'Application');
  assert.deepEqual(app.map(c => c.kind).sort(),
    ['back-forward-nav', 'refresh-keeps-page', 'session-protected']);
});

test('a page the crawler could not open contributes a failing load check and nothing else', () => {
  const broken: any = {
    ...MAP,
    nodes: [node({
      id: 'tools/broken', path: ['Tools', 'Broken'], url: 'http://x/broken',
      unreachable: 'clicked the menu entry, nothing rendered within 20s',
      elements: [el({ key: 'button:add', kind: 'button', label: 'Add', risk: 'open' })],
    })],
  };
  const checks = checksFromMap(broken);
  assert.ok(checks.some(c => c.kind === 'page-loads'));
  assert.ok(!checks.some(c => c.element === 'Add'));
});

test('a new page in the map plans checks with no code change', () => {
  const grown: any = { ...MAP, nodes: [...MAP.nodes, node({
    id: 'tools/simnovator-management/sdr-management',
    path: ['Tools', 'Simnovator Management', 'SDR Management'],
    url: 'http://192.168.1.102/tools/sdr',
    elements: [el({ key: 'table:#0', kind: 'table', label: 'SDRs', columns: ['SDR', 'State'], rowCount: 1 })],
  })] };
  const before = checksFromMap(MAP).length;
  const after = checksFromMap(grown);
  assert.ok(after.length > before);
  assert.ok(after.some(c => c.page.includes('SDR Management')));
});

test('ids are unique and the plan can be capped', () => {
  const checks = checksFromMap(MAP);
  assert.equal(new Set(checks.map(c => c.id)).size, checks.length);
  assert.equal(checksFromMap(MAP, { maxChecks: 5 }).length, 5);
});

test('the summary separates what will run from what will not', () => {
  const s = planSummary(checksFromMap(MAP));
  assert.equal(s.total, s.willRun + s.notApplicable);
  assert.ok(s.notApplicable >= 2);  // Delete, and the mandatory-field probe
  assert.equal(s.bySection[0].section, 'Tools');
});

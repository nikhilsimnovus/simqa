// Simnovator-specific wiring: run order, default inputs, ID chaining and the
// delete-safety rule.
//
// Everything generic — spec parsing, validation, negative cases — lives
// elsewhere. This is the file to edit when the API gains new resources or the
// run order needs to change, and it is kept deliberately close to the
// testplan.py it was ported from so that the two can be compared line by line.

import type { Json, Spec, SpecOp } from './spec.ts';

/** Values the tool fills in itself, never "needed" from another API. */
export const BUILTIN_VARS = new Set(['run', 'nowMs', 'loginUsername', 'loginPassword']);

/** Bodies are compared with the document by keys only; values are never
 *  judged. These sections additionally check each field's JSON type. */
export const TYPED_SECTIONS = new Set(['test-creation']);

/** Test-case lists hold hundreds of items: only the first executed and the
 *  first not-executed test case are checked in detail. */
export const TESTCASE_LISTS = new Set(['getAllTestCases', 'searchTestCases']);

/** Sections run in this order so resources exist before they are used. */
export const SECTION_ORDER = [
  'version', 'authentication', 'user-management', 'simulators', 'hosts', 'system', 'tools',
  'saved-filters', 'test-creation', 'test-cases', 'test-executions', 'statistics', 'logs', 'jobs',
];

/** Inside a section: these create a resource, so they run first. */
export const CREATORS = new Set([
  'createUser', 'createSimulator', 'createLogSetting', 'createSuccessSetting',
  'createSavedFilter', 'createNetworkTopologyDiagram', 'createCellConfig', 'startTestExecution',
]);

/** Execution flow: start → restart → stop → logs. */
export const FLOW: Record<string, number> = {
  startTestExecution: 0, restartTestExecution: 1, stopTestExecution: 2, getExecutionLogs: 3,
};

/** Before a start, wait until the test case is idle and its simulator AVAILABLE. */
export const WAIT_READY = new Set(['startTestExecution']);
/** Restart hits the running execution: let the started test run this long first. */
export const RESTART_DELAY = 4;
export const READY_POLL = 5;
export const READY_TIMEOUT = 180;
export const BUSY_STATES = new Set(['IN_PROGRESS', 'RUNNING', 'STARTING', 'STOPPING', 'PENDING', 'QUEUED', 'RESTARTING']);
/** Starting an execution took ~28 s on real hardware. */
export const SLOW_OPS = new Set(['startTestExecution', 'stopTestExecution', 'restartTestExecution']);
export const SLOW_TIMEOUT = 180;
/** Their negative tests run before the real call, while the simulator is free. */
export const NEGATIVES_FIRST = new Set(['startTestExecution']);

/** Test-creation flow: build one test case, read every part back, update every part. */
export const CREATION_FLOW: Record<string, number> = {
  createCellConfig: 0, createSubscriberConfig: 1, createUserPlaneConfig: 2, createPowerCycleConfig: 3,
  createMobilityConfig: 4, createSettingsConfig: 5,
  getCellConfig: 10, getSubscriberConfig: 11, getUserPlaneConfig: 12, getPowerCycleConfig: 13,
  getMobilityConfig: 14, getSettingsConfig: 15,
  updateCellConfig: 20, updateSubscriberConfig: 21, updateUserPlaneConfig: 22, updatePowerCycleConfig: 23,
  updateMobilityConfig: 24, updateSettingsConfig: 25,
};

/** Default example per API (one RAT for the whole test case). */
export const PREFERRED_EXAMPLE: Record<string, string> = {
  createCellConfig: 'SA-UE', updateCellConfig: 'SA-UE',
  createSubscriberConfig: 'SA', updateSubscriberConfig: 'SA',
};
/** Subscribers follow the RAT of the cells example chosen for POST /tests/cells. */
export const SUBSCRIBERS_FOR_CELLS: Record<string, string> = {
  'SA-UE': 'SA', 'SA-ORU': 'SA', LTE: 'LTE', NSA: 'NSA', NBIOT: 'NBIOT', MULTIRAT: 'MULTIRAT',
};
export const FOLLOWS_CELLS = new Set(['updateCellConfig', 'createSubscriberConfig', 'updateSubscriberConfig']);
/** Mobility needs channel simulation: skipped when the cells body sent has channelSim false. */
export const MOBILITY_OPS = new Set(['createMobilityConfig', 'getMobilityConfig', 'updateMobilityConfig']);
/** Sub-configuration POSTs: the real one first, so an invalid variant the
 *  server wrongly accepts cannot take its place. */
export const POSITIVE_FIRST = new Set([
  'createSubscriberConfig', 'createUserPlaneConfig', 'createPowerCycleConfig', 'createMobilityConfig',
  'createSettingsConfig',
]);

/** User-management flow; the user is deleted last, in the clean-up phase. */
export const USER_FLOW: Record<string, number> = {
  getUserProfile: 0, getAllUsers: 1, createUser: 2, findUser: 3, resetUserPassword: 4,
  updateUserProfile: 5, updateUserPassword: 6,
};
/** Self-service APIs: skipped when the run is logged in as an admin. */
export const USER_ONLY = new Set(['updateUserPassword']);

/** Clean-up phase, after every other API. */
export const CLEANUP_ORDER = [
  'deleteTestCases', 'purgeTestCaseHistory', 'getJobById', 'deleteTestCase',
  'revokeUserAccess', 'deleteSimulator', 'deleteUser', 'deleteLogSetting',
  'deleteSuccessSetting', 'deleteSavedFilter', 'deleteNetworkTopologyDiagram',
];

// ---------- Full API suite ----------

export const SUITE: Array<[section: string, role: string]> = [
  ['version', 'admin'], ['authentication', 'admin'], ['tools', 'admin'], ['user-management', 'admin'],
  ['hosts', 'admin'], ['system', 'user'], ['test-creation', 'user'], ['test-cases', 'user'],
  ['simulators', 'admin'], ['test-executions', 'user'], ['statistics', 'user'], ['logs', 'user'],
  ['saved-filters', 'user'], ['jobs', 'admin'],
];
/** update-password is a user's own action: the temporary user performs it on
 *  its own account, so the suite's real login is never changed. */
export const SUITE_ROLE_OVERRIDES: Record<string, string> = { updateUserPassword: 'temp' };
export const SUITE_DEFAULT_LOGINS: Record<string, [string, string]> = {
  admin: ['admin', 'admin'], user: ['simuser', 'simuser'],
};
/** After every other API; only logout follows. */
export const SUITE_LAST = ['deleteSimulator'];
/** PUT the simulator's log settings needs a running execution. */
export const SUITE_MOVE: Record<string, [string, number]> = {
  applyLogSettingToSimulator: ['test-executions', FLOW.startTestExecution + 0.5],
};
/** Suite inputs that replace the usual shared value. */
export const SUITE_PARAM_VAR: Record<string, string> = {
  'getLogSettingById|id': 'firstLogSettingId',
  'updateLogSetting|id': 'firstLogSettingId',
  'getTestCaseDetails|testCaseId': 'completedTestCaseId',
  'applyLogSettingToSimulator|simulatorId': 'execSimulatorId',
};
export const COMPLETED_EXECUTION_SECTIONS = new Set(['statistics', 'logs']);
export const SUITE_BODY_DEFAULTS: Record<string, Json> = {
  exportTestCases: { testCaseIds: ['{{completedTestCaseId}}'] },
  applyLogSettingToSimulator: { logSettingsId: '4' },
};
/** Run on IDs the run did not create, safely. */
export const SUITE_TRUSTED = new Set(['updateLogSetting', 'applyLogSettingToSimulator']);
/** Only ever on what this run created, even with the safety check off. */
export const SUITE_OWN_ONLY = new Set(['deleteLogSetting']);
export const SUITE_NEEDS: Record<string, string> = {
  firstLogSettingId: 'a log setting from GET /system/log-settings (the list was empty or not read)',
  completedTestCaseId: 'a test case with an execution of status “Completed” and execution_result “PASS” in GET /testcases (none found)',
  completedExecutionId: 'an execution with status “Completed” and execution_result “PASS” in GET /testcases (none found)',
  execSimulatorId: 'a running execution (POST /testcases/{testCaseId}/executions did not start one)',
};

/** First (test case, executionHistory entry) whose execution is Completed + PASS. */
export function completedPass(items: Json): [Json, Json] {
  for (const t of Array.isArray(items) ? items : []) {
    const history = (t && typeof t === 'object' ? t.metadata?.executionHistory : null) ?? [];
    for (const run of Array.isArray(history) ? history : []) {
      if (run && typeof run === 'object'
        && String(run.status).toLowerCase() === 'completed'
        && String(run.execution_result).toUpperCase() === 'PASS') {
        return [t, run];
      }
    }
  }
  return [null, null];
}

export function suiteParamVar(op: SpecOp, name: string): string | undefined {
  if (name === 'executionId' && COMPLETED_EXECUTION_SECTIONS.has(op.section)) return 'completedExecutionId';
  return SUITE_PARAM_VAR[`${op.id}|${name}`];
}

export function suiteRole(op: SpecOp): string {
  return SUITE_ROLE_OVERRIDES[op.id] ?? (SUITE.find(([s]) => s === op.section)?.[1] ?? 'admin');
}

/** Sort key deciding when an operation runs. Compared element by element. */
export function orderKey(op: SpecOp, suite = false): number[] {
  if (op.id === 'logoutUser') return [4];
  if (suite && SUITE_LAST.includes(op.id)) return [3, SUITE_LAST.indexOf(op.id)];
  if (suite && SUITE_MOVE[op.id]) {
    const [section, rank] = SUITE_MOVE[op.id];
    return [1, SUITE.findIndex(([name]) => name === section), rank, op.index];
  }
  if (CLEANUP_ORDER.includes(op.id)) return [2, CLEANUP_ORDER.indexOf(op.id)];
  if (op.method === 'delete') return [2, CLEANUP_ORDER.length, op.index];
  const order = suite ? SUITE.map(([name]) => name) : SECTION_ORDER;
  const section = order.indexOf(op.section) >= 0 ? order.indexOf(op.section) : order.length;
  const rank = FLOW[op.id] ?? CREATION_FLOW[op.id] ?? USER_FLOW[op.id] ?? (CREATORS.has(op.id) ? 0 : 1);
  return [1, section, rank, op.index];
}

export function compareOrder(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -Infinity;
    const y = b[i] ?? -Infinity;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Shared value feeding each ID parameter; unlisted parameters use their own name. */
export const PARAM_VAR: Record<string, string> = {
  '/system/log-settings/{id}|id': 'logSettingId',
  '/system/success-settings/{id}|id': 'successSettingId',
  '/api/jobs/{id}|id': 'jobId',
  '/tools/network-topology/diagrams|id': 'diagramId',
};
export const ID_QUERY_PARAMS = new Set(['id', 'filter_id']);

/** Default input tweaks on top of the documented examples. {{run}} makes names
 *  unique per run, so a run never collides with an existing resource and
 *  clean-up only ever touches its own. null removes an optional field. */
export const BODY_DEFAULTS: Record<string, Json> = {
  loginUser: { username: '{{loginUsername}}', password: '{{loginPassword}}' },
  createUser: { username: 'sat_{{run}}', password: 'Sat@{{run}}1', email: 'sat_{{run}}@example.com', role: 'user' },
  updateUserPassword: { username: '{{username}}', current_password: '{{userPassword}}', new_password: 'Sat@{{run}}3' },
  resetUserPassword: { new_password: 'Sat@{{run}}2' },
  updateUserProfile: { email: 'sat_{{run}}@example.com' },
  findUser: {},
  createSimulator: { simulatorName: 'SAT-Sim-{{run}}' },
  updateSimulator: { simulatorName: 'SAT-Sim-{{run}}-upd' },
  createLogSetting: { name: 'sat_{{run}}' },
  updateLogSetting: { name: 'sat_{{run}}_u' },
  createSuccessSetting: { name: 'sat_{{run}}', isDefault: false },
  updateSuccessSetting: { name: 'sat_{{run}}_u', isDefault: false },
  applyLogSettingToSimulator: { logSettingsId: '{{logSettingId}}' },
  createSavedFilter: { filter_id: 'sat-filter-{{run}}', name: 'SAT {{run}}' },
  updateSavedFilter: { filter_id: '{{filter_id}}', name: 'SAT {{run}} upd' },
  createNetworkTopologyDiagram: { name: 'SAT-{{run}}' },
  updateNetworkTopologyDiagram: { id: '{{diagramId}}', name: 'SAT-{{run}}-upd' },
  exportTestCases: { testCaseIds: ['{{testCaseId}}'], output: { type: 'json' } },
  createSettingsConfig: { settings: { loggingProfileName: 'debug', successCriteriaName: 'Attach Success', testCaseName: '{{loginUsername}}_{{run}}_automation' } },
  updateSettingsConfig: { settings: { loggingProfileName: 'debug', successCriteriaName: 'Attach Success', testCaseName: '{{loginUsername}}_{{run}}_automation_updated' } },
  deleteTestCases: { scope: 'multiple', testCaseIds: ['{{importedTestCaseId}}'], filter: null },
  startTestExecution: { simulatorId: null },
  restartTestExecution: { simulatorId: null },
};
/** A UE simulator refuses ORU (M-Plane) log settings with 400. */
export const BODY_REMOVE: Record<string, Array<[string, string]>> = {
  createLogSetting: [['layers', 'ORU']],
  updateLogSetting: [['layers', 'ORU']],
};
export const PARAM_DEFAULTS: Record<string, string> = {
  startTime: '0', endTime: '{{nowMs}}', cell: '1', ueId: '1',
};

type Capture = (req: Json, res: Json, v: Record<string, Json>) => Json;

/** What each successful call hands to later calls. A capture that throws is
 *  treated as "nothing to capture", exactly as the Python version's try/except. */
export const CAPTURES: Record<string, Record<string, Capture>> = {
  getVersion: { serverVersion: (req, res) => res.simnovator.version },
  loginUser: { accessToken: (req, res) => res.access_token },
  createUser: {
    username: (req) => req.username,
    userPassword: (req) => req?.password ?? 'simnovus',
  },
  resetUserPassword: { userPassword: (req) => (req ?? {}).new_password ?? 'simnovus' },
  updateUserPassword: { userPassword: (req) => req.new_password },
  createSimulator: { simulatorName: (req) => req.simulatorName },
  // POST /simulators returns no ID, so the new simulator is looked up by its unique name.
  getAllSimulators: {
    simulatorId: (req, res, v) => ('simulatorName' in v
      ? res.items.find((s: Json) => s.name === v.simulatorName)!.id
      : null),
  },
  updateSimulator: { simulatorName: (req, res, v) => (req ?? {}).simulatorName ?? v.simulatorName },
  createLogSetting: { logSettingId: (req, res) => res.id },
  listLogSettings: {
    firstLogSettingId: (req, res) => (res.items?.length ? res.items[0].id : null),
    firstLogSetting: (req, res) => (res.items?.length ? res.items[0] : null),
  },
  getAllTestCases: {
    completedTestCaseId: (req, res) => (completedPass(res.items)[0] ?? {}).id,
    completedExecutionId: (req, res) => (completedPass(res.items)[1] ?? {}).iterationId,
  },
  createSuccessSetting: { successSettingId: (req, res) => res.id },
  createSavedFilter: { filter_id: (req, res) => res.filter_id },
  createNetworkTopologyDiagram: { diagramId: (req, res) => res.id },
  createCellConfig: { testCaseId: (req, res) => res.testCaseId },
  // Re-used as the import file; a JSON export arrives parsed, so it goes back to bytes.
  exportTestCases: {
    exportFile: (req, res) => (res instanceof Uint8Array ? res : Buffer.from(JSON.stringify(res), 'utf8')),
  },
  importTestCases: { importedTestCaseId: (req, res) => res.testCases[0].id },
  startTestExecution: { executionId: (req, res) => res.executionId },
  restartTestExecution: { executionId: (req, res) => res.executionId },
  // An existing job, so GET /api/jobs/{id} runs without a purge; a later purge overrides it.
  listJobs: { jobId: (req, res) => (res.jobs?.length ? res.jobs[0].id : null) },
  purgeTestCaseHistory: { jobId: (req, res, v) => v.jobId ?? res.jobId },
  // Hosts cannot be created through the API: take the first listed host.
  listHosts: { hostId: (req, res) => (res.hosts?.length ? res.hosts[0].id : null) },
};

/** Create API → the API that undoes it, for when a negative test is wrongly
 *  accepted and creates something extra. */
export const CLEANUP_FOR: Record<string, string> = {
  createUser: 'deleteUser', createLogSetting: 'deleteLogSetting', createSuccessSetting: 'deleteSuccessSetting',
  createSavedFilter: 'deleteSavedFilter', createNetworkTopologyDiagram: 'deleteNetworkTopologyDiagram',
  createCellConfig: 'deleteTestCase', startTestExecution: 'stopTestExecution',
};
/** Values that identify a resource this run created — the only things it may delete. */
export const RESOURCE_VARS = new Set([
  'username', 'simulatorId', 'logSettingId', 'successSettingId', 'filter_id', 'diagramId',
  'testCaseId', 'importedTestCaseId', 'executionId',
]);
/** Shared values offered in the UI, so a run can target existing resources. */
export const SHARED_VARS = [
  'testCaseId', 'executionId', 'simulatorId', 'username', 'logSettingId', 'successSettingId',
  'filter_id', 'diagramId', 'jobId', 'hostId',
];
/** Change real equipment the run cannot create: always skipped with the
 *  safety check on; with it off they run after the operator confirms. */
export const PROTECTED = new Set(['updateHost', 'deleteHost']);
/** A duplicate would really start a second execution or leave a second test case. */
export const NO_DUPLICATE_CHECK = new Set(['startTestExecution', 'createCellConfig']);

export function producerOf(varName: string): string | undefined {
  return Object.entries(CAPTURES).find(([, caps]) => varName in caps)?.[0];
}

export interface OpDefaults {
  params: Record<string, string>;
  bodies: Record<string, Json>;
}

/** Default inputs for an operation. */
export function defaults(spec: Spec, op: SpecOp, suite = false): OpDefaults {
  const params: Record<string, string> = {};
  for (const p of op.params) {
    const v = (suite ? suiteParamVar(op, p.name) : undefined)
      ?? PARAM_VAR[`${op.path}|${p.name}`]
      ?? p.name;
    if (p.in === 'path' || (ID_QUERY_PARAMS.has(p.name) && p.required)) {
      params[p.name] = `{{${v}}}`;
    } else if (p.name in PARAM_DEFAULTS) {
      params[p.name] = PARAM_DEFAULTS[p.name];
    } else if (p.required) {
      params[p.name] = String(spec.paramDefault(p));
    } else {
      params[p.name] = '';   // optional: not sent unless the operator fills it in
    }
  }
  const bodies: Record<string, Json> = {};
  if (op.body) {
    let examples = op.body.examples;
    const first = PREFERRED_EXAMPLE[op.id];
    if (first && first in examples) {
      // The preferred example becomes the default, shown first.
      examples = { [first]: examples[first], ...Object.fromEntries(Object.entries(examples).filter(([k]) => k !== first)) };
    }
    for (const [name, raw] of Object.entries(examples)) {
      let example = structuredClone(raw);
      if (example && typeof example === 'object' && !Array.isArray(example)) {
        for (const [outer, key] of BODY_REMOVE[op.id] ?? []) {
          if (example[outer] && typeof example[outer] === 'object') delete example[outer][key];
        }
        const tweaks = { ...(BODY_DEFAULTS[op.id] ?? {}), ...(suite ? SUITE_BODY_DEFAULTS[op.id] ?? {} : {}) };
        for (const [key, value] of Object.entries(tweaks)) {
          if (value === null) delete example[key];
          else example[key] = structuredClone(value);
        }
      }
      bodies[name] = example;
    }
    if (op.id === 'importTestCases') {
      return { params, bodies: { 'File exported earlier in this run': { file: '{{exportFile}}' } } };
    }
  }
  return { params, bodies };
}

/** Sections that contain a create API. Their update/delete APIs work on what
 *  that create made; DELETEs elsewhere are normal deletes on the given ID. */
export function sectionsWithCreate(spec: Spec): Set<string> {
  const out = new Set<string>();
  for (const c of CREATORS) {
    const op = spec.byId[c];
    if (op) out.add(op.section);
  }
  return out;
}

/** The safety check: PUT, PATCH, DELETE and password changes may only touch
 *  what this run created. Returns a reason, or undefined when it may proceed. */
export function guard(
  op: SpecOp,
  path: Record<string, Json>,
  query: Record<string, Json>,
  body: Json,
  allowed: Set<string>,
  ownOnly = true,
): string | undefined {
  const mutating = ['put', 'patch', 'delete'].includes(op.method)
    || op.id === 'resetUserPassword' || op.id === 'updateUserPassword' || PROTECTED.has(op.id);
  if (!mutating) return undefined;
  if (!ownOnly) return undefined;
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const targets: Json[] = [
    ...Object.values(path),
    ...Object.entries(query).filter(([k]) => ID_QUERY_PARAMS.has(k)).map(([, v]) => v),
  ];
  const extra: Record<string, Json[]> = {
    deleteTestCases: b.testCaseIds ?? [],
    updateUserPassword: 'username' in b ? [b.username] : [],
    updateNetworkTopologyDiagram: 'id' in b ? [b.id] : [],
  };
  targets.push(...(extra[op.id] ?? []));
  const foreign = targets.map(String).filter(t => !allowed.has(t));
  if (foreign.length) {
    return `safety: ${foreign.join(', ')} was not created by this run, so it is not modified/deleted`;
  }
  return undefined;
}

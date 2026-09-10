// The install checklist, and how to tick it from what the installer actually says.
//
// The old list described SimQA as a bystander — two of its steps were literally
// labelled "runs inside Cockpit — not visible to SimQA" — because at the time
// the operator pasted the commands into Cockpit themselves and all SimQA could
// do was watch the box drop off the network and come back. That is no longer
// true: SimQA drives the Cockpit terminal and sees every line, so each step can
// be ticked the moment its evidence appears.
//
// The markers below are taken verbatim from a real successful install of
// Simnovator-4.0.0_2609012008 on .102, not from documentation:
//
//   Welcome! Installing Simnovus UE Simulator (4.0.0_2609012008)
//   Step 1: Installing App server on 192.168.1.100
//   App Server Installed successfully!!
//   Step 2: Installing UE simulator on 192.168.1.101
//   UE Simulator installed successfully!!
//   Step 3: Installing Simnovator manager on 192.168.1.102
//   Simnovator Status: OK (12/12 containers running)
//
// IMPORTS: none. Pure, so it unit-tests under `node --test`.

export type InstallStepState = 'pending' | 'running' | 'done' | 'failed';

export interface InstallStepDef {
  id: string;
  label: string;
  /** What has to happen for the tick, in plain words, shown under the label. */
  evidence: string;
}

export const INSTALL_STEPS: InstallStepDef[] = [
  { id: 'download',   label: 'Build download',            evidence: 'wget finishes on the box' },
  { id: 'extract',    label: 'Build extraction',          evidence: 'tar -zxvf finishes' },
  { id: 'started',    label: 'Installation started',      evidence: './install begins running' },
  { id: 'app-server', label: 'App Server installation',   evidence: 'the installer reports the App Server installed' },
  { id: 'ue',         label: 'UE simulator installation', evidence: 'the installer reports the UE simulator installed' },
  { id: 'simnovator', label: 'Simnovator installation',   evidence: 'the installer moves on to the Simnovator' },
  { id: 'manager',    label: 'Installing Simnovator manager', evidence: 'the manager’s containers come up healthy' },
  { id: 'completed',  label: 'Installation completed',    evidence: './install exits, and the box reports the new build' },
];

/** One event off the installer stream. Shaped to match what /api/build-install
 *  emits, but kept loose so a new event field cannot break the ticking. */
export interface StreamEvent {
  type?: string;
  step?: string;
  status?: string;
  stream?: string;
  line?: string;
  ok?: boolean;
  /** Epoch ms. Every event the installer emits carries one; it is what tells a
   *  run restored from disk when it actually started. */
  ts?: number;
  durationMs?: number;
}

/** Ordered so an earlier step is implied complete once a later one starts —
 *  the installer never goes backwards. */
const ORDER = INSTALL_STEPS.map((s) => s.id);

/**
 * Which step a stdout line marks the COMPLETION of.
 *
 * Matched loosely on purpose: the Cockpit terminal wraps and re-emits lines, so
 * the same message arrives several times and sometimes concatenated with its
 * neighbours. Substring tests survive that; anchored regexes do not.
 */
function completionFor(line: string): string | undefined {
  const l = line.toLowerCase();
  if (l.includes('app server installed successfully')) return 'app-server';
  if (l.includes('ue simulator installed successfully')) return 'ue';
  if (l.includes('simnovator status') && l.includes('containers running')) return 'manager';
  return undefined;
}

/** Which step a stdout line marks the START of. */
function startFor(line: string): string | undefined {
  const l = line.toLowerCase();
  if (l.includes('welcome! installing')) return 'started';
  if (l.includes('installing app server on')) return 'app-server';
  if (l.includes('installing ue simulator on')) return 'ue';
  if (l.includes('installing simnovator manager on')) return 'simnovator';
  return undefined;
}

export interface StepStatus {
  state: InstallStepState;
  /** The line or event that decided it, so a tick is auditable. */
  because?: string;
}

/**
 * Fold the installer's event stream into a tick per step.
 *
 * `versionChanged` is the outside check — the box reporting a build different
 * from the one it had before. It is what finally ticks "Installation completed",
 * because the installer's own exit code is not sufficient evidence: a real run
 * exited 1 on a late App Server SSH key and had nonetheless installed the build.
 */
export function deriveInstallSteps(
  events: StreamEvent[],
  opts: { versionChanged?: boolean; finished?: boolean } = {},
): Record<string, StepStatus> {
  const out: Record<string, StepStatus> = {};
  for (const s of INSTALL_STEPS) out[s.id] = { state: 'pending' };

  const mark = (id: string, state: InstallStepState, because?: string) => {
    if (!out[id]) return;
    // Never walk a step backwards: once done, a later 'running' line for the
    // same step (the terminal re-emitting a wrapped line) must not un-tick it.
    if (out[id].state === 'done' && state === 'running') return;
    if (out[id].state === 'failed' && state !== 'done') return;
    out[id] = { state, because: because ?? out[id].because };
  };

  /** Everything before `id` is complete once `id` is reached. */
  const impliesEarlier = (id: string, because: string) => {
    const i = ORDER.indexOf(id);
    for (let k = 0; k < i; k++) if (out[ORDER[k]].state === 'pending' || out[ORDER[k]].state === 'running') {
      out[ORDER[k]] = { state: 'done', because: `implied by "${because}"` };
    }
  };

  let failed = false;

  for (const e of events) {
    if (e.type === 'step') {
      // The installer's own named phases cover the first three.
      const map: Record<string, string> = { fetch: 'download', extract: 'extract', install: 'started' };
      const id = e.step ? map[e.step] : undefined;
      if (id) {
        if (e.status === 'start') mark(id, 'running', `${e.step} started`);
        else if (e.status === 'ok') { mark(id, 'done', `${e.step} completed`); impliesEarlier(id, `${e.step} completed`); }
        else if (e.status === 'fail') { mark(id, 'failed', `${e.step} failed`); failed = true; }
      }
      continue;
    }

    if (e.type === 'done') {
      if (!e.ok) failed = true;
      continue;
    }

    const line = String(e.line ?? '');
    if (!line) continue;

    const started = startFor(line);
    if (started) { mark(started, 'running', line.slice(0, 120)); impliesEarlier(started, line.slice(0, 80)); }

    const completed = completionFor(line);
    if (completed) { mark(completed, 'done', line.slice(0, 120)); impliesEarlier(completed, line.slice(0, 80)); }
  }

  // "Installation completed" is decided by the box, not by the exit code.
  if (opts.versionChanged) {
    out.completed = { state: 'done', because: 'the box came back reporting the new build' };
    impliesEarlier('completed', 'the box reports the new build');
  } else if (opts.finished) {
    out.completed = failed
      ? { state: 'failed', because: 'the installer exited with an error and the box has not reported a new build' }
      : { state: 'running', because: 'installer finished — waiting for the box to report the new build' };
  }

  // A failing run leaves whatever was still running marked failed rather than
  // spinning forever.
  if (failed && !opts.versionChanged) {
    for (const id of ORDER) if (out[id].state === 'running') out[id] = { state: 'failed', because: out[id].because };
  }

  return out;
}

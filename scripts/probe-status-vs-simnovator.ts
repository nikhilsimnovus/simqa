// Does SimQA's Status and Verdict say what the Simnovator says?
//
// The honest comparison is PER EXECUTION, not per testcase. The Simnovator's
// own test list shows the LAST execution of a testcase; a SimQA history row
// shows the execution THAT RUN produced. For a row a run never got to
// execute, those are different executions on purpose — reporting the box's
// older PASS there is the false-pass bug (see ownExecution.ts).
//
// So this walks SimQA's history, and for every row that names an execution it
// finds that same executionId in the box's own `metadata.executionHistory`
// and prints the two side by side. A MISMATCH line is a real bug.
//
// Read-only. Nothing here starts an execution.
//
//   npx tsx scripts/probe-status-vs-simnovator.ts [baseUrl] [limit]
import { ensureToken, getTestcase, type ApiOpts } from '../src/lib/uesimClient';
import { boxExecutionsOf } from '../src/lib/boxExecutions';
import { statusLabel, verdictLabel } from '../src/lib/automation/outcome';

const BASE = process.argv[2] ?? 'http://192.168.1.36:4100';
const LIMIT = Number(process.argv[3] ?? 10);

/** The lab's Simnovator logins. simuser everywhere the suites run. */
const creds = (host: string, user?: string): ApiOpts =>
  ({ host, username: user || 'simuser', password: user || 'simuser' }) as ApiOpts;

const hist: any = await fetch(`${BASE}/api/automation/history?limit=${LIMIT}`, { cache: 'no-store' as RequestCache })
  .then((r) => r.json());

let checked = 0, matched = 0, mismatched = 0, notFound = 0, noExec = 0;

for (const run of (hist.runs ?? []) as any[]) {
  if (!run.runId || !run.uesimHost) continue;
  console.log(`\n== ${run.suiteName}  ${run.uesimHost} / ${run.boxUser ?? '-'}  ${run.startedAt}`);

  let opts: ApiOpts;
  try {
    opts = creds(run.uesimHost, run.boxUser);
    await ensureToken(opts.host, opts.username, opts.password);
  } catch (e: any) {
    console.log(`   cannot log in to ${run.uesimHost}: ${String(e.message).slice(0, 80)}`);
    continue;
  }

  for (const row of (run.rows ?? []) as any[]) {
    const label = String(row.name).slice(0, 44).padEnd(46);
    if (!row.executionId) {
      noExec++;
      console.log(`   ${label} SimQA ${String(row.status).padEnd(13)}${(row.verdict || '-').padEnd(12)}`
        + '| the run produced no execution, so the box has nothing to compare');
      continue;
    }
    if (!row.boxTestcaseId) {
      console.log(`   ${label} names an execution but not the testcase it ran on`);
      continue;
    }

    let box: any;
    try {
      box = await getTestcase(opts, row.boxTestcaseId);
    } catch {
      console.log(`   ${label} that testcase is no longer on ${run.uesimHost}`);
      continue;
    }

    const mine = boxExecutionsOf(box?.metadata).find((x) => x.executionId === row.executionId);
    if (!mine) {
      notFound++;
      console.log(`   ${label} execution ${String(row.executionId).slice(0, 8)} is not in the box's history`);
      continue;
    }

    // Through the same maps the UI uses, so this compares what is DISPLAYED.
    const o = { boxStatus: mine.status, boxResult: mine.result };
    const boxStatus = statusLabel(o);
    const boxVerdict = verdictLabel(o);
    const same = boxStatus === row.status && boxVerdict === (row.verdict ?? '');
    checked++;
    if (same) matched++; else mismatched++;

    console.log(`   ${label} SimQA ${String(row.status).padEnd(13)}${(row.verdict || '-').padEnd(12)}`
      + `| box ${String(mine.status ?? '-').padEnd(12)}${String(mine.result ?? '-').padEnd(13)}`
      + `-> ${boxStatus} / ${boxVerdict || '-'}  ${same ? 'same' : 'MISMATCH'}`);
  }
}

console.log(`\ncompared ${checked} execution(s): ${matched} same, ${mismatched} MISMATCH`
  + `; ${notFound} not in the box's history; ${noExec} row(s) never produced an execution`);

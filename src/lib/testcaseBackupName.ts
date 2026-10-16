// What a testcase export is called, and how a stored backup file names the
// login it came from.
//
// Split out because it is the part worth testing and the rest of
// testcaseBackup.ts reaches the network — pure, importing nothing, so
// node --test loads it directly.
//
// Both rules exist for one reason: a Simnovator scopes its catalogue per
// account. On 192.168.1.95 sruthi holds 61 testcases, simuser 168 and admin
// 369, and none of them can see another's. So "the system's testcases" is
// several separate sets, and anything that stores or downloads them has to
// say whose it has — otherwise one login's export overwrites another's in the
// downloads folder, and one login's file overwrites another's on disk.

/** The suffix-free prefix a stored backup file carries when a system has more
 *  than one login. Two accounts can then each hold a testcase of the same name
 *  without one overwriting the other in a flat directory. */
export function userPrefix(boxUser: string): string {
  return `${boxUser}--`;
}

/** The login a stored backup file belongs to, or undefined when the file came
 *  from a setup with a single login and carries no prefix. */
export function userOfFile(name: string): string | undefined {
  const m = String(name).match(/^([^-]+(?:-[^-]+)*?)--/);
  return m ? m[1] : undefined;
}

/** Suggested filename for a download: system, login and timestamp. */
export function testcaseExportFilename(systemId: string, now = new Date(), boxUser?: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = (v: string) => v.replace(/[^A-Za-z0-9_.-]/g, '_');
  const who = boxUser ? `-${safe(boxUser)}` : '';
  return `testcases-${safe(systemId)}${who}-${stamp}.json`;
}

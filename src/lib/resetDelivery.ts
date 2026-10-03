// Getting a password-reset link to the person who asked for it.
//
// SimQA has no mail server and no mail dependency, and adding one for a tool
// that runs on a closed lab network would be adding a service to operate. So
// delivery is pluggable, and honest about what it did:
//
//   SIMQA_RESET_WEBHOOK   a URL the link is POSTed to as JSON. A Teams or
//                         Slack incoming webhook, or anything that forwards to
//                         mail — whatever the site already runs.
//   always                appended to data/password-resets.log, mode 0600, so
//                         an administrator on the box can hand the link over
//                         when there is no webhook.
//
// The link is NEVER returned to the browser that asked for it. If it were,
// anyone could reset anyone's password by typing their username.

import * as fs from 'node:fs';
import * as path from 'node:path';

const LOG = () => path.join(process.cwd(), 'data', 'password-resets.log');

export interface ResetDelivery {
  /** Did a configured channel accept it? False means the log is the only copy. */
  delivered: boolean;
  via: 'webhook' | 'log';
}

export async function deliverResetLink(opts: {
  username: string;
  email?: string;
  link: string;
  expiresAt: string;
}): Promise<ResetDelivery> {
  const hook = (process.env.SIMQA_RESET_WEBHOOK ?? '').trim();
  let delivered = false;

  if (hook) {
    try {
      const r = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `SimQA password reset for ${opts.username}: ${opts.link} (valid until ${opts.expiresAt})`,
          username: opts.username,
          email: opts.email,
          link: opts.link,
          expiresAt: opts.expiresAt,
        }),
        signal: AbortSignal.timeout(8000),
      });
      delivered = r.ok;
    } catch {
      delivered = false;   // the log below is the fallback, every time
    }
  }

  // Written whether or not the webhook worked: if delivery failed, this is the
  // only way the person gets back in, and if it succeeded this is the record
  // that a reset was requested at all.
  try {
    fs.mkdirSync(path.dirname(LOG()), { recursive: true });
    fs.appendFileSync(
      LOG(),
      `${new Date().toISOString()}  user=${opts.username}  email=${opts.email ?? '-'}  ` +
      `expires=${opts.expiresAt}  delivered=${delivered ? 'webhook' : 'no'}  link=${opts.link}\n`,
      { mode: 0o600 },
    );
  } catch { /* an unwritable data dir must not break the request */ }

  return { delivered, via: delivered ? 'webhook' : 'log' };
}

#!/usr/bin/env node
// Reset a SimQA account's password, from the console of the machine SimQA
// runs on.
//
//   cd /opt/simqa
//   sudo -u simqa node scripts/reset-password.mjs --list
//   sudo -u simqa node scripts/reset-password.mjs <username>
//   sudo -u simqa node scripts/reset-password.mjs <username> --generate
//
// Why a console script and not a page: anyone who can reach SimQA over the
// network can reach its pages, so a "reset someone's password" button would
// be a way in rather than a way back in. Running this needs an account on the
// host and the service user's own file, which is exactly the authority a
// password reset should take.
//
// It never prints, logs or stores a password that was typed. --generate
// prints the one it made, once, to this terminal: there is nowhere else for
// it to go, and an operator who cannot see it cannot pass it on.
//
// Everything it writes goes through src/lib/users.ts — the same salt, the
// same scrypt parameters, the same password history and the same session
// epoch bump that changing your own password in Profile makes. A reset
// account is indistinguishable from one whose owner changed it themselves.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A password that satisfies the policy without anybody having to invent one. */
function generated() {
  // No characters that are hard to read out or retype: no O/0, no l/1.
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const sym = '!@#$%^&*?-_';
  const all = upper + lower + digit + sym;
  const pick = (set) => set[randomBytes(1)[0] % set.length];
  // One of each class first, so the policy cannot reject it for a class it
  // happened not to roll.
  return pick(upper) + pick(lower) + pick(digit) + pick(sym)
    + Array.from({ length: 12 }, () => pick(all)).join('');
}

/** Read a line without echoing it, so it is not left on the screen. */
async function readSecret(prompt) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl.output.write.bind(rl.output);
  let muted = false;
  rl.output.write = (chunk, ...rest) => (muted ? true : write(chunk, ...rest));
  process.stdout.write(prompt);
  const answer = await new Promise((resolve) => {
    rl.question('', (a) => resolve(a));
    muted = true;
  });
  muted = false;
  rl.close();
  process.stdout.write('\n');
  return answer;
}

async function main() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const root = path.resolve(here, '..');
  // users.ts resolves data/users.json against the working directory, so this
  // works from anywhere rather than only from the install root.
  process.chdir(root);

  const dataFile = path.join(root, 'data', 'users.json');
  if (!fs.existsSync(dataFile)) {
    console.error(`No account file at ${dataFile}.`);
    console.error('Run this on the machine SimQA is installed on (usually /opt/simqa).');
    return 2;
  }

  const { listUsernames, userExists, setPassword } = await import('../src/lib/users.ts');

  const args = process.argv.slice(2);
  const generate = args.includes('--generate');
  const username = args.find((a) => !a.startsWith('--'));

  if (args.includes('--list')) {
    const names = listUsernames();
    console.log(names.length ? names.join('\n') : '(no accounts yet — sign up in the browser to make the first one)');
    return 0;
  }

  if (!username) {
    console.error('Usage: node scripts/reset-password.mjs <username> [--generate]');
    console.error('       node scripts/reset-password.mjs --list');
    return 2;
  }

  if (!userExists(username)) {
    console.error(`No account called "${username}". Run with --list to see the names that exist.`);
    return 1;
  }

  let password;
  if (generate) {
    password = generated();
  } else {
    password = await readSecret(`New password for "${username}": `);
    const again = await readSecret('Type it again: ');
    if (password !== again) {
      console.error('Those do not match. Nothing was changed.');
      return 1;
    }
  }

  const r = setPassword(username, password);
  if (!r.ok) {
    // The policy's own words — including "choose one you have not used
    // before", which is a real answer rather than a failure of this script.
    console.error(r.error ?? 'The password could not be changed.');
    return 1;
  }

  console.log(`Password changed for "${username}". Every session that account had is now signed out.`);
  if (generate) {
    console.log(`New password: ${password}`);
    console.log('It is stored nowhere else. Hand it over, and have them change it in Profile.');
  }
  return 0;
}

// exitCode rather than process.exit(): exiting mid-flight leaves libuv
// handles half-closed (it asserts on Windows), and there is nothing here that
// needs to die before its output is flushed.
process.exitCode = await main();

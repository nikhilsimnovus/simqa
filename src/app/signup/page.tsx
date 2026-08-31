// /signup — anyone on the lab network can create a SimQA account.
//
// Open registration is deliberate: the point of accounts here is that every
// playlist, testcase and job has a real owner, not that access is restricted.
// Accounts are stored in data/users.json with scrypt-hashed passwords (see
// src/lib/users.ts) and that file is gitignored.

import { AuthShell } from '../login/AuthShell';
import { SignupForm } from './SignupForm';

export const metadata = { title: 'Create account — SimQA' };
export const dynamic = 'force-dynamic';

export default function SignupPage() {
  return (
    <AuthShell tagline="Create an account to start running tests.">
      <SignupForm />

      <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3">
        <div className="flex items-start gap-2">
          <span aria-hidden className="text-amber-600 mt-[1px]">💡</span>
          <div className="text-[13px] leading-relaxed text-slate-700">
            <span className="font-semibold text-slate-900">What your account is for.</span>{' '}
            SimQA records your name against the playlists and testcases you create,
            the jobs you submit, and the lab systems you last used. Sign-in is for
            attribution on a trusted network — don&apos;t reuse a password that
            matters elsewhere.
          </div>
        </div>
      </div>
    </AuthShell>
  );
}

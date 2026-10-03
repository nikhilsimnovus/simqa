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
    <AuthShell
      tagline="Execute, automate, monitor, and validate your test scenarios from one place."
      title="Create your account"
      subtitle="Join SimQA to start running tests"
    >
      <SignupForm />
    </AuthShell>
  );
}

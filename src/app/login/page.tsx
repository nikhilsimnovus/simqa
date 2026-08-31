// /login — sign in to SimQA.
//
// The name is what attributes work across the app — who created a playlist or
// testcase, who submitted the last job, who last used a box — and the password
// is what stops one person's name being used by someone else. Accounts live in
// data/users.json (scrypt-hashed); see src/lib/users.ts.
//
// Laid out like the Simnovator login it sits alongside (brand, product, build,
// fields, primary action, footer) so the pair feel like one product.

import { Suspense } from 'react';
import { AuthShell } from './AuthShell';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Sign in — SimQA' };
export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <AuthShell tagline="Automated QA for Simnovator UESIM.">
      {/* Suspense: LoginForm reads ?next= via useSearchParams. */}
      <Suspense fallback={<div className="h-[320px]" />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}

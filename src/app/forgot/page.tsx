// /forgot — ask for a password reset link.
//
// The answer never says whether the account exists. That is the whole point of
// the wording: a page that confirms a username would be a way to enumerate who
// works here.

import { AuthShell } from '../login/AuthShell';
import { ForgotForm } from './ForgotForm';

export const metadata = { title: 'Forgot password — SimQA' };
export const dynamic = 'force-dynamic';

export default function ForgotPage() {
  return (
    <AuthShell
      tagline="Execute, automate, monitor, and validate your test scenarios from one place."
      title="Forgot your password?"
      subtitle="We'll send a link to reset it"
    >
      <ForgotForm />
    </AuthShell>
  );
}

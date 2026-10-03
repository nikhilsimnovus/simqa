// /reset?token=… — set a new password from a reset link.

import { Suspense } from 'react';
import { AuthShell } from '../login/AuthShell';
import { ResetForm } from './ResetForm';

export const metadata = { title: 'Reset password — SimQA' };
export const dynamic = 'force-dynamic';

export default function ResetPage() {
  return (
    <AuthShell
      tagline="Execute, automate, monitor, and validate your test scenarios from one place."
      title="Set a new password"
      subtitle="Choose a password you have not used before"
    >
      {/* Suspense: ResetForm reads ?token= via useSearchParams. */}
      <Suspense fallback={<div className="h-[280px]" />}>
        <ResetForm />
      </Suspense>
    </AuthShell>
  );
}

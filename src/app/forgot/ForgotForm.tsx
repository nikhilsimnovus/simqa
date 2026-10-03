'use client';

// Requesting a reset link.
//
// Success and "no such account" look identical here because the server answers
// identically. The page therefore shows the same sentence every time, and does
// not pretend to know whether anything was sent.

import { useState } from 'react';
import Link from 'next/link';
import { User } from 'lucide-react';
import { AuthField, AuthSubmit } from '@/components/AuthField';

export function ForgotForm() {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || identifier.trim().length === 0) return;
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setErr(d?.error ?? 'Something went wrong. Please try again.'); return; }
      setSent(d.message ?? 'If an account exists for this information, a password reset link has been sent.');
    } catch {
      setErr('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {sent}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          The link is valid for 30 minutes and can be used once. If it does not arrive, ask whoever
          administers this SimQA instance — delivery depends on how it was set up.
        </p>
        <p className="mt-6 text-center text-sm text-slate-600">
          <Link href="/login" className="font-semibold text-blue-600 hover:underline">Return to Login</Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate autoComplete="off">
      <AuthField
        label="Username or email"
        value={identifier}
        onChange={(v) => { setIdentifier(v); if (err) setErr(null); }}
        placeholder="Enter your username or email"
        autoComplete="off"
        icon={<User className="h-4 w-4" />}
        error={err}
        autoFocus
        disabled={busy}
      />

      <AuthSubmit
        label="Send reset link"
        busyLabel="Sending…"
        busy={busy}
        disabled={identifier.trim().length === 0}
      />

      <p className="mt-6 text-center text-sm text-slate-600">
        <Link href="/login" className="font-semibold text-blue-600 hover:underline">Return to Login</Link>
      </p>
    </form>
  );
}

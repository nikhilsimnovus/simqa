'use client';

// Setting a new password from a reset link.
//
// The link is checked before the form is shown, so an expired or spent one
// says so immediately rather than after someone has typed a password twice.
// It is checked again when the password is submitted, because the first check
// proves nothing by the time the second request arrives.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { AuthField, AuthSubmit } from '@/components/AuthField';
import { PasswordRules, passwordMeetsPolicy } from '@/components/PasswordRules';

type State = 'checking' | 'ready' | 'bad' | 'done';

export function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<State>('checking');
  const [linkError, setLinkError] = useState<string>('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setState('bad'); setLinkError('This password reset link is not valid. Request a new one.'); return; }
    let cancelled = false;
    fetch(`/api/auth/reset?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d?.ok) setState('ready');
        else { setState('bad'); setLinkError(d?.error ?? 'This password reset link is not valid. Request a new one.'); }
      })
      .catch(() => {
        if (cancelled) return;
        setState('bad'); setLinkError('Could not check this link. Try again, or request a new one.');
      });
    return () => { cancelled = true; };
  }, [token]);

  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = passwordMeetsPolicy(password) && password === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canSubmit) return;
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, confirm }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        // A link that expired while the form was open is a dead end, not a
        // field error — say so where the form was.
        if (d?.reason && d.reason !== 'policy') { setState('bad'); setLinkError(d.error ?? 'This link can no longer be used.'); return; }
        setErr(d?.error ?? 'Something went wrong. Please try again.');
        return;
      }
      setState('done');
    } catch {
      setErr('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'checking') {
    return <p className="text-sm text-slate-500">Checking this link…</p>;
  }

  if (state === 'bad') {
    return (
      <div>
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {linkError}
        </div>
        <p className="mt-6 text-center text-sm text-slate-600">
          <Link href="/forgot" className="font-semibold text-blue-600 hover:underline">Request a new link</Link>
          <span className="mx-2 text-slate-300">·</span>
          <Link href="/login" className="font-semibold text-blue-600 hover:underline">Return to Login</Link>
        </p>
      </div>
    );
  }

  if (state === 'done') {
    return (
      <div>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Your password has been reset successfully.
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Any other sessions signed in with the old password have been ended.
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
        label="New password"
        type="password"
        value={password}
        onChange={(v) => { setPassword(v); if (err) setErr(null); }}
        placeholder="Choose a new password"
        autoComplete="new-password"
        icon={<Lock className="h-4 w-4" />}
        autoFocus
        disabled={busy}
      />
      <PasswordRules password={password} />

      <AuthField
        label="Confirm new password"
        type="password"
        value={confirm}
        onChange={(v) => { setConfirm(v); if (err) setErr(null); }}
        placeholder="Re-enter your new password"
        autoComplete="new-password"
        icon={<Lock className="h-4 w-4" />}
        error={mismatch ? 'Passwords do not match.' : err}
        disabled={busy}
      />

      <AuthSubmit label="Reset password" busyLabel="Resetting…" busy={busy} disabled={!canSubmit} />

      <p className="mt-6 text-center text-sm text-slate-600">
        <Link href="/login" className="font-semibold text-blue-600 hover:underline">Return to Login</Link>
      </p>
    </form>
  );
}

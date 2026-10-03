'use client';

// Creating an account.
//
// The rules are checked as you type so nothing is a surprise at submit, and
// again on the server, which is where they are actually enforced. Inline
// messages say which field is wrong — "Username already exists", "Email is
// already registered", "Passwords do not match" — because a form that only
// says "invalid" makes people guess.

import { useState } from 'react';
import Link from 'next/link';
import { User, Lock } from 'lucide-react';
import { AuthField, AuthSubmit } from '@/components/AuthField';
import { passwordMeetsPolicy } from '@/components/PasswordRules';

export function SignupForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErr, setFieldErr] = useState<Record<string, string | null>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const name = username.trim();
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = name.length >= 2 && passwordMeetsPolicy(password) && password === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canSubmit) return;
    setErr(null); setFieldErr({}); setBusy(true);
    try {
      const r = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password, confirm }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        // The server says which field it objected to; put the message there
        // rather than in a general banner the eye has to hunt for.
        if (d?.field) setFieldErr({ [d.field]: d.error ?? 'Not accepted.' });
        else setErr(d?.error ?? 'Something went wrong. Please try again.');
        return;
      }
      // Signup signs you in, so go straight to the dashboard. Hard navigation
      // for the same reason as login: the App Router would serve its cached
      // signed-out payload otherwise.
      window.location.assign('/');
    } catch {
      setErr('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate autoComplete="off">
      <AuthField
        label="Username"
        value={username}
        onChange={(v) => { setUsername(v); setFieldErr(f => ({ ...f, username: null })); }}
        placeholder="Choose a username"
        autoComplete="off"
        icon={<User className="h-4 w-4" />}
        error={fieldErr.username}
        autoFocus
        disabled={busy}
      />

      <AuthField
        label="Password"
        type="password"
        value={password}
        onChange={(v) => { setPassword(v); setFieldErr(f => ({ ...f, password: null })); }}
        placeholder="Choose a password"
        autoComplete="new-password"
        icon={<Lock className="h-4 w-4" />}
        error={fieldErr.password}
        disabled={busy}
      />

      <AuthField
        label="Confirm password"
        type="password"
        value={confirm}
        onChange={(v) => { setConfirm(v); setFieldErr(f => ({ ...f, confirm: null })); }}
        placeholder="Re-enter your password"
        autoComplete="new-password"
        icon={<Lock className="h-4 w-4" />}
        error={mismatch ? 'Passwords do not match.' : fieldErr.confirm}
        disabled={busy}
      />

      {err ? <p role="alert" className="mt-3 text-xs text-red-600">{err}</p> : null}

      <AuthSubmit label="Create account" busyLabel="Creating account…" busy={busy} disabled={!canSubmit} />

      <div className="mt-6 flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-xs text-slate-400">or</span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      <p className="mt-5 text-center text-sm text-slate-600">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold text-blue-600 hover:underline">Sign in</Link>
      </p>
    </form>
  );
}

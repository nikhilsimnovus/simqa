'use client';

// Signing in.
//
// Nothing is filled in for you, on load or after a refresh: this is a shared
// lab machine, and the next person at the keyboard should have to say who they
// are. "Remember me" is about how long the session lasts on this device — it
// has never put a name or a password back into these fields, and no password
// is written to this browser by anything here.
//
// Every failure reads the same, because the server answers the same: whether
// the account exists is not something a login form should be willing to say.

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { User, Lock } from 'lucide-react';
import { AuthField, AuthSubmit } from '@/components/AuthField';

export function LoginForm() {
  const params = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;                     // a second Enter must not fire a second request
    setErr(null); setHint(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, remember }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setErr(d?.error ?? 'Unable to sign in. Please check your credentials.');
        if (d?.noAccountsYet) setHint('No accounts exist yet — create the first one.');
        return;
      }

      // Only same-origin relative paths — never bounce to an arbitrary target
      // handed to us in the query string.
      const next = params.get('next');
      const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
      // Hard navigation, not router.replace: the session lives in a cookie that
      // middleware reads, and the App Router would happily serve its cached
      // /login payload instead.
      window.location.assign(dest);
    } catch {
      setErr('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = username.trim().length >= 2 && password.length > 0;

  return (
    // autoComplete off throughout: the browser's own saved credentials would
    // otherwise put a name and password back into the fields, which is the
    // thing being prevented.
    <form onSubmit={submit} noValidate autoComplete="off">
      <AuthField
        label="Username"
        value={username}
        onChange={(v) => { setUsername(v); if (err) setErr(null); }}
        placeholder="Enter your username"
        autoComplete="off"
        icon={<User className="h-4 w-4" />}
        autoFocus
        disabled={busy}
      />

      <AuthField
        label="Password"
        type="password"
        value={password}
        onChange={(v) => { setPassword(v); if (err) setErr(null); }}
        placeholder="Enter your password"
        autoComplete="new-password"
        icon={<Lock className="h-4 w-4" />}
        error={err}
        disabled={busy}
      />
      {hint ? <p className="mt-1.5 text-xs text-slate-500">{hint}</p> : null}

      {/* About the SESSION, not about these fields: ticked, the sign-in
          outlives the browser being closed; left alone, it does not. */}
      <label className="mt-4 flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          disabled={busy}
          className="h-4 w-4 rounded border-slate-300 accent-blue-600"
        />
        Remember me
      </label>

      <AuthSubmit label="Sign in" busyLabel="Signing in…" busy={busy} disabled={!canSubmit} />

      <div className="mt-6 flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-xs text-slate-400">or</span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      <p className="mt-5 text-center text-sm text-slate-600">
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="font-semibold text-blue-600 hover:underline">Sign up</Link>
      </p>
    </form>
  );
}

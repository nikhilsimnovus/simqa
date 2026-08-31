'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

const LS_LAST_USER = 'simqa-last-user';

/** Mirrors the server rule in src/lib/users.ts. Checked here only to give
 *  immediate feedback — the server is what actually enforces it. */
const MIN_PASSWORD = 6;

export function SignupForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { userRef.current?.focus(); }, []);

  const name = username.trim();
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit =
    name.length >= 2 && password.length >= MIN_PASSWORD && password === confirm && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setErr(d?.error ?? `HTTP ${r.status}`);
        return;
      }
      try { window.localStorage.setItem(LS_LAST_USER, d.user); } catch { /* private mode */ }
      // Signup signs you in, so go straight to the dashboard. Hard navigation
      // for the same reason as login: the App Router would serve its cached
      // signed-out payload otherwise.
      window.location.assign('/');
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const fieldCls = (bad: boolean) =>
    'w-full h-11 rounded-lg border px-3.5 text-sm text-slate-900 bg-white ' +
    'placeholder:text-slate-400 focus:outline-none focus:ring-2 ' +
    (bad ? 'border-red-400 focus:ring-red-200' : 'border-slate-300 focus:ring-orange-200 focus:border-orange-400');

  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor="su-user" className="block text-sm font-semibold text-slate-800 mb-1.5">
        Username
      </label>
      <input
        id="su-user"
        ref={userRef}
        value={username}
        onChange={(e) => { setUsername(e.target.value); if (err) setErr(null); }}
        placeholder="Choose a username"
        autoComplete="username"
        spellCheck={false}
        className={fieldCls(!!err)}
      />
      <p className="mt-1 text-xs text-slate-500">
        This name is shown against everything you create and run.
      </p>

      <label htmlFor="su-pw" className="block text-sm font-semibold text-slate-800 mb-1.5 mt-4">
        Password
      </label>
      <div className="relative">
        <input
          id="su-pw"
          type={showPw ? 'text' : 'password'}
          value={password}
          onChange={(e) => { setPassword(e.target.value); if (err) setErr(null); }}
          placeholder={`At least ${MIN_PASSWORD} characters`}
          autoComplete="new-password"
          className={fieldCls(false) + ' pr-11'}
        />
        <button
          type="button"
          onClick={() => setShowPw((v) => !v)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs"
          aria-label={showPw ? 'Hide password' : 'Show password'}
        >
          {showPw ? 'Hide' : 'Show'}
        </button>
      </div>

      <label htmlFor="su-pw2" className="block text-sm font-semibold text-slate-800 mb-1.5 mt-4">
        Confirm password
      </label>
      <input
        id="su-pw2"
        type={showPw ? 'text' : 'password'}
        value={confirm}
        onChange={(e) => { setConfirm(e.target.value); if (err) setErr(null); }}
        placeholder="Re-enter your password"
        autoComplete="new-password"
        className={fieldCls(mismatch)}
      />
      {mismatch ? <p className="mt-1 text-xs text-red-600">Passwords don&apos;t match.</p> : null}

      {err ? <p className="mt-2 text-xs text-red-600">{err}</p> : null}

      <button
        type="submit"
        disabled={!canSubmit}
        className={
          'mt-5 w-full h-12 rounded-lg text-white text-[15px] font-semibold transition-colors ' +
          (!canSubmit ? 'bg-slate-300 cursor-not-allowed' : 'bg-orange-500 hover:bg-orange-600')
        }
      >
        {busy ? 'Creating account…' : 'Create account'}
      </button>

      <p className="mt-4 text-center text-sm text-slate-600">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold text-orange-600 hover:underline">Sign in</Link>
      </p>
    </form>
  );
}

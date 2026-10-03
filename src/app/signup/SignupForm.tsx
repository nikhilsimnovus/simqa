'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { User, Lock, Eye, EyeOff } from 'lucide-react';

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

  // The same fields as the sign-in form, so the pair are one screen with one
  // thing different rather than two designs.
  const wrapCls = (bad: boolean) =>
    'flex items-stretch rounded-lg border overflow-hidden bg-surface transition-colors focus-within:ring-2 ' +
    (bad
      ? 'border-red-400 focus-within:ring-red-200'
      : 'border-slate-300 focus-within:ring-blue-200 focus-within:border-blue-400');
  const inputCls = 'flex-1 h-11 px-3.5 text-sm text-slate-900 bg-transparent placeholder:text-slate-400 focus:outline-none';
  const iconBoxCls = 'grid place-items-center w-11 shrink-0 border-r border-slate-200 bg-slate-50 text-slate-400';

  return (
    <form onSubmit={submit} noValidate autoComplete="off">
      <label htmlFor="su-user" className="block text-sm font-semibold text-slate-800 mb-1.5">
        Username
      </label>
      <div className={wrapCls(!!err)}>
        <span className={iconBoxCls} aria-hidden><User className="h-4 w-4" /></span>
        <input
          id="su-user"
          ref={userRef}
          value={username}
          onChange={(e) => { setUsername(e.target.value); if (err) setErr(null); }}
          placeholder="Choose a username"
          autoComplete="off"
          spellCheck={false}
          className={inputCls}
        />
      </div>

      <label htmlFor="su-pw" className="block text-sm font-semibold text-slate-800 mb-1.5 mt-4">
        Password
      </label>
      <div className={wrapCls(false)}>
        <span className={iconBoxCls} aria-hidden><Lock className="h-4 w-4" /></span>
        <input
          id="su-pw"
          type={showPw ? 'text' : 'password'}
          value={password}
          onChange={(e) => { setPassword(e.target.value); if (err) setErr(null); }}
          placeholder={`At least ${MIN_PASSWORD} characters`}
          autoComplete="new-password"
          className={inputCls}
        />
        <button
          type="button"
          onClick={() => setShowPw((v) => !v)}
          className="px-3 text-slate-400 hover:text-slate-600"
          aria-label={showPw ? 'Hide password' : 'Show password'}
        >
          {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>

      <label htmlFor="su-pw2" className="block text-sm font-semibold text-slate-800 mb-1.5 mt-4">
        Confirm password
      </label>
      <div className={wrapCls(mismatch)}>
        <span className={iconBoxCls} aria-hidden><Lock className="h-4 w-4" /></span>
        <input
          id="su-pw2"
          type={showPw ? 'text' : 'password'}
          value={confirm}
          onChange={(e) => { setConfirm(e.target.value); if (err) setErr(null); }}
          placeholder="Re-enter your password"
          autoComplete="new-password"
          className={inputCls}
        />
      </div>
      {mismatch ? <p className="mt-1 text-xs text-red-600">Passwords don&apos;t match.</p> : null}

      {err ? <p className="mt-2 text-xs text-red-600">{err}</p> : null}

      <button
        type="submit"
        disabled={!canSubmit}
        className={
          'mt-6 w-full h-12 rounded-lg text-white text-[15px] font-semibold transition-colors ' +
          (!canSubmit ? 'bg-slate-300 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700')
        }
      >
        {busy ? 'Creating account…' : 'Create account'}
      </button>

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

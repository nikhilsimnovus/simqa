'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

/** localStorage key remembering the last username typed on this machine, so a
 *  shared lab PC offers the previous user rather than a blank field. Only the
 *  username — a password is never persisted anywhere in the browser. */
const LS_LAST_USER = 'simqa-last-user';

export function LoginForm() {
  const params = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement | null>(null);
  const pwRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let last = '';
    try { last = window.localStorage.getItem(LS_LAST_USER) ?? ''; } catch { /* private mode */ }
    if (last) {
      setUsername(last);
      pwRef.current?.focus();      // name already known — go straight to password
    } else {
      userRef.current?.focus();
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setErr(null); setHint(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setErr(d?.error ?? `HTTP ${r.status}`);
        if (d?.noAccountsYet) setHint('No accounts exist yet — create the first one.');
        return;
      }

      try {
        if (remember) window.localStorage.setItem(LS_LAST_USER, d.user);
        else window.localStorage.removeItem(LS_LAST_USER);
      } catch { /* not fatal */ }

      // Only same-origin relative paths — never bounce to an arbitrary target
      // handed to us in the query string.
      const next = params.get('next');
      const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
      // Hard navigation, not router.replace: the session lives in a cookie that
      // middleware reads, and the App Router would happily serve its cached
      // /login payload instead.
      window.location.assign(dest);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = username.trim().length >= 2 && password.length > 0 && !busy;
  const fieldCls = (bad: boolean) =>
    'w-full h-11 rounded-lg border px-3.5 text-sm text-slate-900 bg-white ' +
    'placeholder:text-slate-400 focus:outline-none focus:ring-2 ' +
    (bad ? 'border-red-400 focus:ring-red-200' : 'border-slate-300 focus:ring-orange-200 focus:border-orange-400');

  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor="simqa-user" className="block text-sm font-semibold text-slate-800 mb-1.5">
        Username
      </label>
      <input
        id="simqa-user"
        ref={userRef}
        value={username}
        onChange={(e) => { setUsername(e.target.value); if (err) setErr(null); }}
        placeholder="Enter your username"
        autoComplete="username"
        spellCheck={false}
        className={fieldCls(!!err)}
      />

      <label htmlFor="simqa-pw" className="block text-sm font-semibold text-slate-800 mb-1.5 mt-4">
        Password
      </label>
      <div className="relative">
        <input
          id="simqa-pw"
          ref={pwRef}
          type={showPw ? 'text' : 'password'}
          value={password}
          onChange={(e) => { setPassword(e.target.value); if (err) setErr(null); }}
          placeholder="Enter your password"
          autoComplete="current-password"
          className={fieldCls(!!err) + ' pr-11'}
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

      {err ? <p className="mt-2 text-xs text-red-600">{err}</p> : null}
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}

      <label className="mt-4 flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300"
        />
        Remember my username on this machine
      </label>

      <button
        type="submit"
        disabled={!canSubmit}
        className={
          'mt-5 w-full h-12 rounded-lg text-white text-[15px] font-semibold transition-colors ' +
          (!canSubmit ? 'bg-slate-300 cursor-not-allowed' : 'bg-orange-500 hover:bg-orange-600')
        }
      >
        {busy ? 'Signing in…' : 'Login'}
      </button>

      <p className="mt-4 text-center text-sm text-slate-600">
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="font-semibold text-orange-600 hover:underline">Sign up</Link>
      </p>
    </form>
  );
}

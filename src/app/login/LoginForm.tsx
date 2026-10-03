'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { User, Lock, Eye, EyeOff } from 'lucide-react';

export function LoginForm() {
  const params = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement | null>(null);
  const pwRef = useRef<HTMLInputElement | null>(null);

  // Both fields start empty, every time, including after a refresh. This is a
  // shared lab machine: the next person at the keyboard should have to say who
  // they are. The last username used to be remembered here and is not any
  // more — and nothing has ever written a password to this browser.
  useEffect(() => {
    try { window.localStorage.removeItem('simqa-last-user'); } catch { /* private mode */ }
    setUsername(''); setPassword('');
    userRef.current?.focus();
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
  /** The field and its icon share one border, so the icon reads as part of the
   *  input rather than as something sitting beside it. */
  const wrapCls = (bad: boolean) =>
    'flex items-stretch rounded-lg border overflow-hidden bg-surface transition-colors focus-within:ring-2 ' +
    (bad
      ? 'border-red-400 focus-within:ring-red-200'
      : 'border-slate-300 focus-within:ring-blue-200 focus-within:border-blue-400');
  const inputCls = 'flex-1 h-11 px-3.5 text-sm text-slate-900 bg-transparent placeholder:text-slate-400 focus:outline-none';
  const iconBoxCls = 'grid place-items-center w-11 shrink-0 border-r border-slate-200 bg-slate-50 text-slate-400';

  return (
    // autoComplete="off" throughout: the browser's own saved credentials would
    // otherwise put a name and password back into the fields, which is the
    // thing being prevented.
    <form onSubmit={submit} noValidate autoComplete="off">
      <label htmlFor="simqa-user" className="block text-sm font-semibold text-slate-800 mb-1.5">
        Username
      </label>
      <div className={wrapCls(!!err)}>
        <span className={iconBoxCls} aria-hidden><User className="h-4 w-4" /></span>
        <input
          id="simqa-user"
          ref={userRef}
          value={username}
          onChange={(e) => { setUsername(e.target.value); if (err) setErr(null); }}
          placeholder="Enter your username"
          autoComplete="off"
          spellCheck={false}
          className={inputCls}
        />
      </div>

      <label htmlFor="simqa-pw" className="block text-sm font-semibold text-slate-800 mb-1.5 mt-4">
        Password
      </label>
      <div className={wrapCls(!!err)}>
        <span className={iconBoxCls} aria-hidden><Lock className="h-4 w-4" /></span>
        <input
          id="simqa-pw"
          ref={pwRef}
          type={showPw ? 'text' : 'password'}
          value={password}
          onChange={(e) => { setPassword(e.target.value); if (err) setErr(null); }}
          placeholder="Enter your password"
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

      {err ? <p className="mt-2 text-xs text-red-600">{err}</p> : null}
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}

      <button
        type="submit"
        disabled={!canSubmit}
        className={
          'mt-6 w-full h-12 rounded-lg text-white text-[15px] font-semibold transition-colors ' +
          (!canSubmit ? 'bg-slate-300 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700')
        }
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>

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

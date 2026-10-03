'use client';

// Account and Security.
//
// Three things worth doing from here: see when the account was last used,
// change the password, and end sessions. Nothing on this page reveals a hash,
// a token or anything about another account.

import { useCallback, useEffect, useState } from 'react';
import { Lock, Mail } from 'lucide-react';
import { AuthField, AuthSubmit } from '@/components/AuthField';
import { PasswordRules, passwordMeetsPolicy } from '@/components/PasswordRules';

interface Me {
  username: string;
  email?: string;
  createdAt: string;
  lastLoginAt?: string;
  passwordChangedAt?: string;
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');

export function ProfileClient() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadErr, setLoadErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/me');
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) { window.location.assign('/login?next=/profile'); return; }
      if (d?.ok) setMe(d.user); else setLoadErr(d?.error ?? 'Could not load your account.');
    } catch { setLoadErr('Could not reach the server.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // ── email ───────────────────────────────────────────────────────────────
  const [email, setEmail] = useState('');
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [savingEmail, setSavingEmail] = useState(false);
  useEffect(() => { setEmail(me?.email ?? ''); }, [me?.email]);

  async function saveEmail(e: React.FormEvent) {
    e.preventDefault();
    if (savingEmail) return;
    setSavingEmail(true); setEmailErr(null); setEmailMsg(null);
    try {
      const r = await fetch('/api/auth/me', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setEmailErr(d?.error ?? 'Could not save that address.'); return; }
      setMe(d.user); setEmailMsg('Email updated.');
    } catch { setEmailErr('Could not reach the server.'); }
    finally { setSavingEmail(false); }
  }

  // ── password ────────────────────────────────────────────────────────────
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwErr, setPwErr] = useState<Record<string, string | null>>({});
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [savingPw, setSavingPw] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canChange = current.length > 0 && passwordMeetsPolicy(next) && next === confirm;

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (savingPw || !canChange) return;
    setSavingPw(true); setPwErr({}); setPwMsg(null);
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next, confirm }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setPwErr(d?.field ? { [d.field]: d.error } : { form: d?.error ?? 'Something went wrong. Please try again.' });
        return;
      }
      setPwMsg(d.message ?? 'Password changed successfully.');
      setCurrent(''); setNext(''); setConfirm('');
      void load();
    } catch { setPwErr({ form: 'Could not reach the server.' }); }
    finally { setSavingPw(false); }
  }

  // ── sessions ────────────────────────────────────────────────────────────
  async function signOut(everywhere: boolean) {
    if (everywhere && !window.confirm('Sign out everywhere?\n\nEvery other browser signed in as you will be signed out.')) return;
    await fetch('/api/auth/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ everywhere }),
    }).catch(() => null);
    window.location.assign('/login');
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Account</h1>
          <p className="text-sm text-slate-600 mt-1">Your sign-in details and security.</p>
        </header>

        {loadErr ? <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{loadErr}</div> : null}

        {/* ── who you are ──────────────────────────────────────────────── */}
        <section className="bg-surface border border-line rounded-lg p-5 mb-5">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Profile</h2>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Username</dt>
              <dd className="text-slate-900 font-medium">{me?.username ?? '…'}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Account created</dt>
              <dd className="text-slate-800">{when(me?.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Last sign-in</dt>
              <dd className="text-slate-800">{when(me?.lastLoginAt)}</dd>
            </div>
          </dl>

          <form onSubmit={saveEmail} className="mt-4 max-w-sm" autoComplete="off">
            <AuthField
              label="Email"
              type="email"
              value={email}
              onChange={(v) => { setEmail(v); setEmailErr(null); setEmailMsg(null); }}
              placeholder="you@example.com"
              autoComplete="off"
              icon={<Mail className="h-4 w-4" />}
              error={emailErr}
              hint={<p className="text-[11px] text-slate-500">Optional. A contact address for your account.</p>}
              disabled={savingEmail}
            />
            {emailMsg ? <p className="mt-2 text-xs text-emerald-700">{emailMsg}</p> : null}
            <button type="submit" disabled={savingEmail || email === (me?.email ?? '')}
              className="mt-3 rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-xs font-semibold px-3 py-1.5">
              {savingEmail ? 'Saving…' : 'Save email'}
            </button>
          </form>
        </section>

        {/* ── security ─────────────────────────────────────────────────── */}
        <section className="bg-surface border border-line rounded-lg p-5 mb-5">
          <h2 className="text-base font-semibold text-slate-900">Security</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Password last changed {when(me?.passwordChangedAt)}.
          </p>

          <form onSubmit={changePassword} className="mt-4 max-w-sm" autoComplete="off">
            <h3 className="text-sm font-semibold text-slate-800 mb-2">Change password</h3>
            <AuthField
              label="Current password"
              type="password"
              value={current}
              onChange={(v) => { setCurrent(v); setPwErr(f => ({ ...f, current: null })); }}
              placeholder="Your current password"
              autoComplete="current-password"
              icon={<Lock className="h-4 w-4" />}
              error={pwErr.current}
              disabled={savingPw}
            />
            <AuthField
              label="New password"
              type="password"
              value={next}
              onChange={(v) => { setNext(v); setPwErr(f => ({ ...f, new: null })); }}
              placeholder="Choose a new password"
              autoComplete="new-password"
              icon={<Lock className="h-4 w-4" />}
              error={pwErr.new}
              disabled={savingPw}
            />
            <PasswordRules password={next} />
            <AuthField
              label="Confirm new password"
              type="password"
              value={confirm}
              onChange={(v) => { setConfirm(v); setPwErr(f => ({ ...f, confirm: null })); }}
              placeholder="Re-enter your new password"
              autoComplete="new-password"
              icon={<Lock className="h-4 w-4" />}
              error={mismatch ? 'Passwords do not match.' : pwErr.confirm}
              disabled={savingPw}
            />
            {pwErr.form ? <p role="alert" className="mt-3 text-xs text-red-600">{pwErr.form}</p> : null}
            {pwMsg ? <p className="mt-3 text-xs text-emerald-700">{pwMsg}</p> : null}
            <AuthSubmit label="Change password" busyLabel="Changing…" busy={savingPw} disabled={!canChange} />
            <p className="mt-2 text-[11px] text-slate-500">
              Changing your password signs out every other browser you are signed in on.
            </p>
          </form>
        </section>

        {/* ── sessions ─────────────────────────────────────────────────── */}
        <section className="bg-surface border border-line rounded-lg p-5">
          <h2 className="text-base font-semibold text-slate-900 mb-1">Sessions</h2>
          <p className="text-xs text-slate-500 mb-3">
            SimQA does not keep a list of your devices. What it can do is end them all at once.
          </p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => signOut(false)}
              className="rounded-md border border-slate-300 hover:bg-slate-50 text-xs px-3 py-1.5">Sign out</button>
            <button onClick={() => signOut(true)}
              className="rounded-md border border-red-300 text-red-600 hover:bg-red-50 text-xs px-3 py-1.5">
              Sign out everywhere
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

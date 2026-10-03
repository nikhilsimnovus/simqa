'use client';

// Profile — who you are, and the two things you can do about it.
//
// Reading and editing are the same two cards: the rows do not move when you
// press Edit Profile, the right-hand column just becomes typeable. That keeps
// the whole page inside one screen at 100% zoom, which is how it is read.
//
// The username appears in both states and is editable in neither — it is what
// every suite, run and campaign is attributed to, so changing it would
// silently rewrite who did what. Changing a password is a different kind of
// act from correcting a surname, so it lives in the overflow menu behind its
// own dialogue, and the server re-checks the current password however you got
// there.

import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreVertical, KeyRound, LogOut, Lock, X } from 'lucide-react';
import { Header } from '@/components/Header';
import { AuthField } from '@/components/AuthField';
import { Toast, type ToastMessage } from '@/components/Toast';
import { passwordMeetsPolicy } from '@/components/PasswordRules';

interface Me {
  username: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  createdAt: string;
  lastLoginAt?: string;
  passwordChangedAt?: string;
}

/** "Oct 1, 2026, 3:00 PM" — month, day, year and the time of day.
 *
 *  Pinned to en-US rather than the browser's locale so everyone reading the
 *  same account sees the same string, and so the month is always a word: a lab
 *  that spans locales cannot afford 3/10 meaning two different days. */
function stamp(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/** One label/value row. The grid is shared by every row in both cards, so the
 *  values line up across the page whether they are text or an input. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-4 py-2">
      <dt className="text-sm text-slate-600">{label}:</dt>
      <dd className="min-w-0 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

export function ProfileClient() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/me', { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) { window.location.assign('/login?next=/profile'); return; }
      if (d?.ok) setMe(d.user); else setLoadErr(d?.error ?? 'Could not load your account.');
    } catch { setLoadErr('Could not reach the server.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // ── editing ─────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setFirst(me?.firstName ?? '');
    setLast(me?.lastName ?? '');
    setEmail(me?.email ?? '');
    setToast(null);
    setEditing(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true); setToast(null);
    try {
      const r = await fetch('/api/auth/me', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: first, lastName: last, email }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        // The server decides what is acceptable — including that an edit must
        // leave something behind — and the form stays open on its answer.
        setToast({ kind: 'error', title: 'Error', message: d?.error ?? 'Could not save your changes.' });
        return;
      }
      setMe(d.user);
      setEditing(false);
      setToast({ kind: 'success', title: 'Success', message: 'Profile updated successfully' });
    } catch {
      setToast({ kind: 'error', title: 'Error', message: 'Could not reach the server.' });
    } finally { setSaving(false); }
  }

  // ── overflow menu ───────────────────────────────────────────────────────
  const [menu, setMenu] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const menuBox = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => {
      if (menuBox.current && !menuBox.current.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [menu]);

  async function signOutEverywhere() {
    if (!window.confirm('Sign out everywhere?\n\nEvery browser signed in as you, including this one, will be signed out.')) return;
    await fetch('/api/auth/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ everywhere: true }),
    }).catch(() => null);
    window.location.assign('/login');
  }

  const fullName = [me?.firstName, me?.lastName].filter(Boolean).join(' ');
  const input = 'w-full rounded-md border border-slate-300 bg-surface px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200';

  return (
    <>
      <Header
        title="Profile"
        subtitle="Manage your profile information"
        right={
          <div className="relative" ref={menuBox}>
            <button
              type="button"
              onClick={() => setMenu((o) => !o)}
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              aria-haspopup="menu"
              aria-expanded={menu}
              aria-label="More"
              title="More"
            >
              <MoreVertical className="h-4 w-4" aria-hidden />
            </button>
            {menu ? (
              <div role="menu" className="absolute right-0 z-30 mt-2 w-56 rounded-lg border border-line bg-surface py-1 shadow-lg">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenu(false); setPwOpen(true); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-slate-700 hover:bg-slate-50"
                >
                  <KeyRound className="h-4 w-4 text-slate-500" aria-hidden />
                  Change Password
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenu(false); void signOutEverywhere(); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-orange-600 hover:bg-orange-50"
                >
                  <LogOut className="h-4 w-4" aria-hidden />
                  Sign out everywhere
                </button>
              </div>
            ) : null}
          </div>
        }
      />

      <Toast toast={toast} onClose={() => setToast(null)} />

      <div className="space-y-4 p-5">
        {loadErr ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadErr}</div>
        ) : null}

        {/* ── who ──────────────────────────────────────────────────────── */}
        <section className="rounded-lg border border-line bg-surface px-5 py-4 text-center">
          <div className="text-lg font-semibold text-slate-900">{me?.username ?? '…'}</div>
          {fullName ? <div className="mt-0.5 text-sm text-slate-500">{fullName}</div> : null}
        </section>

        {/* ── the record, typeable in place when editing ───────────────── */}
        <form onSubmit={save} className="grid items-start gap-4 lg:grid-cols-2">
          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="mb-1 text-sm font-semibold text-slate-900">Personal Details</h2>
            <dl className="divide-y divide-line">
              <Row label="First name">
                {editing ? (
                  <input className={input} value={first} onChange={(e) => setFirst(e.target.value)}
                    placeholder="First Name" autoComplete="given-name" disabled={saving} autoFocus aria-label="First name" />
                ) : (me?.firstName || '—')}
              </Row>
              <Row label="Last name">
                {editing ? (
                  <input className={input} value={last} onChange={(e) => setLast(e.target.value)}
                    placeholder="Last Name" autoComplete="family-name" disabled={saving} aria-label="Last name" />
                ) : (me?.lastName || '—')}
              </Row>
              <Row label="Email">
                {editing ? (
                  <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email" autoComplete="email" disabled={saving} aria-label="Email" />
                ) : (me?.email || '—')}
              </Row>
              <Row label="Username">
                <span title={editing ? 'Your username cannot be changed — everything you have run is recorded against it.' : undefined}>
                  {me?.username ?? '…'}
                </span>
              </Row>
            </dl>
          </section>

          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="mb-1 text-sm font-semibold text-slate-900">Account Details</h2>
            <dl className="divide-y divide-line">
              <Row label="Date Added">{stamp(me?.createdAt)}</Row>
              <Row label="Last sign-in">{stamp(me?.lastLoginAt)}</Row>
              <Row label="Password changed">{stamp(me?.passwordChangedAt)}</Row>
            </dl>
          </section>

          <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
            {editing ? (
              <>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:bg-slate-300"
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  disabled={saving}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={startEdit}
                className="rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600"
              >
                Edit Profile
              </button>
            )}
          </div>
        </form>
      </div>

      {pwOpen ? (
        <ChangePassword
          onClose={() => setPwOpen(false)}
          onDone={() => {
            setPwOpen(false);
            setToast({ kind: 'success', title: 'Success', message: 'Password updated successfully' });
            void load();
          }}
        />
      ) : null}
    </>
  );
}

// ─── Change password ──────────────────────────────────────────────────────
//
// Mounted only while open, so every visit starts with empty fields rather than
// whatever was typed and abandoned last time. The current password is required
// here and checked again on the server: a session left open on a shared lab
// machine must not be enough to take the account over.
function ChangePassword({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string | null>>({});

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy, onClose]);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && passwordMeetsPolicy(next) && next === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canSubmit) return;
    setBusy(true); setErr({});
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next, confirm }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setErr(d?.field ? { [d.field]: d.error } : { form: d?.error ?? 'Something went wrong. Please try again.' });
        return;
      }
      onDone();
    } catch { setErr({ form: 'Could not reach the server.' }); }
    finally { setBusy(false); }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Change Password"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold text-slate-900">Change Password</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <form onSubmit={submit} className="mt-4" autoComplete="off">
          <AuthField
            label="Current Password"
            type="password"
            value={current}
            onChange={(v) => { setCurrent(v); setErr((f) => ({ ...f, current: null })); }}
            autoComplete="current-password"
            icon={<Lock className="h-4 w-4" />}
            error={err.current}
            disabled={busy}
            autoFocus
          />
          <AuthField
            label="New Password"
            type="password"
            value={next}
            onChange={(v) => { setNext(v); setErr((f) => ({ ...f, new: null })); }}
            autoComplete="new-password"
            icon={<Lock className="h-4 w-4" />}
            error={err.new}
            disabled={busy}
          />
          <AuthField
            label="Confirm New Password"
            type="password"
            value={confirm}
            onChange={(v) => { setConfirm(v); setErr((f) => ({ ...f, confirm: null })); }}
            autoComplete="new-password"
            icon={<Lock className="h-4 w-4" />}
            error={mismatch ? 'Passwords do not match.' : err.confirm}
            disabled={busy}
          />

          {err.form ? <p role="alert" className="mt-3 text-xs text-red-600">{err.form}</p> : null}
          <p className="mt-3 text-[11px] text-slate-500">
            This signs out every other browser you are signed in on. You stay signed in here.
          </p>

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit || busy}
              className="rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:bg-slate-300"
            >
              {busy ? 'Updating…' : 'Update Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

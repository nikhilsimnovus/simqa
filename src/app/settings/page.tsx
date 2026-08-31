'use client';

// Workspace settings. Three real sections — appearance, timeouts/polling,
// run notifications — each backed by something that actually consumes it:
//   theme     → data-theme attribute + localStorage (same store the sidebar
//               toggle uses; "system" clears the override)
//   timeouts  → lib/settings.ts, consulted by uesimClient on every REST call
//               and by the end-to-end runner for poll/grace defaults
//   webhook   → lib/notify.ts, fired when an end-to-end run finishes
//
// Numbers are edited in seconds (grace in minutes) because nobody thinks in
// milliseconds; the store keeps ms.

import { useEffect, useState, useCallback } from 'react';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Button, Input, Field, Kicker } from '@/components/ui';
import { Monitor, Moon, Sun, Send } from 'lucide-react';
import { cn } from '@/lib/cn';
import { THEME_KEY } from '@/components/ThemeToggle';

interface SettingsDto {
  uesimGetTimeoutMs: number;
  uesimPostTimeoutMs: number;
  runnerPollIntervalMs: number;
  runnerCompletionGraceMs: number;
  notifyWebhookUrl: string;
  notifyOnSuccess: boolean;
}

type ThemeChoice = 'light' | 'dark' | 'system';

export default function SettingsPage() {
  const [s, setS] = useState<SettingsDto | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>('system');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then(setS).catch(() => setS(null));
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      setTheme(stored === 'light' || stored === 'dark' ? stored : 'system');
    } catch { /* private mode — leave 'system' */ }
  }, []);

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg(null), 2500);
  }, []);

  const patch = useCallback((p: Partial<SettingsDto>) => {
    setS((cur) => (cur ? { ...cur, ...p } : cur));
    setDirty(true);
  }, []);

  // Theme applies instantly — it's a local preference, not a server setting,
  // so it deliberately bypasses the Save button.
  const applyTheme = useCallback((t: ThemeChoice) => {
    setTheme(t);
    try {
      if (t === 'system') {
        window.localStorage.removeItem(THEME_KEY);
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      } else {
        window.localStorage.setItem(THEME_KEY, t);
        document.documentElement.setAttribute('data-theme', t);
      }
    } catch { /* private mode */ }
  }, []);

  async function save() {
    if (!s) return;
    setSaving(true);
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
      // Server may have clamped values — reflect what actually stuck.
      setS(j.settings);
      setDirty(false);
      flash('ok', 'Saved');
    } catch (e: any) {
      flash('err', `${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }

  async function testWebhook() {
    setTesting(true);
    try {
      // Test what's SAVED — that's what the runner will use. Nudge the user
      // if they typed a URL but haven't saved it yet.
      if (dirty) { flash('err', 'Save first — the test uses the saved URL'); return; }
      const r = await fetch('/api/settings/test-notification', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      flash('ok', 'Test notification sent — check the receiver');
    } catch (e: any) {
      flash('err', `${e?.message ?? e}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <Header
        title="Settings"
        subtitle="Workspace preferences, request timeouts, and run notifications"
        right={
          <div className="flex items-center gap-2">
            {msg ? (
              <span className={cn('text-xs font-medium', msg.kind === 'err' ? 'text-red-600' : 'text-emerald-600')}>{msg.text}</span>
            ) : dirty ? (
              <span className="text-xs text-amber-700">Unsaved changes</span>
            ) : null}
            <Button size="sm" onClick={save} disabled={saving || !dirty || !s}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        }
      />
      <main className="p-5 space-y-4 max-w-3xl">
        {/* ── Appearance ── */}
        <Card>
          <CardHeader><CardTitle>Appearance</CardTitle></CardHeader>
          <CardBody>
            <Kicker className="mb-2">Theme</Kicker>
            <div className="flex gap-2">
              {([
                { v: 'light' as const, label: 'Light', icon: Sun },
                { v: 'dark' as const, label: 'Dark', icon: Moon },
                { v: 'system' as const, label: 'System', icon: Monitor },
              ]).map(({ v, label, icon: Icon }) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => applyTheme(v)}
                  aria-pressed={theme === v}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
                    theme === v
                      ? 'border-primary-500 bg-primary-50 text-primary-700'
                      : 'border-line-strong bg-surface text-slate-600 hover:border-slate-400 hover:text-slate-900',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />{label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] font-light text-slate-500">
              Applies immediately, per browser. The moon/sun button in the sidebar flips between light and dark;
              choosing System here follows the OS preference instead.
            </p>
          </CardBody>
        </Card>

        {/* ── Timeouts & polling ── */}
        <Card>
          <CardHeader><CardTitle>Timeouts &amp; polling</CardTitle></CardHeader>
          <CardBody>
            {!s ? (
              <div className="text-[13px] text-slate-500">Loading…</div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <SecondsField
                  label="UESIM GET timeout" hint="reads: testcases, simulators, status"
                  ms={s.uesimGetTimeoutMs} onMs={(v) => patch({ uesimGetTimeoutMs: v })}
                />
                <SecondsField
                  label="UESIM POST timeout" hint="writes: execution start legitimately runs long"
                  ms={s.uesimPostTimeoutMs} onMs={(v) => patch({ uesimPostTimeoutMs: v })}
                />
                <SecondsField
                  label="Run poll interval" hint="how often the runner polls execution status"
                  ms={s.runnerPollIntervalMs} onMs={(v) => patch({ runnerPollIntervalMs: v })}
                />
                <SecondsField
                  label="Completion grace" hint="extra wait after the testcase's configured duration" minutes
                  ms={s.runnerCompletionGraceMs} onMs={(v) => patch({ runnerCompletionGraceMs: v })}
                />
              </div>
            )}
            <p className="mt-3 text-[11px] font-light text-slate-500">
              Out-of-range values are clamped on save. Per-run options passed by a page still win over these defaults.
            </p>
          </CardBody>
        </Card>

        {/* ── Notifications ── */}
        <Card>
          <CardHeader><CardTitle>Run notifications</CardTitle></CardHeader>
          <CardBody>
            {!s ? (
              <div className="text-[13px] text-slate-500">Loading…</div>
            ) : (
              <div className="space-y-3">
                <Field label="Webhook URL" hint="Slack-compatible payload ({text}) plus a structured run object. Leave empty to disable.">
                  <Input
                    value={s.notifyWebhookUrl}
                    onChange={(e) => patch({ notifyWebhookUrl: e.target.value.trim() })}
                    placeholder="https://hooks.slack.com/services/…"
                  />
                </Field>
                <label className="flex items-center gap-2 text-[13px] text-slate-700">
                  <input
                    type="checkbox"
                    checked={s.notifyOnSuccess}
                    onChange={(e) => patch({ notifyOnSuccess: e.target.checked })}
                    className="h-4 w-4 rounded border-line-strong accent-[rgb(var(--c-primary-500))]"
                  />
                  Also notify when a run passes (failures always notify)
                </label>
                <div>
                  <Button size="sm" variant="secondary" onClick={testWebhook} disabled={testing || !s.notifyWebhookUrl}>
                    <Send className="h-3.5 w-3.5" />{testing ? 'Sending…' : 'Send test notification'}
                  </Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── Still on the roadmap ── */}
        <Card>
          <CardHeader><CardTitle>Coming up</CardTitle></CardHeader>
          <CardBody>
            <ul className="list-inside list-disc space-y-1 text-[13px] text-slate-600">
              <li>Per-user workspace (multi-user lab support)</li>
            </ul>
          </CardBody>
        </Card>
      </main>
    </>
  );
}

/** Numeric field edited in seconds (or minutes), stored in ms. */
function SecondsField({
  label, hint, ms, onMs, minutes = false,
}: {
  label: string; hint?: string; ms: number; onMs: (ms: number) => void; minutes?: boolean;
}) {
  const unit = minutes ? 60_000 : 1_000;
  const shown = Math.round((ms / unit) * 10) / 10;
  return (
    <Field label={`${label} (${minutes ? 'min' : 's'})`} hint={hint}>
      <Input
        type="number"
        min={0}
        step={minutes ? 0.5 : 1}
        value={String(shown)}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onMs(Math.round(n * unit));
        }}
      />
    </Field>
  );
}

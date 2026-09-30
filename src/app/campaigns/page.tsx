'use client';

// /campaigns — Test Campaigns.
//
// A campaign is a running order drawn from other suites: pick test cases out
// of Suite 1 and Suite 2, and they line up under one name. Nothing is copied —
// each row remembers the suite it came from, which is both what the list shows
// and where its configs are read from when it runs.
//
// The page keeps the two halves apart on purpose, because they happen at
// different times and mean different things:
//
//   Create   — which test cases, in what order.   No machines involved.
//   Run      — which Simnovator, which login, which callbox.  Chosen now.
//
// That is the point of a campaign: the suites were built on whatever setups
// their authors had, and the campaign runs wherever you say.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { statusLabel, verdictLabel, verdictClass, statusStyle } from '@/lib/automation/outcome';

interface SuiteItemRow { id: string; name: string; simnovatorTcId: string; callboxCfg?: string; mmeCfg?: string; imsCfg?: string; durationSec?: number }
interface SuiteRow { id: string; name: string; kind?: string; uesimSystemId?: string; callboxSystemId?: string; ueSystemId?: string; boxUserId?: string; items?: SuiteItemRow[] }
interface CampaignRow {
  id: string; name: string; createdBy?: string; createdAt: string;
  items: Array<SuiteItemRow & { sourceSuiteId: string; sourceSuiteName: string }>;
  lastUesimSystemId?: string; lastBoxUserId?: string; lastCallboxSystemId?: string; lastUeSystemId?: string;
}
interface SystemRow { id: string; type: string; host: string; name?: string }
interface BoxUser { id: string; username: string }
interface Progress { suiteId: string; suiteName: string; done: number; total: number; current?: string; statuses: Record<string, string>; finished?: boolean }

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [suites, setSuites] = useState<SuiteRow[]>([]);
  const [systems, setSystems] = useState<SystemRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  // ── creation ────────────────────────────────────────────────────────────
  const [building, setBuilding] = useState(false);
  const [newName, setNewName] = useState('');
  /** Picked test cases, as "<suiteId>|<itemId>", in the order they were ticked
   *  — which is the order they will execute in. */
  const [picked, setPicked] = useState<string[]>([]);

  // ── execution ───────────────────────────────────────────────────────────
  const [runFor, setRunFor] = useState<CampaignRow | null>(null);
  const [runSimnovator, setRunSimnovator] = useState('');
  const [runUser, setRunUser] = useState('');
  const [runCallbox, setRunCallbox] = useState('');
  const [runUe, setRunUe] = useState('');
  const [boxUsers, setBoxUsers] = useState<BoxUser[]>([]);
  const [running, setRunning] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, s, inv] = await Promise.all([
        fetch('/api/automation/campaigns').then(r => r.json()),
        fetch('/api/automation/suites').then(r => r.json()),
        fetch('/api/inventory').then(r => r.json()),
      ]);
      if (c?.ok) setCampaigns(c.campaigns ?? []);
      if (s?.ok) setSuites(s.suites ?? []);
      setSystems(((inv?.inventory ?? inv)?.systems ?? []) as SystemRow[]);
    } catch (e: any) { setError(e?.message ?? String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const hostOf = useCallback((id?: string) => systems.find(s => s.id === id)?.host ?? '', [systems]);
  const simnovators = useMemo(() => systems.filter(s => /SIMNOVATOR/i.test(s.type)), [systems]);
  const callboxes = useMemo(() => systems.filter(s => s.type === 'CALLBOX'), [systems]);
  const ueBoxes = useMemo(() => systems.filter(s => /UESIM|^UE$/i.test(s.type)), [systems]);

  // The logins registered on whichever Simnovator the run dialog is pointed at
  // — a campaign executes as one of them, chosen here, not as whoever built
  // the suites it draws from.
  useEffect(() => {
    if (!runSimnovator) { setBoxUsers([]); setRunUser(''); return; }
    let cancelled = false;
    fetch(`/api/box-users?systemId=${encodeURIComponent(runSimnovator)}`)
      .then(r => r.json())
      .then(j => {
        if (cancelled || !j?.ok) return;
        const us = (j.users ?? []) as BoxUser[];
        setBoxUsers(us);
        setRunUser(prev => (us.some(u => u.username === prev || u.id === prev) ? prev : (us[0]?.username ?? '')));
      })
      .catch(() => { /* one login, or the box is unreachable */ });
    return () => { cancelled = true; };
  }, [runSimnovator]);

  // Live progress while a campaign runs, and re-attach after a refresh.
  useEffect(() => {
    if (!running) { setProgress(null); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/automation/campaigns/${running}/progress`).then(r => r.json());
        if (cancelled) return;
        if (r?.progress) setProgress(r.progress);
        if (r?.ok && !r.running) { setRunning(''); void load(); }
      } catch { /* transient */ }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [running, load]);

  useEffect(() => {
    if (running || campaigns.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const c of campaigns) {
        try {
          const r = await fetch(`/api/automation/campaigns/${c.id}/progress`).then(r => r.json());
          if (cancelled) return;
          if (r?.ok && r.running && r.progress) { setProgress(r.progress); setRunning(c.id); return; }
        } catch { /* skip */ }
      }
    })();
    return () => { cancelled = true; };
  }, [campaigns, running]);

  const key = (suiteId: string, itemId: string) => `${suiteId}|${itemId}`;
  const togglePick = (suiteId: string, itemId: string) => {
    const k = key(suiteId, itemId);
    setPicked(p => (p.includes(k) ? p.filter(x => x !== k) : [...p, k]));
  };

  const createCampaign = async () => {
    const name = newName.trim();
    if (!name || picked.length === 0) return;
    setBusy('create'); setError('');
    try {
      const picks = picked.map(k => { const [suiteId, itemId] = k.split('|'); return { suiteId, itemId }; });
      const r = await fetch('/api/automation/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, picks }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setBuilding(false); setNewName(''); setPicked([]);
      await load();
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  const openRun = (c: CampaignRow) => {
    setRunFor(c);
    // Open on wherever it ran last — a starting point, never a binding.
    setRunSimnovator(c.lastUesimSystemId ?? '');
    setRunCallbox(c.lastCallboxSystemId ?? '');
    setRunUe(c.lastUeSystemId ?? '');
  };

  const execute = async () => {
    if (!runFor || !runSimnovator) return;
    const c = runFor;
    setRunFor(null); setRunning(c.id); setError('');
    try {
      const r = await fetch(`/api/automation/campaigns/${c.id}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uesimSystemId: runSimnovator,
          boxUserId: runUser || undefined,
          callboxSystemId: runCallbox || undefined,
          ueSystemId: runUe || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      await load();
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setRunning(''); }
  };

  const stop = async (c: CampaignRow) => {
    if (!window.confirm(`Stop "${c.name}"?\n\nThe running test case is stopped and the remaining ones are skipped.`)) return;
    try {
      await fetch(`/api/automation/campaigns/${c.id}/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uesimSystemId: runSimnovator || c.lastUesimSystemId, boxUserId: runUser || c.lastBoxUserId }),
      });
    } catch (e: any) { setError(e?.message ?? String(e)); }
  };

  const remove = async (c: CampaignRow) => {
    if (!window.confirm(`Delete campaign "${c.name}"?\n\nThe suites its test cases came from are not touched.`)) return;
    setBusy('delete');
    try {
      await fetch(`/api/automation/campaigns/${c.id}`, { method: 'DELETE' });
      await load();
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  /** What a row shows while a campaign is running, and after it has run. */
  const rowStatus = (c: CampaignRow, itemName: string) => {
    const live = progress && progress.suiteId === c.id ? progress.statuses?.[itemName] : undefined;
    if (live === 'running') return { st: statusLabel({ running: true }), vd: '' };
    if (live === 'passed') return { st: statusLabel({ ok: true, boxStatus: 'Completed', verdict: 'PASS' }), vd: verdictLabel({ ok: true, verdict: 'PASS' }) };
    if (live === 'failed') return { st: statusLabel({ ok: false }), vd: verdictLabel({ ok: false }) };
    if (live === 'skipped') return { st: statusLabel({ neverRun: true }), vd: '' };
    return { st: statusLabel({ neverRun: true }), vd: '' };
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Test Campaigns</h1>
          <p className="text-sm text-slate-600 mt-1">
            Build a running order from test cases in existing suites, then execute it on any Simnovator, as any user.
          </p>
        </header>

        {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}

        {progress && (
          <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2">
            <div className="flex items-baseline justify-between text-xs text-blue-900 gap-3">
              <span className="font-semibold">Running Campaign · {progress.suiteName}</span>
              <span>{Math.round((progress.done / Math.max(1, progress.total)) * 100)}%</span>
            </div>
            <div className="mt-1 h-2 w-full rounded bg-blue-100 overflow-hidden">
              <div className="h-full bg-blue-600 transition-all duration-500"
                style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
            </div>
            <div className="mt-1 text-[11px] text-blue-900">
              Test Case {Math.min(progress.done + 1, progress.total)} of {progress.total}
              {progress.current && <span className="font-mono"> · {progress.current}</span>}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-slate-900">Campaigns ({campaigns.length})</h2>
          <button onClick={() => setBuilding(b => !b)}
            className="rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-1.5">
            {building ? 'Cancel' : '+ Create Campaign'}
          </button>
        </div>

        {/* ── Create: test cases only. No machines are chosen here. ───────── */}
        {building && (
          <section className="bg-surface border border-line rounded-lg p-4 mb-6">
            <label className="block text-xs text-slate-600 mb-3">
              Campaign name
              <input value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Nightly regression"
                className="mt-1 w-full max-w-sm border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
            </label>

            <div className="text-xs font-semibold text-slate-700 mb-1">
              Test cases ({picked.length} selected)
            </div>
            <p className="text-[11px] text-slate-500 mb-2">
              Tick test cases from any suite. They execute in the order you tick them. The suites
              themselves are not changed, and the setup they were built on does not follow them here.
            </p>

            <div className="space-y-3 max-h-[26rem] overflow-y-auto pr-1">
              {suites.length === 0 && <p className="text-xs text-slate-500">No suites to draw from yet.</p>}
              {suites.map(s => (
                <div key={s.id} className="border border-line rounded-md">
                  <div className="px-3 py-2 border-b border-line flex items-baseline gap-2">
                    <span className="text-sm font-medium text-slate-800">{s.name}</span>
                    <span className="text-[11px] text-slate-500 font-mono">{hostOf(s.uesimSystemId)}</span>
                    <span className="text-[11px] text-slate-400">{(s.items ?? []).length} test cases</span>
                  </div>
                  {(s.items ?? []).length === 0 ? (
                    <p className="px-3 py-2 text-[11px] text-slate-400">no test cases</p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {(s.items ?? []).map(it => {
                        const k = key(s.id, it.id);
                        const at = picked.indexOf(k);
                        return (
                          <li key={it.id} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                            <input type="checkbox" checked={at >= 0} onChange={() => togglePick(s.id, it.id)} />
                            <span className="text-slate-800 truncate" title={it.name}>{it.name}</span>
                            {at >= 0 && <span className="ml-auto text-[10px] text-blue-700 font-semibold">#{at + 1}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => { setBuilding(false); setPicked([]); setNewName(''); }}
                className="rounded-md border border-slate-300 hover:bg-slate-50 text-xs px-3 py-1.5">Cancel</button>
              <button onClick={createCampaign} disabled={!newName.trim() || picked.length === 0 || busy === 'create'}
                className="rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-xs font-semibold px-3 py-1.5">
                {busy === 'create' ? 'Creating…' : `Create Campaign (${picked.length})`}
              </button>
            </div>
          </section>
        )}

        {campaigns.length === 0 ? (
          <div className="border border-dashed border-line rounded-lg py-10 text-center">
            <p className="text-sm font-medium text-slate-700">No Campaigns</p>
            <p className="mt-1 text-xs text-slate-500">
              Create one by picking test cases from the suites you already have.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {campaigns.map(c => (
              <article key={c.id} className="border border-line rounded-lg bg-surface">
                <div className="px-4 py-3 border-b border-line flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-slate-900 truncate" title={c.name}>{c.name}</h3>
                  <span className="text-[11px] text-slate-500">{c.items.length} test cases</span>
                  {c.createdBy && <span className="text-[11px] text-slate-400">by {c.createdBy}</span>}
                  <div className="ml-auto flex items-center gap-2">
                    {running === c.id ? (
                      <button onClick={() => stop(c)}
                        className="rounded-md bg-red-600 hover:bg-red-700 text-white text-xs font-semibold px-3 py-1.5">⏹ Stop</button>
                    ) : (
                      <button onClick={() => openRun(c)}
                        className="rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-1.5">▶ Execute Campaign</button>
                    )}
                    <button onClick={() => remove(c)} disabled={!!busy}
                      className="rounded-md border border-red-300 text-red-600 hover:bg-red-50 text-xs px-3 py-1.5">Delete</button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-3 py-1.5 text-left w-10">#</th>
                        <th className="px-3 py-1.5 text-left">Source Suite</th>
                        <th className="px-3 py-1.5 text-left">Test Case</th>
                        <th className="px-3 py-1.5 text-left">gNB Configuration</th>
                        <th className="px-3 py-1.5 text-left">MME Configuration</th>
                        <th className="px-3 py-1.5 text-left">Status</th>
                        <th className="px-3 py-1.5 text-left">Verdict</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {c.items.map((it, i) => {
                        const { st, vd } = rowStatus(c, it.name);
                        const style = statusStyle(st);
                        return (
                          <tr key={it.id}>
                            <td className="px-3 py-1.5 text-slate-400">{i + 1}</td>
                            <td className="px-3 py-1.5 text-slate-600 truncate" title={it.sourceSuiteName}>{it.sourceSuiteName}</td>
                            <td className="px-3 py-1.5 font-medium text-slate-800 truncate" title={it.name}>{it.name}</td>
                            <td className="px-3 py-1.5 font-mono text-[11px] text-slate-600 truncate">{it.callboxCfg ?? '–'}</td>
                            <td className="px-3 py-1.5 font-mono text-[11px] text-slate-600 truncate">{it.mmeCfg ?? '–'}</td>
                            <td className={`px-3 py-1.5 whitespace-nowrap ${style.cls}`}>{style.dot} {st}</td>
                            <td className={`px-3 py-1.5 whitespace-nowrap ${verdictClass(vd as any)}`}>{vd || '–'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>
        )}

        {/* ── Run: machines only. Which test cases was settled at creation. ── */}
        {runFor && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
            onClick={() => setRunFor(null)}>
            <div className="bg-surface rounded-xl shadow-xl border border-line max-w-md w-full p-5"
              onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-semibold text-slate-900">Execute Campaign</h3>
              <p className="mt-1 text-sm text-slate-600">
                {runFor.name} — {runFor.items.length} test cases, in order.
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Choose where this runs. The suites these test cases came from were built on their own
                setups; this campaign runs on whatever you pick here, using each test case&apos;s saved
                configuration.
              </p>

              <label className="block mt-3 text-xs text-slate-600">
                Setup — Simnovator
                <select value={runSimnovator} onChange={e => setRunSimnovator(e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm">
                  <option value="">select a Simnovator…</option>
                  {simnovators.map(s => <option key={s.id} value={s.id}>{s.host}</option>)}
                </select>
              </label>

              <label className="block mt-2 text-xs text-slate-600">
                User
                <select value={runUser} onChange={e => setRunUser(e.target.value)}
                  disabled={boxUsers.length === 0}
                  className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm disabled:bg-slate-100">
                  {boxUsers.length === 0
                    ? <option value="">pick a Simnovator first</option>
                    : boxUsers.map(u => <option key={u.id} value={u.username}>{u.username}</option>)}
                </select>
              </label>

              <label className="block mt-2 text-xs text-slate-600">
                Callbox <span className="text-slate-400">(needed when the test cases bring up a radio)</span>
                <select value={runCallbox} onChange={e => setRunCallbox(e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm">
                  <option value="">none — UESIM only</option>
                  {callboxes.map(s => <option key={s.id} value={s.id}>{s.host}</option>)}
                </select>
              </label>

              <label className="block mt-2 text-xs text-slate-600">
                UE simulator <span className="text-slate-400">(for the attach check)</span>
                <select value={runUe} onChange={e => setRunUe(e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm">
                  <option value="">from the topology</option>
                  {ueBoxes.map(s => <option key={s.id} value={s.id}>{s.host}</option>)}
                </select>
              </label>

              <div className="mt-4 flex justify-end gap-2">
                <button onClick={() => setRunFor(null)}
                  className="rounded-md border border-slate-300 hover:bg-slate-50 text-sm px-4 py-2">Cancel</button>
                <button onClick={execute} disabled={!runSimnovator}
                  className="rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-sm font-semibold px-4 py-2">
                  ▶ Execute Campaign
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

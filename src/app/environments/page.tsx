// /environments — GOLD-config Environments + Auto-Create.
//
// Flow:
//   1. Upload a working GOLD-config testcase JSON → tool extracts the SITE
//      facts (RF plan, IMSI range, Ki, IPs) into an Environment draft.
//   2. Review + name + Save.
//   3. Pick an Environment + a scenario matrix (cell count, traffic,
//      features) → Preview the variant count → Generate. The tool creates
//      every testcase on the box; zero manual test creation.

'use client';

import { useEffect, useMemo, useState } from 'react';

interface EnvCell { cellType: string; band: string; duplexMode: string; bandwidthMhz?: number; rfCard: number; antennas: { dl: number; ul: number }; scs?: number; nrarfcn?: { dl: number; ssb: number }; earfcn?: { dl: number; ul?: number }; ntn?: boolean }
interface GoldTrafficProfile { dataType: string; subscriberGroup: number[]; direction?: string; protocol?: string; codec?: string }
interface EnvSite { rat: string; cells: EnvCell[]; imsiStart: number; imsiStride: number; algorithm: string; sharedKey: string; op?: string; opc?: string; plmn?: string[]; iperfServerIp?: string; pcscfIp?: string; voNRSupport?: boolean; trafficProfiles?: GoldTrafficProfile[] }
interface EnvDefaults { bandwidths?: number[]; ueCount?: number; antennas?: { dl: number; ul: number }; dataType?: string; mobility?: string; fading?: string }
interface EnvWarning { field: string; reason: string }
interface Environment { id: string; name: string; createdAt: string; sourceFilename: string; site: EnvSite; defaults: EnvDefaults; extractionWarnings?: EnvWarning[] }

interface SystemSummary { id: string; name: string; host: string }
interface Progress { startedAt: string; finishedAt?: string; total: number; done: number; created: number; failed: number; skipped: number; currentName?: string }
interface AutoResult { total: number; created: any[]; failures: any[]; skips: any[]; buildVersion?: string; targetHost: string }

const TRAFFIC_OPTIONS = ['as-gold', 'no_data', 'iperf-dl', 'iperf-ul', 'iperf-both', 'iperf-tcp', 'volte', 'vonr', 'ping'];

/** One subscriber group in the builder: its UE count + the traffic profiles
 *  that run concurrently on it. */
interface UeGroup { ueCount: number; traffic: string[] }


/** Parse a fetch Response as JSON, tolerating an empty or non-JSON body.
 *  A truncated/empty body is exactly what arrives when the simqa service is
 *  restarting (e.g. the Update pill) or a proxy/timeout cuts the response —
 *  calling Response.json() on that throws the cryptic "Unexpected end of
 *  JSON input". This surfaces a clear, actionable message instead. */
async function readJson(r: Response): Promise<any> {
  const text = await r.text();
  if (!text.trim()) {
    throw new Error(`server returned an empty response (HTTP ${r.status}) — it may be restarting; retry in a moment`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`server returned a non-JSON response (HTTP ${r.status}): ${snippet}`);
  }
}

/** Compact human summary of the GOLD's concurrent traffic mix. */
function trafficMixLabel(profiles?: GoldTrafficProfile[]): string {
  if (!profiles || !profiles.length) return '–';
  return profiles.map(p => {
    if (p.dataType === 'iperf') return `${p.protocol ?? 'udp'}-${p.direction ?? 'both'}`;
    return p.dataType;
  }).join(' + ');
}

export default function EnvironmentsPage() {
  const [systems, setSystems] = useState<SystemSummary[]>([]);
  const [systemId, setSystemId] = useState<string>('lab-uesim');
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [draft, setDraft] = useState<Environment | null>(null);
  const [selected, setSelected] = useState<Environment | null>(null);
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState<string>('');

  // Matrix state — one testcase per spec. Every control below is applied
  // directly to that single testcase; nothing fans out into variants.
  const [cellCount, setCellCount] = useState<number>(1);
  const [ueGroups, setUeGroups] = useState<UeGroup[]>([{ ueCount: 2, traffic: ['as-gold'] }]);
  const [ca, setCa] = useState(false);
  const [ho, setHo] = useState(false);
  const [slicing, setSlicing] = useState(false);
  const [ntn, setNtn] = useState(false);
  const [loop, setLoop] = useState(false);
  const [powerControl, setPowerControl] = useState(false);
  const [channel, setChannel] = useState<'off' | 'all' | 'mix'>('all');
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewSkips, setPreviewSkips] = useState<any[]>([]);

  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<AutoResult | null>(null);

  const loadEnvs = () => fetch('/api/environments').then(readJson).then(d => setEnvs(d.environments ?? [])).catch(() => {});
  useEffect(() => {
    fetch('/api/ui-tests/systems').then(readJson).then(d => {
      const list: SystemSummary[] = (d?.systems ?? []).map((s: any) => ({ id: s.id, name: s.name, host: s.host }));
      setSystems(list);
      if (list.find(s => s.id === 'lab-uesim')) setSystemId('lab-uesim');
    }).catch(() => {});
    loadEnvs();
  }, []);

  // Poll autocreate status.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await fetch('/api/environments/autocreate-status', { cache: 'no-store' });
        const d = await readJson(r);
        setProgress(d.progress); setResult(d.result);
      } catch { /* keep polling — empty body during a restart is expected */ }
      if (!stop) setTimeout(tick, 1500);
    };
    tick();
    return () => { stop = true; };
  }, []);

  const onUpload = async (file: File) => {
    setError(''); setBusy('upload'); setDraft(null);
    try {
      const text = await file.text();
      let json: any;
      try { json = JSON.parse(text); } catch { setError('file is not valid JSON'); setBusy(''); return; }
      const r = await fetch('/api/environments/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json, filename: file.name }) });
      const d = await readJson(r);
      if (!d.ok) { setError(d.error ?? 'parse failed'); setBusy(''); return; }
      setDraft({ ...d.draft, id: '', createdAt: '' });
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  const saveDraft = async () => {
    if (!draft) return;
    setError(''); setBusy('save');
    try {
      const r = await fetch('/api/environments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      const d = await readJson(r);
      if (!d.ok) { setError(d.error ?? 'save failed'); return; }
      setDraft(null); await loadEnvs(); setSelected(d.environment);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  const deleteEnv = async (id: string) => {
    if (!confirm('Delete this environment?')) return;
    await fetch(`/api/environments/${id}`, { method: 'DELETE' }).catch(() => {});
    if (selected?.id === id) setSelected(null);
    await loadEnvs();
  };

  // No `rat` field — the generated testcase always runs as the RAT the GOLD
  // was parsed as (expandMatrix falls back to defaultRatChoice).
  const matrixBody = () => ({
    cellCount,
    ueGroups,
    carrierAggregation: ca,
    handover: ho,
    networkSlicing: slicing,
    ntn,
    attachDetach: loop,
    powerControl,
    channel,
  });

  const doPreview = async () => {
    if (!selected) return;
    setError(''); setBusy('preview');
    try {
      const r = await fetch(`/api/environments/${selected.id}/autocreate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: true, matrix: matrixBody() }),
      });
      const d = await readJson(r);
      if (!d.ok) { setError(d.error ?? 'preview failed'); return; }
      setPreviewCount(d.count); setPreviewSkips(d.skipped ?? []);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  const doGenerate = async () => {
    if (!selected) return;
    if (!confirm(`Auto-create up to ${previewCount ?? '?'} testcase(s) on ${systemId} from environment "${selected.name}"?`)) return;
    setError(''); setBusy('generate'); setResult(null);
    try {
      const r = await fetch(`/api/environments/${selected.id}/autocreate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId, matrix: matrixBody() }),
      });
      const d = await readJson(r);
      if (!d.ok) setError(d.error ?? 'generate failed');
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  const running = !!progress && !progress.finishedAt;
  // Cell count is a single choice, not a sweep: picking 2 means "one testcase
  // with 2 cells". It used to accumulate ([1] + click 2 = [1,2]), which
  // produced a 1-cell AND a 2-cell testcase and read as a duplicate-creation bug.
  // (Every setter here invalidates the preview via the effect above.)
  const selectCellCount = (n: number) => setCellCount(n);
  const setGroupCount = (n: number) => setUeGroups(gs => n <= gs.length ? gs.slice(0, n)
    : [...gs, ...Array.from({ length: n - gs.length }, () => ({ ueCount: 2, traffic: ['as-gold'] }))]);
  const setGroupUeCount = (i: number, n: number) =>
    setUeGroups(gs => gs.map((g, j) => j === i ? { ...g, ueCount: Math.max(1, n) } : g));
  // Traffic is per group and additive: picking no_data AND vonr puts BOTH
  // profiles on that group inside one testcase (it used to make two testcases).
  const toggleGroupTraffic = (i: number, t: string) =>
    setUeGroups(gs => gs.map((g, j) => j === i
      ? { ...g, traffic: g.traffic.includes(t) ? g.traffic.filter(x => x !== t) : [...g.traffic, t] }
      : g));

  // Reset preview whenever the matrix changes.
  useEffect(() => { setPreviewCount(null); setPreviewSkips([]); }, [cellCount, ueGroups, ca, ho, slicing, ntn, loop, powerControl, channel, selected]);

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Auto Test Creation</h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload a GOLD JSON Configuration to generate test cases automatically.
          </p>
        </header>

        {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}

        {/* Upload */}
        <section className="bg-surface border border-line rounded-xl p-5 mb-6">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Upload GOLD JSON Configuration</h2>
          <label className="cursor-pointer inline-block rounded-md border border-slate-300 px-4 py-2 hover:bg-slate-50 text-sm">
            {busy === 'upload' ? 'Parsing…' : 'Choose a testcase JSON…'}
            <input type="file" accept=".json,application/json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
          </label>
          <span className="text-xs text-slate-500 ml-3">Upload a valid GOLD configuration JSON file.</span>

          {draft && (
            <div className="mt-4 border border-line rounded-md p-4 bg-slate-50/50">
              <div className="flex items-center gap-3 mb-3">
                <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} className="border border-slate-300 rounded-md px-3 py-1.5 text-sm flex-1" />
                <button onClick={saveDraft} disabled={!!busy} className="rounded-md bg-orange-500 hover:bg-orange-600 disabled:bg-slate-300 text-white text-sm px-4 py-1.5">Save environment</button>
                <button onClick={() => setDraft(null)} className="text-sm text-slate-500">Cancel</button>
              </div>
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div>
                  <div className="font-semibold text-slate-500 uppercase tracking-wider mb-1">Site</div>
                  <div>RAT: <b>{draft.site.rat}</b> · cells: {draft.site.cells.length} · IMSI start: {draft.site.imsiStart} · algo: {draft.site.algorithm}</div>
                  <div>Ki: <code>{(draft.site.sharedKey || '').slice(0, 12)}…</code>{draft.site.opc ? ` · OPc: ${draft.site.opc.slice(0,8)}…` : ''} · PLMN: {(draft.site.plmn ?? []).join(', ') || '–'}</div>
                  <div>iperf IP: {draft.site.iperfServerIp ?? '–'} · P-CSCF: {draft.site.pcscfIp ?? '–'} · VoNR: {String(draft.site.voNRSupport ?? false)}</div>
                  <div>traffic mix: <b className="text-slate-700">{trafficMixLabel(draft.site.trafficProfiles)}</b>{draft.site.trafficProfiles && draft.site.trafficProfiles.length > 1 ? ' (concurrent — use "as-GOLD")' : ''}</div>
                  <div className="mt-2">
                    {draft.site.cells.map((c, i) => (
                      <div key={i} className="font-mono text-[11px] text-slate-600">cell{i}: {c.cellType} {c.band} {c.duplexMode} bw={c.bandwidthMhz} rfCard={c.rfCard} {c.antennas.dl}×{c.antennas.ul}{c.scs ? ` scs${c.scs}` : ''}{c.ntn ? ' NTN' : ''}</div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="font-semibold text-slate-500 uppercase tracking-wider mb-1">Warnings</div>
                  {(draft.extractionWarnings && draft.extractionWarnings.length) ? (
                    <ul className="space-y-0.5 list-disc ml-4 text-amber-700">
                      {draft.extractionWarnings.map((w, i) => <li key={i}><code>{w.field}</code> — {w.reason}</li>)}
                    </ul>
                  ) : <div className="text-emerald-700">None — clean extraction.</div>}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Saved environments */}
        <section className="bg-surface border border-line rounded-xl p-5 mb-6">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Choose Environment ({envs.length})</h2>
          {envs.length === 0 ? <div className="text-sm text-slate-500">No environments yet — upload and Create Test case</div> : (
            <div className="flex flex-wrap gap-2">
              {envs.map(e => (
                <button key={e.id} onClick={() => setSelected(e)} className={`rounded-md border px-3 py-2 text-sm text-left ${selected?.id === e.id ? 'border-orange-500 bg-orange-50' : 'border-line hover:bg-slate-50'}`}>
                  <div className="font-medium">{e.name}</div>
                  <div className="text-[11px] text-slate-500 font-mono">{e.site.rat} · {e.site.cells.length}cell · {e.sourceFilename}</div>
                  <button onClick={ev => { ev.stopPropagation(); deleteEnv(e.id); }} className="text-[10px] text-red-600 hover:underline mt-0.5">delete</button>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Auto-create matrix */}
        {selected && (
          <section className="bg-surface border border-line rounded-xl p-5 mb-6">
            <h2 className="text-base font-semibold text-slate-900 mb-3">Auto-create matrix for <span className="text-orange-600">{selected.name}</span></h2>
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Cell count</div>
                  <div className="flex gap-2">{[1,2,3,4].map(n => <button key={n} onClick={() => selectCellCount(n)} className={`rounded-md border px-3 py-1 text-sm ${cellCount === n ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300'}`}>{n}</button>)}</div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">UE groups</div>
                  <div className="flex gap-2">{[1,2,3,4].map(n => <button key={n} onClick={() => setGroupCount(n)} className={`rounded-md border px-3 py-1 text-sm ${ueGroups.length === n ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300'}`}>{n}</button>)}</div>
                </div>
                {/* Per-group UE count + traffic. Several traffic types on one
                    group run concurrently inside the SAME testcase. */}
                <div className="space-y-2">
                  {ueGroups.map((g, i) => (
                    <div key={i} className="border border-line rounded-md p-2.5 bg-slate-50/50">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Group {i}</span>
                        <label className="flex items-center gap-1.5 ml-auto">
                          <span className="text-[11px] uppercase text-slate-500">UE count</span>
                          <input type="number" min={1} value={g.ueCount} onChange={e => setGroupUeCount(i, Number(e.target.value) || 1)} className="border border-slate-300 rounded px-2 py-1 w-[70px] text-sm" />
                        </label>
                      </div>
                      <div className="flex flex-wrap gap-1.5">{TRAFFIC_OPTIONS.map(t => (
                        <button key={t} onClick={() => toggleGroupTraffic(i, t)} className={`rounded-md border px-2 py-1 text-xs ${g.traffic.includes(t) ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 bg-surface'}`}>{t}</button>
                      ))}</div>
                      {g.traffic.length === 0 && <div className="text-[11px] text-red-600 mt-1">pick at least one traffic type</div>}
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Features (applied to the test case)</div>
                {([['Carrier Aggregation', ca, setCa], ['Handover', ho, setHo], ['Network Slicing', slicing, setSlicing], ['NTN', ntn, setNtn], ['Attach/Detach Loop', loop, setLoop], ['Power Control', powerControl, setPowerControl]] as const).map(([label, val, set]) => (
                  <label key={label} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={val} onChange={e => (set as any)(e.target.checked)} /><span>{label}</span></label>
                ))}
                <label className="flex items-center gap-2 text-sm"><span>Channel modelling</span>
                  <select value={channel} onChange={e => setChannel(e.target.value as any)} className="border border-slate-300 rounded px-2 py-1 text-sm">
                    <option value="all">enabled on all cells</option>
                    <option value="mix">mix per cell</option>
                    <option value="off">off (AWGN)</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="flex items-center gap-3 mt-4 pt-4 border-t border-slate-100">
              <label className="flex items-center gap-2 text-sm"><span className="text-[11px] uppercase text-slate-500">Target</span>
                <select value={systemId} onChange={e => setSystemId(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-sm">
                  {systems.map(s => <option key={s.id} value={s.id}>{s.id} — {s.name} ({s.host})</option>)}
                </select>
              </label>
              <button onClick={doPreview} disabled={!!busy} className="rounded-md border border-slate-300 hover:bg-slate-50 text-sm px-4 py-1.5">Preview</button>
              {/* Gated on a preview that actually yields a testcase — clicking
                  Generate on a rejected spec used to silently do nothing. */}
              <button onClick={doGenerate} disabled={!!busy || running || !previewCount} className="rounded-md bg-orange-500 hover:bg-orange-600 disabled:bg-slate-300 text-white text-sm font-medium px-4 py-1.5">{running ? 'Generating…' : 'Generate'}</button>
              {previewCount !== null && previewCount > 0 && <span className="text-sm text-slate-700"><b>{previewCount}</b> test case will be created</span>}
            </div>
            {/* A rejected spec builds NOTHING, so the conflicts are shown in
                full rather than folded into a <details> the user won't open. */}
            {previewCount === 0 && previewSkips.length > 0 && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2">
                <div className="text-sm font-semibold text-red-800">This combination can&apos;t be built — nothing will be created.</div>
                <ul className="mt-1 ml-4 list-disc text-sm text-red-700 space-y-0.5">
                  {previewSkips.map((s, i) => <li key={i}>{s.reason}</li>)}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* Progress + result */}
        {progress && (
          <section className="bg-surface border border-line rounded-xl p-5">
            <h2 className="text-base font-semibold text-slate-900 mb-3 flex items-center gap-2">Test Case Creation Status
              {running && <button onClick={() => fetch('/api/environments/autocreate-status', { method: 'POST' })} className="ml-auto text-xs rounded-md border border-slate-300 px-2 py-1">Abort</button>}
            </h2>
            <div className="text-sm text-slate-700 mb-2">{progress.done} / {progress.total} · {progress.created} created · {progress.failed} failed · {progress.skipped} skipped{running && progress.currentName ? ` · current: ${progress.currentName}` : ''}</div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-orange-500" style={{ width: `${progress.total ? (100 * progress.done / progress.total) : 0}%` }} /></div>
            {result && (
              <div className="mt-3 text-xs">
                <div className="text-slate-600 mb-1">Build {result.buildVersion ?? '?'} · {result.created.length} created · {result.failures.length} failed</div>
                {result.created.length > 0 && (
                  <details><summary className="cursor-pointer text-emerald-700">{result.created.length} created</summary>
                    <ul className="mt-1 ml-4 font-mono text-[11px] text-slate-600 space-y-0.5">{result.created.slice(0, 60).map((c: any, i: number) => <li key={i}>✓ {c.name}</li>)}</ul>
                  </details>
                )}
                {result.failures.length > 0 && (
                  <details className="mt-1"><summary className="cursor-pointer text-red-700">{result.failures.length} failed</summary>
                    <ul className="mt-1 ml-4 text-[11px] text-slate-600 space-y-0.5">{result.failures.slice(0, 30).map((f: any, i: number) => <li key={i}>✗ <span className="font-mono">{f.name}</span> · {f.step} {f.status}: {f.message}</li>)}</ul>
                  </details>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

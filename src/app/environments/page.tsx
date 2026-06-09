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

  // Matrix state
  const [cellCounts, setCellCounts] = useState<number[]>([1]);
  const [traffic, setTraffic] = useState<string[]>(['as-gold']);
  const [ca, setCa] = useState(false);
  const [ho, setHo] = useState(false);
  const [slicing, setSlicing] = useState(false);
  const [ntn, setNtn] = useState(false);
  const [loop, setLoop] = useState(false);
  const [powerControl, setPowerControl] = useState(false);
  const [channelMix, setChannelMix] = useState<'off' | 'all' | 'mix'>('off');
  const [derivation, setDerivation] = useState<'replicate' | 'distinct'>('distinct');
  const [ueCount, setUeCount] = useState<number>(2);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewSkips, setPreviewSkips] = useState<any[]>([]);

  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<AutoResult | null>(null);

  const loadEnvs = () => fetch('/api/environments').then(r => r.json()).then(d => setEnvs(d.environments ?? [])).catch(() => {});
  useEffect(() => {
    fetch('/api/ui-tests/systems').then(r => r.json()).then(d => {
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
        const d = await r.json();
        setProgress(d.progress); setResult(d.result);
      } catch { /* keep polling */ }
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
      const d = await r.json();
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
      const d = await r.json();
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

  const matrixBody = () => ({
    cellCounts,
    trafficTypes: traffic,
    carrierAggregation: ca ? [false, true] : [false],
    handover: ho ? [false, true] : [false],
    networkSlicing: slicing ? [false, true] : [false],
    ntn: ntn ? [false, true] : [false],
    attachDetach: loop ? [false, true] : [false],
    powerControl: powerControl ? [false, true] : [false],
    channelMix: [channelMix],
    cellDerivation: derivation,
    ueCount,
    maxVariants: 500,
  });

  const doPreview = async () => {
    if (!selected) return;
    setError(''); setBusy('preview');
    try {
      const r = await fetch(`/api/environments/${selected.id}/autocreate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: true, matrix: matrixBody() }),
      });
      const d = await r.json();
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
      const d = await r.json();
      if (!d.ok) setError(d.error ?? 'generate failed');
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(''); }
  };

  const running = !!progress && !progress.finishedAt;
  const toggleCellCount = (n: number) => setCellCounts(cc => cc.includes(n) ? cc.filter(x => x !== n) : [...cc, n].sort());
  const toggleTraffic = (t: string) => setTraffic(tt => tt.includes(t) ? tt.filter(x => x !== t) : [...tt, t]);

  // Reset preview whenever the matrix changes.
  useEffect(() => { setPreviewCount(null); setPreviewSkips([]); }, [cellCounts, traffic, ca, ho, slicing, ntn, loop, powerControl, channelMix, derivation, ueCount, selected]);

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Environments &amp; Auto-Create</h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload a working GOLD-config testcase JSON. The tool extracts the site facts (RF plan, IMSI range, keys, IPs)
            and auto-creates every testcase you select — zero manual test creation.
          </p>
        </header>

        {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}

        {/* Upload */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
          <h2 className="text-base font-semibold text-slate-900 mb-3">1 · Upload GOLD config</h2>
          <label className="cursor-pointer inline-block rounded-md border border-slate-300 px-4 py-2 hover:bg-slate-50 text-sm">
            {busy === 'upload' ? 'Parsing…' : 'Choose a testcase JSON…'}
            <input type="file" accept=".json,application/json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
          </label>
          <span className="text-xs text-slate-500 ml-3">Accepts a testcase export pack, a GET /v2/testcases/&lt;id&gt; response, or a bare testDefinition.</span>

          {draft && (
            <div className="mt-4 border border-slate-200 rounded-md p-4 bg-slate-50/50">
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
        <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
          <h2 className="text-base font-semibold text-slate-900 mb-3">2 · Pick an environment ({envs.length})</h2>
          {envs.length === 0 ? <div className="text-sm text-slate-500">No environments yet — upload + save one above.</div> : (
            <div className="flex flex-wrap gap-2">
              {envs.map(e => (
                <button key={e.id} onClick={() => setSelected(e)} className={`rounded-md border px-3 py-2 text-sm text-left ${selected?.id === e.id ? 'border-orange-500 bg-orange-50' : 'border-slate-200 hover:bg-slate-50'}`}>
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
          <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
            <h2 className="text-base font-semibold text-slate-900 mb-3">3 · Auto-create matrix for <span className="text-orange-600">{selected.name}</span></h2>
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Cell count</div>
                  <div className="flex gap-2">{[1,2,3,4].map(n => <button key={n} onClick={() => toggleCellCount(n)} className={`rounded-md border px-3 py-1 text-sm ${cellCounts.includes(n) ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300'}`}>{n}</button>)}</div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Traffic types</div>
                  <div className="flex flex-wrap gap-1.5">{TRAFFIC_OPTIONS.map(t => <button key={t} onClick={() => toggleTraffic(t)} className={`rounded-md border px-2 py-1 text-xs ${traffic.includes(t) ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300'}`}>{t}</button>)}</div>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <label className="flex items-center gap-1.5"><span className="text-[11px] uppercase text-slate-500">UE count</span><input type="number" min={1} value={ueCount} onChange={e => setUeCount(Math.max(1, Number(e.target.value) || 1))} className="border border-slate-300 rounded px-2 py-1 w-[70px] text-sm" /></label>
                  <label className="flex items-center gap-1.5"><span className="text-[11px] uppercase text-slate-500">Extra cells</span>
                    <select value={derivation} onChange={e => setDerivation(e.target.value as any)} className="border border-slate-300 rounded px-2 py-1 text-sm">
                      <option value="distinct">use GOLD's cells</option>
                      <option value="replicate">replicate cell 0</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Features (each adds on+off variants)</div>
                {([['Carrier Aggregation', ca, setCa], ['Handover', ho, setHo], ['Network Slicing', slicing, setSlicing], ['NTN', ntn, setNtn], ['Attach/Detach Loop', loop, setLoop], ['Power Control', powerControl, setPowerControl]] as const).map(([label, val, set]) => (
                  <label key={label} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={val} onChange={e => (set as any)(e.target.checked)} /><span>{label}</span></label>
                ))}
                <label className="flex items-center gap-2 text-sm"><span>Channel modelling</span>
                  <select value={channelMix} onChange={e => setChannelMix(e.target.value as any)} className="border border-slate-300 rounded px-2 py-1 text-sm">
                    <option value="off">off (AWGN)</option>
                    <option value="all">enabled on all cells</option>
                    <option value="mix">mix per cell</option>
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
              <button onClick={doGenerate} disabled={!!busy || running || previewCount === null} className="rounded-md bg-orange-500 hover:bg-orange-600 disabled:bg-slate-300 text-white text-sm font-medium px-4 py-1.5">{running ? 'Generating…' : 'Generate'}</button>
              {previewCount !== null && <span className="text-sm text-slate-700"><b>{previewCount}</b> variant{previewCount === 1 ? '' : 's'} will be created{previewSkips.length ? ` · ${previewSkips.length} skipped (invalid combos)` : ''}</span>}
            </div>
            {previewSkips.length > 0 && previewCount !== null && (
              <details className="mt-2 text-xs text-slate-500"><summary className="cursor-pointer">{previewSkips.length} skipped combos</summary>
                <ul className="mt-1 ml-4 list-disc space-y-0.5">{previewSkips.slice(0, 30).map((s, i) => <li key={i}><code>{s.id}</code> — {s.reason}</li>)}</ul>
              </details>
            )}
          </section>
        )}

        {/* Progress + result */}
        {progress && (
          <section className="bg-white border border-slate-200 rounded-xl p-5">
            <h2 className="text-base font-semibold text-slate-900 mb-3 flex items-center gap-2">Generation
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

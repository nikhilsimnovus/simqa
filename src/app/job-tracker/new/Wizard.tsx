'use client';

// The Create New Job wizard.
//
// Build → Playlist / Test Case → Resource Set → Review & Submit.
//
// The whole configuration is a DRAFT held in this component. Nothing is written
// to the server until Submit Job. That is the point: the wizard used to create
// a real job at Step 1 so the build install had somewhere to log, which meant
// every abandoned wizard left a half-configured row in the Job Tracker and the
// tracker stopped meaning "jobs that were actually submitted". Now a single
// POST /api/jobs/submit takes the finished draft, re-validates it, creates the
// job and starts it.
//
// A consequence worth keeping: every step stays editable until Submit, and
// Review is itself an editing surface — each row links back to the step that
// owns it, and it renders the same draft state those steps mutate, so a change
// shows up on Review immediately with no save step in between.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check, X, Loader2, ChevronLeft, ChevronRight, Play, AlertTriangle, Search, Plus, Pencil,
  FolderOpen, ExternalLink,
} from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui';
import type { ResourceCheckResult } from '@/lib/jobTracker/types';
import type { Playlist } from '@/lib/jobTracker/playlists';

interface Setup {
  systemId: string; name: string; host: string;
  profileId?: string; profileName?: string;
  ue?: { host: string; user: string; name: string };
  app?: { host: string; user: string; name: string };
  installable: boolean; problem?: string;
  cockpitUrl: string; installPreview: string;
}

type StepStatus = 'idle' | 'running' | 'ok' | 'failed';

const STEPS = [
  { n: 1, title: 'Build' },
  { n: 2, title: 'Playlist / Test Case' },
  { n: 3, title: 'Resource Set' },
  { n: 4, title: 'Review & Submit' },
];

/** Components a Simnovator build installs. The file for each is chosen on the
 *  Build step so the job records what was installed, not just which tarball it
 *  came from. */
const COMPONENTS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: 'ue',  label: 'UE',         placeholder: 'ue.cfg' },
  { key: 'enb', label: 'eNB / gNB',  placeholder: 'enb.cfg' },
  { key: 'mme', label: 'MME',        placeholder: 'mme.cfg' },
  { key: 'app', label: 'App Server', placeholder: 'app.cfg' },
];

function Stepper({ current, status, onGo }: { current: number; status: Record<number, StepStatus>; onGo: (n: number) => void }) {
  return (
    <ol className="flex items-center gap-2 md:gap-4 overflow-x-auto">
      {STEPS.map((s, i) => {
        const st = status[s.n] ?? 'idle';
        const active = current === s.n;
        const circle =
          st === 'ok'        ? 'bg-success-500 text-white border-success-500'
          : st === 'failed'  ? 'bg-red-600 text-white border-red-600'
          : st === 'running' ? 'bg-blue-600 text-white border-blue-600'
          : active           ? 'bg-white text-primary-700 border-primary-500'
                             : 'bg-white text-slate-400 border-slate-300';
        return (
          <li key={s.n} className="flex items-center gap-2 md:gap-4 shrink-0">
            {/* Steps are clickable. Nothing is committed until Submit, so
                jumping back to change one parameter must not mean walking the
                whole flow again. */}
            <button type="button" onClick={() => onGo(s.n)} className="flex items-center gap-2.5 group">
              <span className={'h-8 w-8 shrink-0 rounded-full border-2 flex items-center justify-center text-xs font-bold ' + circle}>
                {st === 'ok' ? <Check className="h-4 w-4" />
                  : st === 'failed' ? <X className="h-4 w-4" />
                  : st === 'running' ? <Loader2 className="h-4 w-4 animate-spin" />
                  : s.n}
              </span>
              <span className={'text-sm whitespace-nowrap group-hover:text-slate-900 ' + (active ? 'font-semibold text-slate-900' : 'text-slate-500')}>
                {s.title}
              </span>
            </button>
            {i < STEPS.length - 1 ? <span className="h-px w-6 md:w-12 bg-slate-200 shrink-0" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function NavButtons({
  onPrev, onNext, nextLabel = 'Next', nextDisabled, blockedReason, valid, children,
}: {
  onPrev?: () => void;
  /** null → not rendered at all (Review supplies its own Submit). */
  onNext?: (() => void) | null;
  nextLabel?: string;
  nextDisabled?: boolean;
  blockedReason?: string;
  /** Light green once the step validates. */
  valid?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 mt-6 pt-5 border-t border-slate-100">
      <button
        type="button" onClick={onPrev} disabled={!onPrev}
        className={
          'inline-flex items-center gap-1.5 h-10 px-4 rounded-lg text-sm font-medium border transition-colors ' +
          (!onPrev ? 'border-slate-200 text-slate-300 cursor-not-allowed' : 'border-slate-300 text-slate-700 hover:bg-slate-50')
        }
      >
        <ChevronLeft className="h-4 w-4" />Previous
      </button>
      <div className="flex items-center gap-3 min-w-0">
        {children}
        {blockedReason && nextDisabled ? <span className="text-xs text-slate-500 truncate max-w-[420px]">{blockedReason}</span> : null}
        {onNext !== null ? (
          <button
            type="button" onClick={onNext} disabled={nextDisabled || !onNext}
            className={
              'inline-flex items-center gap-1.5 h-10 px-5 rounded-lg text-sm font-semibold transition-colors shrink-0 ' +
              (nextDisabled ? 'bg-slate-300 text-white cursor-not-allowed'
                : valid ? 'bg-success-100 text-success-800 border border-success-300 hover:bg-success-200'
                : 'bg-orange-500 text-white hover:bg-orange-600')
            }
          >
            {nextLabel}<ChevronRight className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface BrowseFile { name: string; size: number; mtime: string }

/** Browse dialog: lists the real files for one component on whichever machine
 *  the topology says holds them. Selecting one fills the field.
 *
 *  It reports "no SSH credentials" as an explanation rather than an error,
 *  because that is an inventory gap the user can act on — and typing the name
 *  by hand still works, so Browse being unavailable must not block the step. */
function BrowseDialog({
  kind, label, setupHost, onPick, onClose,
}: { kind: string; label: string; setupHost: string; onPick: (name: string, dir?: string) => void; onClose: () => void }) {
  const [files, setFiles] = useState<BrowseFile[] | null>(null);
  const [info, setInfo] = useState<{ host?: string; dir?: string; error?: string }>({});
  const [q, setQ] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/browse?setupHost=${encodeURIComponent(setupHost)}&kind=${encodeURIComponent(kind)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setFiles(j?.files ?? []);
        setInfo({ host: j?.host, dir: j?.dir, error: j?.ok ? undefined : j?.error });
      })
      .catch((e) => { if (!cancelled) { setFiles([]); setInfo({ error: e?.message ?? String(e) }); } });
    return () => { cancelled = true; };
  }, [kind, setupHost]);

  const shown = (files ?? []).filter((f) => !q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl border border-slate-200 shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">{label}</div>
            <div className="text-[11px] text-slate-500 font-mono truncate">
              {info.host ? `${info.host}:${info.dir}` : setupHost}
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="h-4 w-4" /></button>
        </div>

        <div className="px-4 py-2 border-b border-slate-100">
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files…" className="w-full h-8 rounded border border-slate-300 pl-8 pr-2 text-xs" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {files === null ? (
            <div className="px-2 py-6 text-xs text-slate-500 flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Listing files…</div>
          ) : info.error ? (
            <div className="px-2 py-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded">{info.error}</div>
          ) : shown.length === 0 ? (
            <div className="px-2 py-6 text-xs text-slate-500">{q ? `No file matches “${q}”.` : 'No files in this directory.'}</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {shown.map((f) => (
                <li key={f.name}>
                  <button
                    type="button"
                    onClick={() => { onPick(f.name, info.dir); onClose(); }}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-slate-50 flex items-center gap-3"
                  >
                    <span className="font-mono text-[12px] text-slate-800 truncate flex-1">{f.name}</span>
                    <span className="text-[10px] text-slate-400 shrink-0">{(f.size / 1024).toFixed(1)} KB</span>
                    <span className="text-[10px] text-slate-400 shrink-0 w-32 text-right">{f.mtime}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** One Review row, with its own Edit link back to the step that owns it. */
function ReviewRow({ label, value, onEdit }: { label: string; value: React.ReactNode; onEdit: () => void }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="w-40 shrink-0 text-xs text-slate-500 pt-0.5">{label}</div>
      <div className="flex-1 min-w-0 text-sm text-slate-800">{value}</div>
      <button type="button" onClick={onEdit} className="shrink-0 inline-flex items-center gap-1 text-xs text-primary-700 hover:underline pt-0.5">
        <Pencil className="h-3 w-3" />Edit
      </button>
    </div>
  );
}

export function Wizard({ setups, playlists }: { setups: Setup[]; playlists: Playlist[] }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [err, setErr] = useState<string | null>(null);

  // ── Draft configuration. None of this reaches the server until Submit. ──
  const [skipBuild, setSkipBuild] = useState(false);
  const [buildUrl, setBuildUrl] = useState('');
  const [componentFiles, setComponentFiles] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'playlist' | 'testcase'>('playlist');
  const [playlistId, setPlaylistId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [setupHost, setSetupHost] = useState(setups.find((s) => s.installable)?.host ?? setups[0]?.host ?? '');

  // ── Fetched / derived ──
  const [catalogue, setCatalogue] = useState<string[] | null>(null);
  const [catalogueErr, setCatalogueErr] = useState<string | null>(null);
  const [plFilter, setPlFilter] = useState('');
  const [tcFilter, setTcFilter] = useState('');
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<ResourceCheckResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Which field's Browse dialog is open, if any. */
  const [browsing, setBrowsing] = useState<{ kind: string; label: string } | null>(null);

  const setup = setups.find((s) => s.host === setupHost);
  const playlist = playlists.find((p) => p.id === playlistId);

  // The station's catalogue drives both panels: which playlist entries are
  // runnable here, and the standalone test-case list.
  useEffect(() => {
    const sysId = setups.find((s) => s.host === setupHost)?.systemId;
    if (!sysId) return;
    let cancelled = false;
    setCatalogue(null); setCatalogueErr(null);
    fetch(`/api/testcases?systemId=${encodeURIComponent(sysId)}&limit=5000`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const names: string[] = (j?.items ?? j?.testcases ?? []).map((t: any) => String(t?.name ?? '')).filter(Boolean);
        if (names.length === 0 && j?.error) setCatalogueErr(String(j.error));
        setCatalogue(names);
      })
      .catch((e) => { if (!cancelled) { setCatalogue([]); setCatalogueErr(e?.message ?? String(e)); } });
    return () => { cancelled = true; };
  }, [setupHost, setups]);

  /** Unknown catalogue → assume present, so a station we cannot read does not
   *  strike out every testcase as missing. */
  const onStation = useCallback((name: string) => !catalogue || catalogue.includes(name), [catalogue]);
  const runnableOf = useCallback((p: Playlist) => p.testcases.filter(onStation), [onStation]);

  // Choosing a playlist pre-ticks everything runnable on this station, so the
  // common "run the whole thing" case stays one click.
  useEffect(() => {
    if (mode !== 'playlist') return;
    if (!playlist) { setPicked(new Set()); return; }
    setPicked(new Set(runnableOf(playlist)));
  }, [mode, playlistId, playlist, runnableOf]);

  // Switching to individual test cases drops the playlist and its selection —
  // carrying either over would silently run a playlist the user just left.
  useEffect(() => {
    if (mode === 'testcase') { setPicked(new Set()); setPlaylistId(''); }
  }, [mode]);

  const toggle = useCallback((t: string) => {
    setPicked((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
  }, []);

  const visiblePlaylists = useMemo(() => {
    const q = plFilter.trim().toLowerCase();
    return q ? playlists.filter((p) => `${p.name} ${p.description} ${p.rat}`.toLowerCase().includes(q)) : playlists;
  }, [playlists, plFilter]);

  const visibleTestcases = useMemo(() => {
    const all = catalogue ?? [];
    const q = tcFilter.trim().toLowerCase();
    const list = q ? all.filter((t) => t.toLowerCase().includes(q)) : all;
    // Bounded: a station can hold 800+ testcases and rendering them all makes
    // the panel unusable. The filter is how you reach the rest.
    return list.slice(0, 300);
  }, [catalogue, tcFilter]);

  // ── Per-step validation ──
  // Mirrors the server rule: an http(s) URL to download, or an absolute path to
  // a build already staged on the station (what Browse inserts).
  const buildRef = buildUrl.trim();
  const buildValid = skipBuild || (!!setup && (/^https?:\/\//i.test(buildRef) || buildRef.startsWith('/')));
  const selectionValid = picked.size > 0 && (mode === 'testcase' || !!playlistId);
  const resourceValid = !!check?.ok;

  const stepStatus: Record<number, StepStatus> = {
    1: buildValid ? 'ok' : 'idle',
    2: selectionValid ? 'ok' : 'idle',
    3: checking ? 'running' : check ? (check.ok ? 'ok' : 'failed') : 'idle',
    4: submitting ? 'running' : 'idle',
  };

  const runCheck = useCallback(async () => {
    if (!setupHost) return;
    setChecking(true); setErr(null); setCheck(null);
    try {
      const r = await fetch('/api/jobs/resource-check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupHost }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setCheck(d.check);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setChecking(false); }
  }, [setupHost]);

  // A resource check is evidence about one station at one moment. Changing the
  // station invalidates it rather than leaving it on screen describing a
  // different box.
  useEffect(() => { setCheck(null); }, [setupHost]);

  const submit = useCallback(async () => {
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch('/api/jobs/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setupHost, skipBuild,
          buildUrl: skipBuild ? undefined : buildUrl.trim(),
          componentFiles: Object.fromEntries(Object.entries(componentFiles).filter(([, v]) => v && v.trim())),
          mode,
          playlistId: mode === 'playlist' ? playlistId : undefined,
          testcases: mode === 'playlist' && playlist
            ? playlist.testcases.filter((t) => picked.has(t))
            : Array.from(picked),
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      // The job exists only now — go straight to it.
      router.push(`/job-tracker/${d.job.id}`);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setSubmitting(false);
    }
  }, [setupHost, skipBuild, buildUrl, componentFiles, mode, playlistId, playlist, picked, router]);

  const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm bg-white';
  const browseBtn = 'inline-flex items-center gap-1 shrink-0 px-2.5 rounded-lg border border-slate-300 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-50';
  const openBtn = 'inline-flex items-center gap-1 shrink-0 px-2.5 rounded-lg border border-slate-300 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-50';

  return (
    <div className="space-y-5">
      {browsing ? (
        <BrowseDialog
          kind={browsing.kind}
          label={browsing.label}
          setupHost={setupHost}
          onClose={() => setBrowsing(null)}
          onPick={(name, dir) => {
            // A browsed build is already ON the station, so the field takes its
            // absolute path there — not a bare filename, which nothing could
            // fetch. The submit route accepts either that or an http(s) URL,
            // and a path means "already staged, no download needed".
            if (browsing.kind === 'build') setBuildUrl(dir ? `${dir.replace(/\/$/, '')}/${name}` : name);
            else setComponentFiles((m) => ({ ...m, [browsing.kind]: name }));
          }}
        />
      ) : null}

      <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
        <Stepper current={step} status={stepStatus} onGo={setStep} />
      </div>

      {err ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
          <div className="text-sm text-red-800">{err}</div>
        </div>
      ) : null}

      {/* ── STEP 1 · BUILD ─────────────────────────────────────────── */}
      {step === 1 ? (
        <Card>
          <CardHeader><CardTitle>Step 1 · Build</CardTitle></CardHeader>
          <CardBody>
            {/* The SAME setupHost the Resource Set step owns — one piece of
                draft state, editable from either place. It is here because
                Browse lists files off this resource set's machines (UE configs
                from its UE server, eNB/MME from its callbox), so without it the
                Build step would be browsing whichever station happened to be
                the default. This is deliberately just the picker: the install
                command and topology block that used to sit here are gone, and
                the resolved hosts show inside the Browse dialog's header where
                they are actually needed. */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-800 mb-1.5">Resource set</label>
              <div className="flex items-center gap-2 flex-wrap">
                <select value={setupHost} onChange={(e) => setSetupHost(e.target.value)} className={inputCls + ' sm:w-auto sm:min-w-[280px]'}>
                  {setups.map((s) => (
                    <option key={s.systemId} value={s.host}>{s.host} — {s.name}{s.installable ? '' : ' (not installable)'}</option>
                  ))}
                </select>
                {setup?.ue || setup?.app ? (
                  <span className="text-[11px] text-slate-500">
                    Browse reads from UE <span className="font-mono text-slate-700">{setup.ue?.host ?? '—'}</span>
                    {' · '}App <span className="font-mono text-slate-700">{setup.app?.host ?? '—'}</span>
                  </span>
                ) : null}
              </div>
            </div>

            <div className={skipBuild ? 'opacity-40 pointer-events-none' : ''}>
              <label className="block text-sm font-medium text-slate-800 mb-1.5">Add / Select Build</label>
              <div className="flex items-stretch gap-2">
                <input
                  value={buildUrl} onChange={(e) => setBuildUrl(e.target.value)} disabled={skipBuild}
                  placeholder="http://<build-host>/path/Simnovator-4.0.0_2608112025.tar.gz"
                  spellCheck={false}
                  className="flex-1 min-w-0 h-11 rounded-lg border border-slate-300 px-3.5 text-sm font-mono"
                />
                <button type="button" onClick={() => setBrowsing({ kind: 'build', label: 'Builds on the station' })} className={browseBtn}>
                  <FolderOpen className="h-3.5 w-3.5" />Browse
                </button>
                {/* Open verifies by eye that the URL actually serves something —
                    a typo in a build path otherwise surfaces minutes into the
                    install, on the station, in someone else's terminal. */}
                <a
                  href={/^https?:\/\//i.test(buildUrl.trim()) ? buildUrl.trim() : undefined}
                  target="_blank" rel="noreferrer"
                  aria-disabled={!/^https?:\/\//i.test(buildUrl.trim())}
                  className={openBtn + (/^https?:\/\//i.test(buildUrl.trim()) ? '' : ' opacity-40 pointer-events-none')}
                >
                  <ExternalLink className="h-3.5 w-3.5" />Open
                </a>
              </div>

              <div className="mt-4">
                <div className="text-sm font-medium text-slate-800">Components to install</div>
                {/* SimQA cannot open a remote tarball to enumerate what is
                    inside it: that would mean downloading the whole build here,
                    and there is no SSH credential to list it on the station
                    either (inventory carries none). So the components are named
                    and the file for each is entered, with the conventional name
                    shown as a placeholder. Blank installs that component's own
                    default. Pretending to have read the archive would be worse
                    than asking. */}
                <p className="text-xs text-slate-500 mt-0.5 mb-2">
                  Name the file to install for each component. Leave blank to use the build&rsquo;s own default.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {COMPONENTS.map((c) => (
                    <div key={c.key}>
                      <span className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">{c.label}</span>
                      <div className="flex items-stretch gap-1.5">
                        <input
                          value={componentFiles[c.key] ?? ''}
                          onChange={(e) => setComponentFiles((m) => ({ ...m, [c.key]: e.target.value }))}
                          placeholder={c.placeholder}
                          spellCheck={false}
                          className={inputCls + ' font-mono flex-1 min-w-0'}
                        />
                        <button
                          type="button"
                          onClick={() => setBrowsing({ kind: c.key, label: `${c.label} files` })}
                          className={browseBtn}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />Browse
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* The checkbox moved to the footer, so what it MEANS has to appear
                somewhere once ticked — a greyed-out form with no explanation
                reads as broken rather than deliberate. */}
            {skipBuild ? (
              <div className="mt-3 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                Skipping the build — this job runs against whatever is already installed on the station. Nothing is downloaded or installed.
              </div>
            ) : null}

            {/* Skip Build sits in the footer, beside Next, because it is the
                other way to complete this step — not a setting you read before
                filling the form in. Above the fields it invited ticking first
                and then wondering why everything had greyed out. */}
            <NavButtons
              onNext={() => setStep(2)}
              nextDisabled={!buildValid}
              valid={buildValid}
              blockedReason="Add a build URL (or browse one already on the station), or tick Skip Build."
            >
              <label className="flex items-center gap-2 cursor-pointer select-none shrink-0" title="Run against the build already installed on the station. Nothing is downloaded or installed.">
                <input type="checkbox" checked={skipBuild} onChange={(e) => setSkipBuild(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
                <span className="text-xs font-medium text-slate-700">Skip Build</span>
              </label>
            </NavButtons>
          </CardBody>
        </Card>
      ) : null}

      {/* ── STEP 2 · PLAYLIST / TEST CASE ──────────────────────────── */}
      {step === 2 ? (
        <Card>
          <CardHeader><CardTitle>Step 2 · Playlist / Test Case</CardTitle></CardHeader>
          <CardBody>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
                {(['playlist', 'testcase'] as const).map((m) => (
                  <button
                    key={m} type="button" onClick={() => setMode(m)}
                    className={'px-3 h-8 text-xs font-medium ' + (mode === m ? 'bg-primary-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50')}
                  >
                    {m === 'playlist' ? 'Playlist' : 'Individual Test Cases'}
                  </button>
                ))}
              </div>
              <span className="text-xs text-slate-400">
                {catalogue === null ? 'Reading the station catalogue…'
                  : catalogueErr ? `Catalogue unavailable: ${catalogueErr}`
                  : `${catalogue.length} test cases on ${setupHost}`}
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {/* ── Playlist panel ── */}
              <div className={'rounded-lg border p-3 ' + (mode === 'playlist' ? 'border-slate-300' : 'border-slate-200 opacity-50')}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-sm font-medium text-slate-800">Playlist</div>
                  <div className="relative">
                    <Search className="h-3 w-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
                    <input
                      value={plFilter} onChange={(e) => setPlFilter(e.target.value)} placeholder="Filter…"
                      disabled={mode !== 'playlist'}
                      className="h-7 w-36 rounded border border-slate-300 pl-6 pr-2 text-[11px]"
                    />
                  </div>
                </div>
                <ul className="space-y-1.5 max-h-[420px] overflow-y-auto">
                  {visiblePlaylists.map((p) => {
                    const sel = mode === 'playlist' && p.id === playlistId;
                    const missing = p.testcases.filter((t) => !onStation(t));
                    return (
                      <li key={p.id}>
                        <div
                          role="button" tabIndex={mode === 'playlist' ? 0 : -1}
                          onClick={() => { if (mode === 'playlist') setPlaylistId(p.id); }}
                          onKeyDown={(e) => { if (mode === 'playlist' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setPlaylistId(p.id); } }}
                          className={'block rounded-lg border p-2.5 transition-colors cursor-pointer ' +
                            (sel ? 'border-primary-500 bg-primary-50' : 'border-slate-200 hover:bg-slate-50')}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[13px] font-medium text-slate-900">{p.name}</span>
                            <span className="text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 bg-slate-100 text-slate-600">{p.rat}</span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5">{p.description}</div>
                          {sel ? (
                            <ul className="mt-2 space-y-0.5">
                              {p.testcases.map((t) => {
                                const gone = !onStation(t);
                                const on = picked.has(t);
                                return (
                                  <li key={t}>
                                    <label
                                      onClick={(e) => e.stopPropagation()}
                                      className={'flex items-center gap-1.5 text-[12px] font-mono rounded px-1 -mx-1 ' +
                                        (gone ? 'text-red-600 line-through cursor-not-allowed' : 'text-slate-700 cursor-pointer hover:bg-white')}
                                      title={gone ? `Not on ${setupHost}` : undefined}
                                    >
                                      <input
                                        type="checkbox" checked={on} disabled={gone}
                                        onChange={() => toggle(t)}
                                        className="h-3 w-3 shrink-0"
                                      />
                                      <span className="truncate">{t}</span>
                                    </label>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : (
                            <div className="text-[11px] text-slate-400 mt-1">
                              {p.testcases.length} test cases{missing.length ? ` · ${missing.length} not on this station` : ''}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                  {visiblePlaylists.length === 0 ? <li className="text-xs text-slate-400 px-1 py-2">No playlist matches “{plFilter}”.</li> : null}
                </ul>
              </div>

              {/* ── Test case panel ── */}
              <div className={'rounded-lg border p-3 ' + (mode === 'testcase' ? 'border-slate-300' : 'border-slate-200 opacity-50')}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-sm font-medium text-slate-800">Test Case</div>
                  <div className="relative">
                    <Search className="h-3 w-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
                    <input
                      value={tcFilter} onChange={(e) => setTcFilter(e.target.value)} placeholder="Filter…"
                      disabled={mode !== 'testcase'}
                      className="h-7 w-36 rounded border border-slate-300 pl-6 pr-2 text-[11px]"
                    />
                  </div>
                </div>
                {mode !== 'testcase' ? (
                  <p className="text-[11px] text-slate-400 px-1">
                    Switch to <span className="font-medium">Individual Test Cases</span> to run test cases without a playlist.
                  </p>
                ) : catalogue === null ? (
                  <div className="text-xs text-slate-500 px-1 py-2">Loading…</div>
                ) : (
                  <>
                    <ul className="space-y-0.5 max-h-[380px] overflow-y-auto">
                      {visibleTestcases.map((t) => (
                        <li key={t}>
                          <label className="flex items-center gap-1.5 text-[12px] font-mono text-slate-700 cursor-pointer rounded px-1 py-0.5 hover:bg-slate-50">
                            <input type="checkbox" checked={picked.has(t)} onChange={() => toggle(t)} className="h-3 w-3 shrink-0" />
                            <span className="truncate">{t}</span>
                          </label>
                        </li>
                      ))}
                      {visibleTestcases.length === 0 ? <li className="text-xs text-slate-400 px-1 py-2">No test case matches “{tcFilter}”.</li> : null}
                    </ul>
                    {(catalogue?.length ?? 0) > visibleTestcases.length ? (
                      <div className="text-[10px] text-slate-400 pt-1.5">
                        Showing {visibleTestcases.length} of {catalogue?.length} — use the filter to narrow.
                      </div>
                    ) : null}
                  </>
                )}
                {/* Test cases are authored on the Simnovator itself — SimQA has
                    no create form, and /testcases is a read-only list, so this
                    used to be a dead end. Points at the box's own Create Test
                    Case page instead. Opens in a new tab so the draft here
                    survives; come back, re-pick the station, and the new case
                    is in this list. */}
                <a
                  href={`http://${setupHost}/testcase/createtestcase`}
                  target="_blank" rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary-700 hover:underline"
                  title={`Create a test case on ${setupHost}`}
                >
                  <Plus className="h-3 w-3" />Create New Test Case on {setupHost}
                </a>
              </div>
            </div>

            <NavButtons
              onPrev={() => setStep(1)}
              onNext={() => setStep(3)}
              nextDisabled={!selectionValid}
              valid={selectionValid}
              blockedReason={mode === 'playlist' && !playlistId ? 'Select a playlist.' : 'Tick at least one test case.'}
            >
              <span className="text-xs text-slate-500">{picked.size} selected</span>
            </NavButtons>
          </CardBody>
        </Card>
      ) : null}

      {/* ── STEP 3 · RESOURCE SET ──────────────────────────────────── */}
      {step === 3 ? (
        <Card>
          <CardHeader><CardTitle>Step 3 · Resource Set</CardTitle></CardHeader>
          <CardBody>
            {/* Same value as the picker on the Build step. Changing it here
                re-reads the station's test-case catalogue and discards any
                resource check, since both describe a specific box. */}
            <label className="block text-sm font-medium text-slate-800 mb-1.5">Simnovator station</label>
            <select value={setupHost} onChange={(e) => setSetupHost(e.target.value)} className={inputCls}>
              {setups.map((s) => (
                <option key={s.systemId} value={s.host}>{s.host} — {s.name}{s.installable ? '' : ' (not installable)'}</option>
              ))}
            </select>
            {setup ? (
              <div className="mt-2 text-xs text-slate-500">
                {setup.installable
                  ? <>UE <span className="font-mono text-slate-700">{setup.ue?.host}</span> · App server <span className="font-mono text-slate-700">{setup.app?.host}</span>{setup.profileName ? ` · profile “${setup.profileName}”` : ''}</>
                  : <span className="text-red-700">{setup.problem}</span>}
              </div>
            ) : null}

            <div className="mt-4 flex items-center gap-3 flex-wrap">
              <button
                type="button" onClick={runCheck} disabled={checking}
                className={'inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-sm font-semibold text-white ' + (checking ? 'bg-slate-300' : 'bg-primary-600 hover:bg-primary-700')}
              >
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {checking ? 'Checking…' : check ? 'Re-run check' : 'Run resource check'}
              </button>
              {check ? (
                <span className={'text-xs font-medium ' + (!check.ok ? 'text-red-700' : check.willQueue ? 'text-amber-700' : 'text-success-700')}>
                  {check.verdict}
                </span>
              ) : null}
            </div>

            {check ? (
              <ul className="mt-3 space-y-1">
                {check.items.map((it, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    <span className={'mt-1 h-1.5 w-1.5 rounded-full shrink-0 ' +
                      (it.status === 'ready' ? 'bg-success-500' : it.status === 'warning' ? 'bg-amber-500' : 'bg-red-500')} />
                    <span className="w-40 shrink-0 text-slate-700">{it.name}</span>
                    <span className={'flex-1 ' + (it.status === 'failed' ? 'text-red-700' : 'text-slate-500')}>{it.detail}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            <NavButtons
              onPrev={() => setStep(2)}
              onNext={() => setStep(4)}
              nextDisabled={!resourceValid}
              valid={resourceValid}
              blockedReason={check && !check.ok
                ? `Station not usable: ${(check.blockers ?? []).join(', ') || 'a blocking check failed'}.`
                : 'Run the resource check to continue.'}
            />
          </CardBody>
        </Card>
      ) : null}

      {/* ── STEP 4 · REVIEW & SUBMIT ───────────────────────────────── */}
      {step === 4 ? (
        <Card>
          <CardHeader><CardTitle>Step 4 · Review &amp; Submit</CardTitle></CardHeader>
          <CardBody>
            <p className="text-xs text-slate-500 mb-3">
              Nothing has been created yet. Edit anything below and come straight back — the job is created, given an
              id and added to the Job Tracker only when you press Submit Job.
            </p>

            <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 px-3">
              <ReviewRow label="Build" onEdit={() => setStep(1)} value={
                skipBuild
                  ? <span className="text-slate-600">Skip Build — using the build already on the station</span>
                  : <span className="font-mono text-[12px] break-all">{buildUrl || <span className="text-red-600 font-sans">not set</span>}</span>
              } />
              {!skipBuild ? COMPONENTS.map((c) => (
                <ReviewRow key={c.key} label={`${c.label} file`} onEdit={() => setStep(1)} value={
                  componentFiles[c.key]?.trim()
                    ? <span className="font-mono text-[12px]">{componentFiles[c.key]}</span>
                    : <span className="text-slate-400">build default</span>
                } />
              )) : null}
              <ReviewRow label="Mode" onEdit={() => setStep(2)} value={mode === 'playlist' ? 'Playlist' : 'Individual test cases'} />
              {mode === 'playlist' ? (
                <ReviewRow label="Playlist" onEdit={() => setStep(2)} value={playlist?.name ?? <span className="text-red-600">not set</span>} />
              ) : null}
              <ReviewRow label="Test cases" onEdit={() => setStep(2)} value={
                picked.size === 0 ? <span className="text-red-600">none selected</span> : (
                  <>
                    <div className="text-xs text-slate-500 mb-1">
                      {picked.size}{mode === 'playlist' && playlist && picked.size !== playlist.testcases.length ? ` of ${playlist.testcases.length}` : ''} selected
                    </div>
                    <ul className="space-y-0.5">
                      {(mode === 'playlist' && playlist ? playlist.testcases.filter((t) => picked.has(t)) : Array.from(picked)).map((t) => (
                        <li key={t} className="text-[12px] font-mono text-slate-700">· {t}</li>
                      ))}
                    </ul>
                  </>
                )
              } />
              <ReviewRow label="Resource set" onEdit={() => setStep(3)} value={
                <>
                  <span className="font-mono text-[12px]">{setupHost}</span>
                  {setup?.ue ? <span className="text-xs text-slate-500"> · UE {setup.ue.host} · App {setup.app?.host}</span> : null}
                </>
              } />
              <ReviewRow label="Resource check" onEdit={() => setStep(3)} value={
                !check
                  ? <span className="text-red-600">not run</span>
                  : <span className={!check.ok ? 'text-red-700' : check.willQueue ? 'text-amber-700' : 'text-success-700'}>{check.verdict}</span>
              } />
            </div>

            <NavButtons onPrev={() => setStep(3)} onNext={null}>
              <button
                type="button" onClick={submit}
                disabled={submitting || !buildValid || !selectionValid || !resourceValid}
                className={'inline-flex items-center gap-1.5 h-10 px-5 rounded-lg text-sm font-semibold text-white transition-colors ' +
                  (submitting || !buildValid || !selectionValid || !resourceValid ? 'bg-slate-300 cursor-not-allowed' : 'bg-success-600 hover:bg-success-700')}
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {submitting ? 'Submitting…' : 'Submit Job'}
              </button>
            </NavButtons>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

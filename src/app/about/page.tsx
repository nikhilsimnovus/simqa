'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  Activity, Beaker, MousePointerClick, ShieldCheck, GitCompare,
  Layers, Cpu, AlertTriangle, CheckCircle2,
  ArrowRight, ExternalLink, Workflow, Network, Clock, Sparkles,
} from 'lucide-react';

interface CatalogEntry {
  number: number;
  id: string;
  category: string;
  severity: 'critical' | 'normal' | 'optional';
}

// =============================================================================
// Layout adapted from h1b-insight-explorer.lovable.app (oversized hero, soft
// tone tiles, dot-grid texture) — but every colour goes through the Simnovus
// token classes in tailwind.config.ts. The original port hardcoded the
// Lovable light palette as inline rgb() styles, which made the page unreadable
// in the dark theme (near-black headings on the dark bg-surface cards).
// Tone mapping: indigo→primary(orange) · emerald→emerald · sky→blue ·
// amber→amber · red→red · muted→slate.
// =============================================================================

export default function AboutPage() {
  const [catalogCount, setCatalogCount] = useState<number | null>(null);
  const [byCategory, setByCategory] = useState<Record<string, number>>({});
  const [bySeverity, setBySeverity] = useState<Record<string, number>>({});
  const [systemsCount, setSystemsCount] = useState<number>(0);
  const [baselineCount, setBaselineCount] = useState<number>(0);

  useEffect(() => {
    fetch('/api/ui-tests/catalog').then((r) => r.json()).then((j: { tests: CatalogEntry[] }) => {
      setCatalogCount(j.tests.length);
      const byCat: Record<string, number> = {};
      const bySev: Record<string, number> = {};
      for (const t of j.tests) {
        byCat[t.category] = (byCat[t.category] ?? 0) + 1;
        bySev[t.severity] = (bySev[t.severity] ?? 0) + 1;
      }
      setByCategory(byCat);
      setBySeverity(bySev);
    }).catch(() => {});
    fetch('/api/ui-tests/systems').then((r) => r.json()).then((j) => setSystemsCount((j.systems ?? []).length)).catch(() => {});
    fetch('/api/ui-tests/baselines').then((r) => r.json()).then((j) => setBaselineCount((j.baselines ?? []).length)).catch(() => {});
  }, []);

  return (
    <>
      <Header
        title="About QA Ka BAAP"
        subtitle="Father of QA — automated QA for Simnovator UESIM. What it does, how it works, and what it has caught."
        right={
          <div className="flex items-center gap-2">
            <Link href="/ui-tests"><Button size="sm" className="!bg-emerald-600 hover:!bg-emerald-700 !border-emerald-600"><MousePointerClick className="h-4 w-4" />UI Tests</Button></Link>
            <Link href="/api-tests"><Button size="sm" variant="secondary"><Beaker className="h-4 w-4" />API Tests</Button></Link>
          </div>
        }
      />

      <main className="relative min-h-screen pb-12 bg-page text-slate-900">
        {/* Subtle grid background overlay (Lovable signature). --hero-grid is
            defined per-theme in globals.css, so the texture follows the theme. */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-[0.35]"
          style={{
            backgroundImage:
              'linear-gradient(to right, var(--hero-grid) 1px, transparent 1px), linear-gradient(to bottom, var(--hero-grid) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        {/* Soft fade so the grid doesn't extend infinitely. Built from the
            page token so it fades into whichever background is active. */}
        <div aria-hidden className="absolute inset-x-0 top-0 h-[600px] pointer-events-none" style={{ background: 'linear-gradient(rgb(var(--c-page) / 0), rgb(var(--c-page) / 0.85), rgb(var(--c-page)))' }} />

        <div className="relative p-6 space-y-8 max-w-6xl mx-auto">

        {/* ─────────── HERO ─────────── */}
        <section className="relative">
          {/* Inner glow / gradient ring (Lovable's signature touch) */}
          <div className="absolute -inset-1 rounded-3xl opacity-60 blur-2xl pointer-events-none"
            style={{ background: 'linear-gradient(120deg, rgb(var(--c-primary-500) / 0.18), rgb(var(--c-emerald-500) / 0.18), rgb(var(--c-blue-500) / 0.15))' }} />
          <div className="relative rounded-2xl bg-surface border border-line p-10">
            <div className="inline-flex items-center gap-1.5 mb-5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
              <Sparkles className="h-3 w-3" />Internal QA platform · v0.1
            </div>
            <h1 className="text-5xl sm:text-6xl font-extrabold leading-[1.05] tracking-tight text-slate-900">
              One QA tool for the entire <br/>
              <span className="bg-gradient-to-br from-primary-500 to-emerald-500 bg-clip-text text-transparent">
                Simnovator UESIM stack.
              </span>
            </h1>
            <p className="mt-6 text-lg leading-relaxed max-w-3xl text-slate-500">
              Every new build runs through an automated suite that drives the REST API, the management UI, and the
              field-level auto-populate logic against 3GPP-derived golden references. No manual click-through.
              Regressions surface as a one-page diff against the prior baseline.
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-10">
              <HeroStat label="UI tests" value={catalogCount ?? '…'} sub="Playwright-driven" tone="primary" />
              <HeroStat label="Categories" value={Object.keys(byCategory).length || '15'} sub="auth → field validation" tone="accent" />
              <HeroStat label="Real bugs filed" value="28+" sub="SIM40 tickets" tone="info" />
              <HeroStat label="Cross-browser" value="3" sub="Chrome · Edge · Firefox" tone="warning" />
            </div>
          </div>
        </section>

        {/* ─────────── PROBLEM / SOLUTION ─────────── */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SoftCard tone="destructive" icon={<AlertTriangle className="h-4 w-4" />} title="The problem">
            <p>Before QA Ka BAAP, every Simnovator build was QA'd by hand — engineers clicking through the UI, eyeballing testcase results, manually filing tickets when something looked off.</p>
            <ul className="list-disc list-inside space-y-1.5 mt-2 text-slate-500">
              <li>Regressions slipped through (no systematic comparison vs prior build)</li>
              <li>API-level bugs were invisible without dedicated probing</li>
              <li>Field auto-populate (band → ARFCN) had no spec-level verification</li>
              <li>Findings lived in heads, not tickets — hard to track what was fixed</li>
            </ul>
          </SoftCard>

          <SoftCard tone="accent" icon={<CheckCircle2 className="h-4 w-4" />} title="What QA Ka BAAP changes">
            <p>One Next.js app on a lab machine. Anyone in the team opens the URL in a browser, picks a profile, clicks Run. ~25 min later: a self-contained HTML report with screenshots, traces, and Jira-ready comments.</p>
            <ul className="list-disc list-inside space-y-1.5 mt-2 text-slate-500">
              <li>Save any run as a <strong>baseline</strong> → next run shows what regressed</li>
              <li>Tests are <strong>data-driven</strong> from 3GPP / vendor golden references</li>
              <li>Findings auto-link to SIM40 tickets with copy-paste Jira comments</li>
              <li>Multiple engineers test different boxes <strong>in parallel</strong></li>
            </ul>
          </SoftCard>
        </section>

        {/* ─────────── FEATURE TILES ─────────── */}
        <section>
          <SectionTitle eyebrow="Toolbox" title="Six things in one tool" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <FeatureTile icon={<Beaker className="h-5 w-5" />} tone="primary"
              title="API tests" count="50+"
              desc="Comprehensive REST suite covering every /v2/* endpoint. Catches silent data drop, broken DELETE, validation gaps, status-code semantics."
              href="/api-tests" />
            <FeatureTile icon={<MousePointerClick className="h-5 w-5" />} tone="accent"
              title="UI tests" count={catalogCount ? `${catalogCount}` : '…'}
              desc="Browser-driven via Playwright. Drives the real SPA at 192.168.1.95 — clicks, fills, navigates, captures screenshots, network logs, console errors."
              href="/ui-tests" />
            <FeatureTile icon={<Layers className="h-5 w-5" />} tone="warning"
              title="Field validation" count={byCategory['field-band'] ? `${byCategory['field-band']}` : '190'}
              desc="Data-driven from master-all-rats.json. Verifies band → ARFCN auto-populate against TS 38.104 / TS 36.101 across 95 NR/LTE/CAT-M/NB-IoT entries."
              href="/ui-tests" />
            <FeatureTile icon={<ShieldCheck className="h-5 w-5" />} tone="info"
              title="Build verification" count="4 dimensions"
              desc="Every executed testcase gets lifecycle / criteria / stats-sanity / cleanup checks. Catches PASS-with-zero-traffic and stuck-loading patterns."
              href="/runs" />
            <FeatureTile icon={<GitCompare className="h-5 w-5" />} tone="primary"
              title="Baseline diff" count={`${baselineCount} saved`}
              desc="Save any run as a named baseline (e.g. '4.0.0-260428'). Next run highlights regressions (PASS→FAIL), fixes (FAIL→PASS), still-failing."
              href="/ui-tests" />
            <FeatureTile icon={<Network className="h-5 w-5" />} tone="accent"
              title="Multi-user" count={`${systemsCount} systems`}
              desc="Per-host concurrency lock. Different engineers can test different boxes simultaneously. Same box queues."
              href="/ui-tests" />
          </div>
        </section>

        {/* ─────────── 3-LAYER MODEL ─────────── */}
        <section>
          <SectionTitle eyebrow="How field testing works" title="Three layers, three different bugs" />
          <div className="rounded-2xl bg-surface border border-line p-6">
            <p className="text-sm leading-relaxed max-w-3xl text-slate-500">
              For any field where the UI auto-populates based on user input (Band → ARFCN, PRACH → root index, TDD → slot pattern, etc.), QA Ka BAAP runs three independent layers.
              Each layer catches a different class of bug.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-6">
              <LayerCard num="L3" tone="accent" title="Spec verify" subtitle="Offline · <1ms"
                desc="Re-derives expected values from 3GPP formulas (TS 38.104 / TS 36.101). Catches bugs in the golden reference file itself."
                catches="Bad reference data" />
              <LayerCard num="L1" tone="primary" title="API verify" subtitle="REST · ~300ms each"
                desc="Hits /v2/band-info on the box. Asserts the API returns the golden values."
                catches="Backend logic regressions" />
              <LayerCard num="L2" tone="info" title="UI verify" subtitle="Browser · ~30s each"
                desc="Drives the SPA: picks band, reads auto-filled DL-ARFCN field, asserts equality."
                catches="Frontend / form-handler bugs" />
            </div>
            <div className="mt-5 text-xs text-slate-500">
              Result: a single regression is isolated to the right layer (golden / backend / frontend), not "something somewhere is broken".
            </div>
          </div>
        </section>

        {/* ─────────── COVERAGE BY THE NUMBERS ─────────── */}
        <section>
          <SectionTitle eyebrow="By the numbers" title="What's in the catalog right now" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-2xl bg-surface border border-line p-5">
              <h3 className="text-sm font-semibold mb-3 text-slate-900">By category</h3>
              <div className="space-y-1.5">
                {Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([cat, n]) => (
                  <div key={cat} className="flex items-center gap-3">
                    <span className="text-xs w-32 truncate text-slate-900">{prettyCategory(cat)}</span>
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-panel">
                      <div className="h-full rounded-full transition-all bg-gradient-to-r from-primary-500 to-emerald-500"
                        style={{ width: `${(n / Math.max(...Object.values(byCategory))) * 100}%` }} />
                    </div>
                    <span className="text-xs tabular-nums w-10 text-right text-slate-500">{n}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-surface border border-line p-5">
              <h3 className="text-sm font-semibold mb-3 text-slate-900">By severity</h3>
              <div className="grid grid-cols-3 gap-3">
                <SeverityTile label="Critical" tone="destructive" count={bySeverity.critical ?? 0} desc="must-pass for release" />
                <SeverityTile label="Normal"   tone="warning"     count={bySeverity.normal ?? 0}   desc="strong signal" />
                <SeverityTile label="Optional" tone="muted"       count={bySeverity.optional ?? 0} desc="nice-to-have" />
              </div>
              <div className="mt-4 pt-4 border-t border-line text-xs leading-relaxed text-slate-500">
                Run profiles let you scope to severity: <strong className="text-slate-900">Smoke</strong> (critical only, ~3 min), <strong className="text-slate-900">Regression</strong> (critical+normal, ~15 min), <strong className="text-slate-900">Full</strong> (everything, ~25 min).
              </div>
            </div>
          </div>
        </section>

        {/* ─────────── WORKFLOW ─────────── */}
        <section>
          <SectionTitle eyebrow="Workflow" title="When to run what" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <WorkflowStep when="On every commit" profile="Smoke" duration="~3 min" tone="accent"
              description="13 critical tests. Confirms login, basic page render, and the most-bitten regression patterns. Designed to fit in a feature-branch CI run." />
            <WorkflowStep when="Before merge to main" profile="Regression" duration="~15 min" tone="warning"
              description="83 critical+normal tests. Covers the SIM40 bug-pattern catalog. If this passes vs the prior baseline, the change is safe to ship." />
            <WorkflowStep when="On release candidate" profile="Full" duration="~25 min · 8 min parallel" tone="primary"
              description="All tests including optional ones. Run with concurrency=3 for ~3× speedup on parallel-safe categories. Save as baseline for the build." />
          </div>
        </section>

        {/* ─────────── REAL IMPACT ─────────── */}
        <section>
          <SectionTitle eyebrow="Impact" title="Real bugs already caught" />
          <div className="rounded-2xl bg-surface border border-line overflow-hidden">
            <div className="px-5 py-3 text-xs border-b border-line bg-panel text-slate-500">
              28+ real product bugs filed in SIM40 from QA Ka BAAP runs. A representative sample:
            </div>
            <ul className="divide-y divide-line">
              <BugRow ticket="SIM40-2010" sev="critical" title="POST /v2/testcases/export silently drops 1048 → 77 testcases" via="API count-integrity test" />
              <BugRow ticket="SIM40-2020" sev="critical" title="Stored XSS — Test_Name accepts <script> and returns it unescaped" via="API fuzz pack + UI XSS-render test" />
              <BugRow ticket="SIM40-2021" sev="critical" title="Empty/whitespace Test_Name accepted; creates unreachable ghost record" via="Round-trip + ghost-record probe" />
              <BugRow ticket="SIM40-2016" sev="critical" title="DELETE /v2/testcases/{id} returns 404 — endpoint not implemented" via="Lifecycle round-trip" />
              <BugRow ticket="SIM40-2022" sev="medium" title="Misleading 400 error: 'Test case already exists' returned when field is missing" via="Field-omission negative tests" />
              <BugRow ticket="SIM40-2014" sev="critical" title="Imported testcases not deterministically retrievable post-import" via="Import availability probe" />
              <BugRow ticket="SIM40-1958" sev="medium" title="SDR Configuration: card type / serial fields don't populate after simulator pick" via="UI sub-page glitch test" />
              <BugRow ticket="SIM40-1957" sev="low" title="Sidebar collapsed → no tooltips on icons" via="UI tooltip-on-hover test" />
            </ul>
          </div>
        </section>

        {/* ─────────── ARCHITECTURE ─────────── */}
        <section>
          <SectionTitle eyebrow="Under the hood" title="How it's built" />
          <div className="rounded-2xl bg-surface border border-line p-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <ArchBox title="Frontend" tone="accent" icon={<MousePointerClick className="h-4 w-4" />}
                items={['Next.js 15 + React + Tailwind', 'Single-page UI hosted on lab server', 'Live progress + Stop / Re-run / Per-test', 'Self-contained HTML reports']} />
              <ArchBox title="Backend" tone="primary" icon={<Cpu className="h-4 w-4" />}
                items={['Next.js API routes', 'Per-host concurrency lock (multi-user)', 'Active-run map keyed by target', 'Baseline persistence to disk']} />
              <ArchBox title="Test execution" tone="warning" icon={<Workflow className="h-4 w-4" />}
                items={['Playwright drives Chrome/Edge/Firefox', 'Trace + video on failure', 'Network + console capture', 'Slow-mo when watching']} />
            </div>
            <div className="mt-5 pt-5 border-t border-line text-xs leading-relaxed text-slate-500">
              Lives in <code className="px-1.5 py-0.5 rounded font-mono text-[11px] bg-panel">projects/simqa/</code> · 3,500 lines of TypeScript · zero external services · runs on any machine with Node 18+ and a modern browser. Deployable as a Windows service, a Linux systemd unit, or a Docker container.
            </div>
          </div>
        </section>

        {/* ─────────── ROADMAP ─────────── */}
        <section>
          <SectionTitle eyebrow="What's next" title="Roadmap" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <RoadmapTile when="Near-term" tone="accent" items={['PRACH config field-validation pack', 'TDD pattern verification', 'Test execution lifecycle (drive a real run end-to-end)', 'Toast / notification assertions']} />
            <RoadmapTile when="Medium-term" tone="primary" items={['CI hook: run automatically on every build', 'Slack notifications on regression', 'Auto-comment on Jira tickets when failures match', 'Test history per test id (trending)']} />
            <RoadmapTile when="Bigger lift" tone="info" items={['Subscriber config (IMSI/PLMN consistency)', 'Slicing config (NSSAI SST/SD)', 'Live trace stream during execution', 'Test scenario editor in-UI']} />
          </div>
        </section>

        {/* ─────────── FOOTER CTAs ─────────── */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <CtaCard href="/ui-tests" icon={<MousePointerClick className="h-5 w-5" />} title="Run UI tests" sub={`${catalogCount ?? '…'} tests across 15 categories`} />
          <CtaCard href="/api-tests" icon={<Beaker className="h-5 w-5" />} title="Run API tests" sub="REST surface, fuzz, validation" />
          <CtaCard href="/runs" icon={<Activity className="h-5 w-5" />} title="Past run history" sub="Reports + verification per execution" />
        </section>

        </div>
      </main>
    </>
  );
}

// =============================================================================
// Inline components
// =============================================================================

/** Tone → mapped Tailwind classes. `soft` is a tinted fill, `on` the emphatic
 *  foreground, `solid` a filled chip that takes text-on-accent. */
const TONE: Record<string, { soft: string; on: string; solid: string }> = {
  primary:     { soft: 'bg-primary-50', on: 'text-primary-700', solid: 'bg-primary-600' },
  accent:      { soft: 'bg-emerald-50', on: 'text-emerald-700', solid: 'bg-emerald-600' },
  info:        { soft: 'bg-blue-50',    on: 'text-blue-700',    solid: 'bg-blue-600' },
  warning:     { soft: 'bg-amber-50',   on: 'text-amber-700',   solid: 'bg-amber-500' },
  destructive: { soft: 'bg-red-50',     on: 'text-red-700',     solid: 'bg-red-600' },
  muted:       { soft: 'bg-slate-100',  on: 'text-slate-500',   solid: 'bg-slate-400' },
};

function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-medium uppercase tracking-widest text-emerald-600">{eyebrow}</div>
      <h2 className="text-2xl font-bold mt-1 tracking-tight text-slate-900">{title}</h2>
    </div>
  );
}

function HeroStat({ label, value, sub, tone }: { label: string; value: string | number; sub: string; tone: keyof typeof TONE }) {
  const t = TONE[tone];
  return (
    <div className={cn('rounded-xl border border-line p-4', t.soft)}>
      <div className="text-[11px] uppercase tracking-wider font-medium text-slate-500">{label}</div>
      <div className={cn('text-3xl font-bold tabular-nums mt-1', t.on)}>{value}</div>
      <div className="text-[11px] mt-0.5 text-slate-500">{sub}</div>
    </div>
  );
}

function SoftCard({ tone, icon, title, children }: { tone: keyof typeof TONE; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <div className="rounded-2xl bg-surface border border-line p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className={cn('inline-flex items-center justify-center h-7 w-7 rounded-lg', t.soft, t.on)}>{icon}</span>
        <h3 className={cn('font-semibold', t.on)}>{title}</h3>
      </div>
      <div className="text-sm leading-relaxed space-y-2 text-slate-900">{children}</div>
    </div>
  );
}

function FeatureTile({ icon, tone, title, count, desc, href }: { icon: React.ReactNode; tone: keyof typeof TONE; title: string; count: string; desc: string; href: string }) {
  const t = TONE[tone];
  return (
    <Link href={href} className="block group">
      <div className="rounded-2xl bg-surface border border-line p-5 h-full transition-all group-hover:shadow-lg group-hover:-translate-y-0.5">
        <div className="flex items-start justify-between mb-3">
          <span className={cn('inline-flex items-center justify-center h-10 w-10 rounded-xl', t.soft, t.on)}>{icon}</span>
          <span className="text-2xl font-bold tabular-nums text-slate-900">{count}</span>
        </div>
        <div className="text-base font-semibold mb-2 text-slate-900">{title}</div>
        <div className="text-xs leading-relaxed text-slate-500">{desc}</div>
        <div className={cn('mt-3 inline-flex items-center gap-1 text-xs font-medium', t.on)}>
          Open <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
        </div>
      </div>
    </Link>
  );
}

function LayerCard({ num, tone, title, subtitle, desc, catches }: { num: string; tone: keyof typeof TONE; title: string; subtitle: string; desc: string; catches: string }) {
  const t = TONE[tone];
  return (
    <div className={cn('rounded-xl border border-line p-4', t.soft)}>
      <div className="flex items-baseline gap-2 mb-2">
        <span className={cn('inline-flex items-center justify-center h-7 px-2 rounded text-xs font-bold tabular-nums text-on-accent', t.solid)}>{num}</span>
        <span className="font-semibold text-slate-900">{title}</span>
      </div>
      <div className={cn('text-[11px] uppercase tracking-wide mb-2', t.on)}>{subtitle}</div>
      <div className="text-xs leading-relaxed mb-3 text-slate-900">{desc}</div>
      <div className="text-[11px] text-slate-500">
        <span className="opacity-70">Catches:</span> <span className="text-slate-900">{catches}</span>
      </div>
    </div>
  );
}

function SeverityTile({ label, tone, count, desc }: { label: string; tone: keyof typeof TONE; count: number; desc: string }) {
  const t = TONE[tone];
  return (
    <div className={cn('rounded-xl border border-line p-3', t.soft)}>
      <div className={cn('text-2xl font-bold tabular-nums', t.on)}>{count}</div>
      <div className="text-xs font-semibold mt-1 text-slate-900">{label}</div>
      <div className="text-[11px] text-slate-500">{desc}</div>
    </div>
  );
}

function WorkflowStep({ when, profile, duration, tone, description }: { when: string; profile: string; duration: string; tone: keyof typeof TONE; description: string }) {
  const t = TONE[tone];
  return (
    <div className="rounded-2xl bg-surface border border-line p-5">
      <div className={cn('text-[11px] uppercase tracking-widest font-semibold', t.on)}>{when}</div>
      <div className="flex items-baseline gap-2 mt-2">
        <span className="text-xl font-bold text-slate-900">{profile}</span>
        <span className="text-[11px] text-slate-500"><Clock className="inline h-3 w-3" /> {duration}</span>
      </div>
      <div className="text-xs leading-relaxed mt-2.5 text-slate-500">{description}</div>
    </div>
  );
}

function BugRow({ ticket, sev, title, via }: { ticket: string; sev: string; title: string; via: string }) {
  const tone = sev === 'critical' ? TONE.destructive : sev === 'medium' ? TONE.warning : TONE.muted;
  // The Jira host is configured per-deployment via NEXT_PUBLIC_JIRA_BASE
  // (e.g. "https://your-org.atlassian.net"). Falls back to a plain text
  // ticket key with no link when not configured.
  const jiraBase = process.env.NEXT_PUBLIC_JIRA_BASE;
  const ticketHref = jiraBase ? `${jiraBase.replace(/\/$/, '')}/browse/${ticket}` : undefined;
  return (
    <li className="px-5 py-3 transition-colors hover:bg-slate-50">
      <div className="flex items-start gap-3">
        {ticketHref ? (
          <a href={ticketHref} target="_blank" rel="noreferrer"
             className="text-xs font-mono hover:underline flex items-center gap-1 mt-0.5 whitespace-nowrap text-primary-700">
            {ticket}<ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-xs font-mono mt-0.5 whitespace-nowrap text-slate-500">{ticket}</span>
        )}
        <span className={cn('text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded mt-0.5 flex-shrink-0', tone.soft, tone.on)}>{sev}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm leading-snug text-slate-900">{title}</div>
          <div className="text-[11px] mt-0.5 text-slate-500">surfaced by · {via}</div>
        </div>
      </div>
    </li>
  );
}

function ArchBox({ title, tone, icon, items }: { title: string; tone: keyof typeof TONE; icon: React.ReactNode; items: string[] }) {
  const t = TONE[tone];
  return (
    <div className="rounded-xl border border-line p-4 bg-surface">
      <div className="flex items-center gap-2 mb-3">
        <span className={cn('inline-flex items-center justify-center h-7 w-7 rounded-lg', t.soft, t.on)}>{icon}</span>
        <span className="text-sm font-semibold text-slate-900">{title}</span>
      </div>
      <ul className="space-y-1.5 text-xs text-slate-900">
        {items.map((it) => (
          <li key={it} className="flex items-start gap-2">
            <span className={cn('inline-block h-1 w-1 rounded-full mt-1.5 flex-shrink-0', t.solid)} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoadmapTile({ when, tone, items }: { when: string; tone: keyof typeof TONE; items: string[] }) {
  const t = TONE[tone];
  return (
    <div className="rounded-2xl bg-surface border border-line p-5">
      <div className={cn('text-[11px] uppercase tracking-widest font-semibold mb-3', t.on)}>{when}</div>
      <ul className="space-y-2 text-xs text-slate-900">
        {items.map((it) => (
          <li key={it} className="flex items-start gap-2">
            <span className={cn('inline-block h-1.5 w-1.5 rounded-full mt-1.5 flex-shrink-0', t.solid)} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CtaCard({ href, icon, title, sub }: { href: string; icon: React.ReactNode; title: string; sub: string }) {
  return (
    <Link href={href} className="block group">
      <div className="rounded-2xl bg-surface border border-line p-4 transition-all group-hover:border-emerald-300 group-hover:shadow-md flex items-center gap-3">
        <span className="inline-flex items-center justify-center h-10 w-10 rounded-lg bg-emerald-50 text-emerald-700">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          <div className="text-xs text-slate-500">{sub}</div>
        </div>
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 text-slate-500" />
      </div>
    </Link>
  );
}

function prettyCategory(c: string): string {
  const map: Record<string, string> = {
    'auth':       'Authentication',
    'navigation': 'Navigation',
    'testcases':  'Test Cases',
    'stats':      'Statistics',
    'logs':       'Logs',
    'simulators': 'Simulators',
    'users':      'Users',
    'tools':      'Tools',
    'security':   'Security',
    'errors':     'Errors / network',
    'patterns':   'Patterns (SIM40)',
    'lifecycle':  'Lifecycle (E2E)',
    'perf':       'Performance',
    'compat':     'Cross-browser',
    'field-band': 'Band → ARFCN',
  };
  return map[c] ?? c;
}

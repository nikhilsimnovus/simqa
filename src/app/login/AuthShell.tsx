// Shared frame for the sign-in and sign-up pages, so the pair stay identical
// apart from their form. Server component — the version string is read on the
// server like everywhere else.
//
// Two panels: what the product is on the left, the form on the right. The left
// one is decoration and carries nothing you need, so below `lg` it is dropped
// entirely rather than stacked — on a phone it would be a screen of scrolling
// between you and a password field. The logo moves above the card there.

import { getSimqaVersion } from '@/lib/version';

export function SimQaLogo({ size = 36 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="SimQA">
      <rect x="0" y="0" width="64" height="64" rx="14" fill="#FF6A00" />
      <circle cx="29" cy="27" r="14" fill="#FFD3A5" />
      <path d="M15 26 Q13 16 19 12 Q24 14 22 22 Z" fill="#2D1B0E" />
      <path d="M43 26 Q45 16 39 12 Q34 14 36 22 Z" fill="#2D1B0E" />
      <circle cx="23" cy="27" r="4" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="1.6" />
      <circle cx="35" cy="27" r="4" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="1.6" />
      <line x1="27" y1="27" x2="31" y2="27" stroke="#1A1A1A" strokeWidth="1.6" />
      <circle cx="23" cy="27" r="1.3" fill="#1A1A1A" />
      <circle cx="35" cy="27" r="1.3" fill="#1A1A1A" />
      <path d="M19 35 Q23 39 29 37 Q35 39 39 35 Q38 41 31 41 Q22 41 19 35 Z" fill="#2D1B0E" />
      <path d="M25 43 Q29 46 33 43" stroke="#1A1A1A" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      <circle cx="48" cy="46" r="9" fill="#FFFFFF" fillOpacity="0.9" stroke="#1A1A1A" strokeWidth="2" />
      <line x1="55" y1="53" x2="62" y2="60" stroke="#1A1A1A" strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="48" cy="46" rx="2.4" ry="1.6" fill="#16A34A" />
      <line x1="45.5" y1="45" x2="43.5" y2="44" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="50.5" y1="45" x2="52.5" y2="44" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="45.5" y1="47" x2="43.5" y2="48" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="50.5" y1="47" x2="52.5" y2="48" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
    </svg>
  );
}

/** What the platform does, drawn rather than described: a dashboard being
 *  driven by something that is not a person. Flat shapes and brand colours —
 *  no gradients, no shadows, nothing that dates. */
function Illustration() {
  return (
    <svg viewBox="0 0 520 300" className="w-full max-w-[460px]" role="img"
      aria-label="A test dashboard being driven automatically">
      {/* screen */}
      <rect x="60" y="40" width="300" height="200" rx="12" fill="#1E293B" />
      <rect x="74" y="54" width="272" height="172" rx="7" fill="#F8FAFC" />
      {/* a pass ring, the thing everyone looks at first */}
      <circle cx="128" cy="104" r="26" fill="none" stroke="#E2E8F0" strokeWidth="9" />
      <circle cx="128" cy="104" r="26" fill="none" stroke="#10B981" strokeWidth="9"
        strokeLinecap="round" strokeDasharray="123 40" transform="rotate(-90 128 104)" />
      {/* rows of results */}
      {[0, 1, 2].map(i => (
        <g key={i} transform={`translate(0 ${i * 22})`}>
          <circle cx="178" cy="88" r="4" fill="#CBD5E1" />
          <rect x="190" y="84" width="118" height="8" rx="4" fill="#E2E8F0" />
        </g>
      ))}
      {/* a chart, because results are a trend not a moment */}
      {[34, 52, 26, 64, 44].map((h, i) => (
        <rect key={i} x={186 + i * 22} y={206 - h} width="13" height={h} rx="3"
          fill={i === 3 ? '#2563EB' : '#BFDBFE'} />
      ))}
      <rect x="92" y="150" width="62" height="8" rx="4" fill="#E2E8F0" />
      <rect x="92" y="168" width="44" height="8" rx="4" fill="#E2E8F0" />
      {/* stand */}
      <rect x="188" y="240" width="44" height="10" rx="4" fill="#1E293B" />
      <rect x="150" y="250" width="120" height="9" rx="4.5" fill="#1E293B" />

      {/* the arm doing the work */}
      <g stroke="#2563EB" strokeWidth="11" strokeLinecap="round" fill="none">
        <path d="M470 244 L470 188" />
        <path d="M470 188 L436 146" />
        <path d="M436 146 L404 128" />
      </g>
      <circle cx="470" cy="188" r="9" fill="#1E40AF" />
      <circle cx="436" cy="146" r="8" fill="#1E40AF" />
      <rect x="430" y="232" width="80" height="16" rx="8" fill="#1E293B" />
      {/* the gripper stops at the screen's edge rather than over it */}
      <path d="M398 120 L384 112 M398 136 L384 144" stroke="#1E40AF" strokeWidth="8" strokeLinecap="round" />

      {/* passed */}
      <circle cx="408" cy="58" r="24" fill="#ECFDF5" stroke="#10B981" strokeWidth="3" />
      <path d="M397 58 l8 8 l15 -16" fill="none" stroke="#10B981" strokeWidth="5"
        strokeLinecap="round" strokeLinejoin="round" />
      {/* run */}
      <rect x="18" y="150" width="56" height="56" rx="16" fill="#FFFFFF" stroke="#E2E8F0" strokeWidth="2" />
      <path d="M40 166 L56 178 L40 190 Z" fill="#2563EB" />
    </svg>
  );
}

/** The four things the product claims to do. Icons are drawn inline so the
 *  panel needs no runtime and no asset pipeline. */
const FEATURES: Array<{ label: string; tint: string; icon: React.ReactNode }> = [
  {
    label: 'Automated\nTesting', tint: 'text-emerald-600',
    icon: <><circle cx="12" cy="12" r="9" /><path d="M8.5 12.2l2.4 2.4 4.6-4.9" /></>,
  },
  {
    label: 'Smart\nExecution', tint: 'text-blue-600',
    icon: <><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M9 12h.01M15 12h.01M12 4v3" /></>,
  },
  {
    label: 'Real-time\nMonitoring', tint: 'text-blue-600',
    icon: <path d="M4 15l5-6 4 4 7-8" />,
  },
  {
    label: 'Reliable\nResults', tint: 'text-amber-600',
    icon: <><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z" /><path d="M9 12l2 2 4-4" /></>,
  },
];

export function AuthShell({ tagline, title, subtitle, children }: {
  tagline: string;
  /** The card's heading. Defaults to the sign-in wording. */
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const ver = getSimqaVersion();
  return (
    <main className="h-screen overflow-hidden flex flex-col bg-page">
      <div className="flex-1 min-h-0 grid lg:grid-cols-[1.05fr_1fr]">
        {/* ── what this is ──────────────────────────────────────────────── */}
        <section className="relative hidden lg:flex flex-col justify-between px-12 py-8 overflow-hidden
                            bg-blue-50/60 border-r border-line">
          {/* A dot field, quiet enough to read over. */}
          <div aria-hidden className="absolute inset-0 opacity-[0.35]"
            style={{
              backgroundImage: 'radial-gradient(currentColor 1px, transparent 1px)',
              backgroundSize: '22px 22px',
              color: 'rgb(148 163 184 / 0.5)',
            }} />

          <div className="relative">
            <div className="flex items-center gap-3">
              <SimQaLogo size={44} />
              <span className="text-2xl font-bold tracking-tight text-slate-900">SimQA</span>
            </div>

            <h1 className="mt-10 text-6xl font-extrabold tracking-tight text-slate-900">SimQA</h1>
            <h2 className="mt-3 text-xl font-bold text-slate-800 leading-snug max-w-sm">
              Automated QA Platform for Simnovator UESIM
            </h2>
            <p className="mt-3 text-sm text-slate-600 max-w-sm leading-relaxed">{tagline}</p>
          </div>

          <div className="relative flex justify-center py-6"><Illustration /></div>

          <div className="relative grid grid-cols-4 gap-3">
            {FEATURES.map(f => (
              <div key={f.label} className="rounded-xl border border-line bg-surface px-3 py-3 text-center">
                <svg viewBox="0 0 24 24" className={`mx-auto h-6 w-6 ${f.tint}`} fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  {f.icon}
                </svg>
                <div className="mt-2 text-[11px] font-semibold text-slate-700 leading-tight whitespace-pre-line">
                  {f.label}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── the form ──────────────────────────────────────────────────── */}
        <section className="flex items-center justify-center overflow-y-auto px-5 py-8 sm:px-8">
          <div className="w-full max-w-[460px]">
            {/* The brand, for the screens that dropped the panel. */}
            <div className="lg:hidden flex items-center justify-center gap-2.5 mb-7">
              <SimQaLogo size={34} />
              <span className="text-xl font-bold tracking-tight text-slate-900">SimQA</span>
            </div>

            <div className="rounded-2xl border border-line bg-surface shadow-sm px-6 py-9 sm:px-10 sm:py-11">
              <h2 className="text-center text-2xl font-bold tracking-tight text-slate-900">
                {title ?? 'Welcome back'}
              </h2>
              <p className="mt-1.5 text-center text-sm text-slate-500">
                {subtitle ?? 'Sign in to continue to SimQA'}
              </p>
              <div className="mt-7">{children}</div>
            </div>
          </div>
        </section>
      </div>

      <footer className="shrink-0 border-t border-line py-4 text-center text-xs text-slate-400">
        <div className="flex items-center justify-center gap-3">
          <span>SimQA</span>
          <span aria-hidden>•</span>
          <span className="font-mono">{ver.version}</span>
        </div>
        <div className="mt-1.5">Automated QA tooling for Simnovator UESIM.</div>
      </footer>
    </main>
  );
}

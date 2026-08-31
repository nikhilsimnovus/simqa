// Shared frame for the sign-in and sign-up pages, so the pair stay identical
// apart from their form. Server component — the version string is read on the
// server like everywhere else.

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

export function AuthShell({ tagline, children }: { tagline: string; children: React.ReactNode }) {
  const ver = getSimqaVersion();
  return (
    <main className="min-h-screen w-full flex items-center justify-center px-4 py-10 bg-slate-50">
      <div className="w-full max-w-[420px]">
        <div className="flex items-center gap-2.5 mb-8">
          <SimQaLogo size={36} />
          <span className="text-lg font-bold tracking-tight text-slate-900">SimQA</span>
        </div>

        <h1 className="text-[2.5rem] leading-none font-extrabold tracking-tight text-slate-900">SimQA</h1>
        <p className="mt-2 text-sm text-slate-500 font-mono">{ver.version}</p>
        <p className="mt-3 text-sm text-slate-600">{tagline}</p>

        <div className="mt-8">{children}</div>

        <footer className="mt-8 text-center text-xs text-slate-400">
          <div className="flex items-center justify-center gap-3">
            <span>SimQA</span>
            <span aria-hidden>•</span>
            <span className="font-mono">{ver.version}</span>
          </div>
          <div className="mt-2">Automated QA tooling for Simnovator UESIM.</div>
        </footer>
      </div>
    </main>
  );
}

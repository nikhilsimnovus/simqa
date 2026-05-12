'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, FlaskConical, Server, History, Settings2, PlayCircle, ShieldCheck, Beaker, MousePointerClick, Info, Layers, Wrench, Database, Rocket,
} from 'lucide-react';
import { cn } from '@/lib/cn';

// Primary navigation. Covers the 95% of installs where simqa is driving an
// integrated Simnovator box via REST — no separate callbox/MME/IMS.
const NAV = [
  { href: '/',              label: 'Dashboard',       icon: LayoutDashboard },
  { href: '/about',         label: 'About QA Ka BAAP',icon: Info },
  { href: '/testcases',     label: 'Test Cases',      icon: FlaskConical },
  { href: '/run-validate',  label: 'Run & Validate',  icon: Rocket },
  { href: '/validate',      label: 'Build Check',     icon: ShieldCheck },
  { href: '/api-tests',     label: 'API Tests',       icon: Beaker },
  { href: '/ui-tests',      label: 'UI Tests',        icon: MousePointerClick },
  { href: '/inventory',     label: 'Systems Mgmt',    icon: Server },
  { href: '/tools',         label: 'Tools',           icon: Wrench },
  { href: '/backup',        label: 'Backup',          icon: Database },
  { href: '/runs',          label: 'Run History',     icon: History },
  { href: '/settings',      label: 'Settings',        icon: Settings2 },
];

// Advanced surfaces — only useful when you have a distributed lab (separate
// callbox / MME / IMS / AppServer boxes and want simqa to generate cfgs +
// SSH-push them). Hidden under an "Advanced" collapsible so the customer-
// style install isn't cluttered with surfaces that can't do anything
// useful for them.
const ADVANCED_NAV = [
  { href: '/end-to-end',  label: 'Topology Setups', icon: Layers },
  { href: '/automation',  label: 'Generate + Push', icon: PlayCircle },
];

/**
 * QA Ka BAAP mascot — "father doing QA":
 * Cartoon dad with bald top + side hair + chunky black-rimmed glasses +
 * handlebar mustache, holding a magnifying glass with a bug under it.
 * Designed to read clearly at 32x32 (sidebar badge) but scales up cleanly.
 */
function QaKaBaapLogo({ size = 32 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label="QA Ka BAAP — father doing QA"
    >
      {/* Rounded badge background (Simnovator orange) */}
      <rect x="0" y="0" width="64" height="64" rx="14" fill="#FF6A00" />
      {/* Face */}
      <circle cx="29" cy="27" r="14" fill="#FFD3A5" />
      {/* Side hair (bald-on-top dad pattern) */}
      <path d="M15 26 Q13 16 19 12 Q24 14 22 22 Z" fill="#2D1B0E" />
      <path d="M43 26 Q45 16 39 12 Q34 14 36 22 Z" fill="#2D1B0E" />
      {/* Glasses (chunky black frames with white lenses) */}
      <circle cx="23" cy="27" r="4" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="1.6" />
      <circle cx="35" cy="27" r="4" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="1.6" />
      <line x1="27" y1="27" x2="31" y2="27" stroke="#1A1A1A" strokeWidth="1.6" />
      <circle cx="23" cy="27" r="1.3" fill="#1A1A1A" />
      <circle cx="35" cy="27" r="1.3" fill="#1A1A1A" />
      {/* Big handlebar mustache */}
      <path
        d="M19 35 Q23 39 29 37 Q35 39 39 35 Q38 41 31 41 Q22 41 19 35 Z"
        fill="#2D1B0E"
      />
      {/* Smile under mustache */}
      <path d="M25 43 Q29 46 33 43" stroke="#1A1A1A" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      {/* Magnifying glass (held in hand) — overlaps the lower-right corner */}
      <circle cx="48" cy="46" r="9" fill="#FFFFFF" fillOpacity="0.9" stroke="#1A1A1A" strokeWidth="2" />
      <line x1="55" y1="53" x2="62" y2="60" stroke="#1A1A1A" strokeWidth="3" strokeLinecap="round" />
      {/* Tiny green bug being inspected */}
      <ellipse cx="48" cy="46" rx="2.4" ry="1.6" fill="#16A34A" />
      <line x1="45.5" y1="45" x2="43.5" y2="44" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="50.5" y1="45" x2="52.5" y2="44" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="45.5" y1="47" x2="43.5" y2="48" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="50.5" y1="47" x2="52.5" y2="48" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
    </svg>
  );
}

interface SidebarProps {
  /** Build version of the running simqa, e.g. "20260512-d391445".
   *  Passed from the server-rendered layout so the badge paints with
   *  the first frame (no client fetch, no flicker). */
  version?: string;
  /** Where the version came from (env / version-file / cwd / git / fallback).
   *  Surfaced on hover so a "the version doesn't match!" debug step can tell
   *  whether the dev server is reading from the right place. */
  versionSource?: string;
}

export function Sidebar({ version, versionSource }: SidebarProps = {}) {
  const pathname = usePathname() || '/';
  // Auto-expand the Advanced section when the user is currently on one of
  // its routes (so refreshing /end-to-end doesn't fold the link they're on).
  const onAdvanced = ADVANCED_NAV.some((n) => pathname.startsWith(n.href));
  const [advOpen, setAdvOpen] = useState<boolean>(onAdvanced);
  return (
    <aside className="hidden md:flex md:w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="h-14 flex items-center gap-2 px-4 border-b border-slate-200">
        <QaKaBaapLogo size={32} />
        <div className="min-w-0">
          <div className="text-sm font-semibold tracking-tight text-slate-900">QA Ka BAAP</div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Father of QA</div>
        </div>
      </div>
      {/* Build version banner — sits right under the brand so users always
          know which tarball is actually running. Critical for the "is my
          customer-site install really up-to-date?" workflow. */}
      {version ? (
        <div
          className="px-4 py-1.5 text-[10px] font-mono text-slate-500 bg-slate-50 border-b border-slate-100 truncate"
          title={`build version (source: ${versionSource ?? 'unknown'})`}
        >
          build <span className="text-slate-700">{version}</span>
        </div>
      ) : null}
      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-primary-50 text-primary-700 font-medium'
                  : 'text-slate-700 hover:bg-slate-100'
              )}
            >
              <Icon className="h-4 w-4" strokeWidth={2} />
              {label}
            </Link>
          );
        })}

        {/* Advanced section — collapsible. Topology Setups + Generate + Push
            live here because they're only useful when you have a distributed
            lab. Hidden by default on customer installs that don't use them. */}
        <div className="pt-3 mt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={() => setAdvOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-2 px-3 py-1 text-[10px] uppercase tracking-wider text-slate-400 hover:text-slate-600 transition-colors"
          >
            <span>Advanced</span>
            <span className="text-slate-300">{advOpen ? '−' : '+'}</span>
          </button>
          {advOpen ? (
            <div className="space-y-1 mt-1">
              {ADVANCED_NAV.map(({ href, label, icon: Icon }) => {
                const active = pathname.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                      active
                        ? 'bg-primary-50 text-primary-700 font-medium'
                        : 'text-slate-600 hover:bg-slate-100'
                    )}
                  >
                    <Icon className="h-4 w-4" strokeWidth={2} />
                    {label}
                  </Link>
                );
              })}
            </div>
          ) : null}
        </div>
      </nav>
      <div className="p-3 border-t border-slate-200 text-[11px] text-slate-500 flex items-center justify-between gap-2">
        <span>v0.1.0</span>
        {version ? <span className="font-mono text-[10px] text-slate-400 truncate" title={`source: ${versionSource ?? 'unknown'}`}>{version}</span> : null}
      </div>
    </aside>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, FlaskConical, Server, History, Settings2, PlayCircle, ShieldCheck, Beaker, MousePointerClick, Info, Layers,
} from 'lucide-react';
import { cn } from '@/lib/cn';

const NAV = [
  { href: '/',            label: 'Dashboard',       icon: LayoutDashboard },
  { href: '/about',       label: 'About QA Ka BAAP',icon: Info },
  { href: '/testcases',   label: 'Test Cases',      icon: FlaskConical },
  { href: '/automation',  label: 'Automation',      icon: PlayCircle },
  { href: '/validate',    label: 'Build Check',     icon: ShieldCheck },
  { href: '/end-to-end',  label: 'End to End',      icon: Layers },
  { href: '/api-tests',   label: 'API Tests',       icon: Beaker },
  { href: '/ui-tests',    label: 'UI Tests',        icon: MousePointerClick },
  { href: '/inventory',   label: 'Systems Mgmt',    icon: Server },
  { href: '/runs',        label: 'Runs',            icon: History },
  { href: '/settings',    label: 'Settings',        icon: Settings2 },
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

export function Sidebar() {
  const pathname = usePathname() || '/';
  return (
    <aside className="hidden md:flex md:w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="h-14 flex items-center gap-2 px-4 border-b border-slate-200">
        <QaKaBaapLogo size={32} />
        <div>
          <div className="text-sm font-semibold tracking-tight text-slate-900">QA Ka BAAP</div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Father of QA</div>
        </div>
      </div>
      <nav className="flex-1 p-3 space-y-1">
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
      </nav>
      <div className="p-3 border-t border-slate-200 text-[11px] text-slate-500">
        v0.1.0
      </div>
    </aside>
  );
}

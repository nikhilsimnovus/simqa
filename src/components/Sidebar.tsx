'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, FlaskConical, Server, History, Settings2, PlayCircle,
  ShieldCheck, Beaker, MousePointerClick, Info, Wrench, Database,
  Rocket, FileCheck2, Activity, ChevronDown, ChevronRight, Boxes,
  PanelLeftClose, PanelLeftOpen, RefreshCw, Globe,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { ThemeToggle } from '@/components/ThemeToggle';

// ─── Navigation model ─────────────────────────────────────────────────────
//
// Five sections, each collapsible. Order is intentional:
//   1. Plan     — what you're testing today (the catalogue + the trigger)
//   2. Verify   — automated verification surfaces (API/UI/cfg/build/perf)
//   3. Configure— inventory, tools, backups (admin-flavour but high-traffic)
//   4. History  — past runs + project info
//   5. Advanced — distributed-lab features, collapsed by default
//
// A whole-sidebar icons-only mode collapses to a 64px strip with tooltips.

type NavItem = { href: string; label: string; icon: any };
type NavSection = { id: string; title: string; items: NavItem[]; defaultCollapsed?: boolean };

const SECTIONS: NavSection[] = [
  {
    id: 'plan',
    title: 'Plan',
    items: [
      { href: '/',                  label: 'Dashboard',         icon: LayoutDashboard },
      { href: '/testcases',         label: 'Test Cases',        icon: FlaskConical },
      { href: '/automation-suite',  label: 'Automation Suite',  icon: PlayCircle },
      { href: '/environments',      label: 'Environments',      icon: Globe },
      { href: '/run-validate',      label: 'Run & Validate',    icon: Rocket },
    ],
  },
  {
    id: 'verify',
    title: 'Verify',
    items: [
      { href: '/api-tests',       label: 'API Tests',       icon: Beaker },
      { href: '/ui-tests',        label: 'UI Tests',        icon: MousePointerClick },
      { href: '/bulk-tests',      label: 'Bulk Tests',      icon: Boxes },
      { href: '/config-fidelity', label: 'Config Fidelity', icon: FileCheck2 },
      { href: '/validate',        label: 'Build Check',     icon: ShieldCheck },
      { href: '/perf-qa',         label: 'OneClick',        icon: Activity },
    ],
  },
  {
    id: 'configure',
    title: 'Configure',
    items: [
      { href: '/inventory', label: 'Systems Mgmt', icon: Server },
      { href: '/tools',     label: 'Tools',        icon: Wrench },
      { href: '/backup',    label: 'Backup',       icon: Database },
    ],
  },
  {
    id: 'history',
    title: 'History & Help',
    items: [
      { href: '/runs',     label: 'Run History',      icon: History },
      { href: '/about',    label: 'About QA Ka BAAP', icon: Info },
      { href: '/settings', label: 'Settings',         icon: Settings2 },
    ],
  },
  {
    id: 'advanced',
    title: 'Advanced',
    defaultCollapsed: true,
    items: [
      // Topology Setups used to live here and edited the same profiles[] as
      // Systems Mgmt, with contradicting validation. It is now the Topology
      // tab on /inventory; /end-to-end redirects there.
      { href: '/automation', label: 'Generate + Push', icon: PlayCircle },
    ],
  },
];

const LS_SECTIONS = 'simqa-sidebar-sections-collapsed';
const LS_RAILMODE = 'simqa-sidebar-rail';

// ─── QA Ka BAAP mascot — unchanged ────────────────────────────────────────
function QaKaBaapLogo({ size = 32 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="QA Ka BAAP — father doing QA">
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

interface SidebarProps {
  version?: string;
  versionSource?: string;
  /** package.json version — the footer used to hardcode v0.1.0. */
  appVersion?: string;
}

export function Sidebar({ version, versionSource, appVersion }: SidebarProps = {}) {
  const pathname = usePathname() || '/';

  // ── Rail (icons-only) mode + per-section collapsed state ─────────────
  // Both persist to localStorage; we hydrate on mount to avoid SSR mismatch.
  const [rail, setRail]                 = useState<boolean>(false);
  const [collapsedSections, setColSecs] = useState<Record<string, boolean>>(() => {
    const seeded: Record<string, boolean> = {};
    for (const s of SECTIONS) if (s.defaultCollapsed) seeded[s.id] = true;
    return seeded;
  });
  const [hydrated, setHydrated] = useState(false);

  // ── Self-update plumbing ─────────────────────────────────────────────
  // Probes /api/update on mount. The endpoint returns
  //   { ok, available, updaterPath, repoTarball }
  // We show the Update pill only when `available: true` (i.e. the
  // /usr/local/sbin/simqa-update wrapper was planted by install.sh).
  // Mirrors the OneClick pattern in perf-qa/ui/app.py.
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateLabel, setUpdateLabel] = useState('Update');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/update').then((r) => r.json()).then((d) => {
      if (!cancelled) setUpdateAvailable(!!d?.available);
    }).catch(() => { /* dev workstation — hide pill */ });
    return () => { cancelled = true; };
  }, []);

  const runUpdate = useCallback(async () => {
    if (updateBusy) return;
    if (!window.confirm(
      'Fetch the latest simqa from GitHub and re-install?\n\n' +
      'The service will restart. This usually takes 30–60 seconds (npm ci + next build).',
    )) return;
    setUpdateBusy(true);
    setUpdateLabel('Updating…');
    let stillUp = true;
    try {
      const r = await fetch('/api/update', { method: 'POST', cache: 'no-store' });
      const j: any = await r.json().catch(() => ({}));
      if (j?.ok) {
        setUpdateLabel('Updated — reloading');
      } else {
        stillUp = false;
        setUpdateLabel('Update failed');
        const tail = j?.log ? '\n\nLast log lines:\n' + String(j.log).split('\n').slice(-15).join('\n') : '';
        window.alert('Update failed.' + tail);
      }
    } catch {
      // Most common case — the service restarted before our response came
      // back. That's actually success; reload to pick up the new code.
      setUpdateLabel('Restarting — reloading');
    }
    if (stillUp) {
      window.setTimeout(() => { window.location.reload(); }, 4000);
    } else {
      setUpdateBusy(false);
      setUpdateLabel('Update');
    }
  }, [updateBusy]);

  useEffect(() => {
    try {
      const r = typeof window !== 'undefined' ? window.localStorage.getItem(LS_RAILMODE) : null;
      if (r === '1') setRail(true);
      const sRaw = typeof window !== 'undefined' ? window.localStorage.getItem(LS_SECTIONS) : null;
      if (sRaw) {
        const parsed = JSON.parse(sRaw);
        if (parsed && typeof parsed === 'object') setColSecs((cur) => ({ ...cur, ...parsed }));
      }
    } catch { /* swallow */ }
    setHydrated(true);
  }, []);

  // Auto-open the section containing the current route, so a deep-link
  // refresh never lands on a collapsed group.
  useEffect(() => {
    const sec = SECTIONS.find((s) => s.items.some((i) =>
      i.href === '/' ? pathname === '/' : pathname.startsWith(i.href),
    ));
    if (sec && collapsedSections[sec.id]) {
      setColSecs((cur) => ({ ...cur, [sec.id]: false }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const toggleRail = useCallback(() => {
    setRail((r) => {
      const next = !r;
      try { window.localStorage.setItem(LS_RAILMODE, next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);
  const toggleSection = useCallback((id: string) => {
    setColSecs((cur) => {
      const next = { ...cur, [id]: !cur[id] };
      try { window.localStorage.setItem(LS_SECTIONS, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // Each rendered item knows whether it's on the active route.
  const isActive = useCallback((href: string) => (
    href === '/' ? pathname === '/' : pathname.startsWith(href)
  ), [pathname]);

  return (
    <aside
      className={cn(
        'hidden md:flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150 ease-out',
        rail ? 'md:w-[64px]' : 'md:w-60',
      )}
      // Avoid hydration flicker — hide until LS values are read.
      style={{ visibility: hydrated ? 'visible' : 'hidden' }}
    >
      {/* Brand row */}
      <div className={cn('h-14 flex items-center border-b border-line', rail ? 'justify-center px-2' : 'gap-2 px-4')}>
        <Link href="/" className="shrink-0" title="QA Ka BAAP — home">
          <QaKaBaapLogo size={32} />
        </Link>
        {!rail ? (
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold tracking-tight text-slate-900">QA Ka <span className="text-primary-700">BAAP</span></div>
            <div className="font-mono text-[10px] uppercase tracking-label text-slate-500">Father of QA</div>
          </div>
        ) : null}
        {!rail && updateAvailable ? (
          <button
            type="button"
            onClick={runUpdate}
            disabled={updateBusy}
            className={cn(
              'rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 border transition-colors',
              updateBusy
                ? 'bg-amber-50 border-amber-200 text-amber-700'
                : 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100',
            )}
            title="Pull latest simqa from GitHub and re-install — service restarts"
            aria-label="Update simqa"
          >
            <RefreshCw className={cn('h-3 w-3', updateBusy ? 'animate-spin' : '')} aria-hidden />
            <span>{updateLabel}</span>
          </button>
        ) : null}
        {!rail ? (
          <button
            type="button"
            onClick={toggleRail}
            className="ml-auto rounded-md p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            title="Collapse to rail (Ctrl+B)"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* Sections */}
      <nav className={cn('flex-1 overflow-y-auto', rail ? 'p-2 space-y-3' : 'p-2 space-y-1')}>
        {rail ? (
          // Rail mode: flat list, icons only, tooltips on hover.
          <RailNav sections={SECTIONS} isActive={isActive} />
        ) : (
          SECTIONS.map((sec) => (
            <Section
              key={sec.id}
              section={sec}
              collapsed={!!collapsedSections[sec.id]}
              onToggle={() => toggleSection(sec.id)}
              isActive={isActive}
            />
          ))
        )}
      </nav>

      {/* Footer */}
      <div className={cn('border-t border-line', rail ? 'p-2' : 'p-3')}>
        {rail ? (
          <div className="flex flex-col items-center gap-2">
            <ThemeToggle compact />
            <button
              type="button"
              onClick={toggleRail}
              className="w-full flex items-center justify-center rounded-md p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100"
              title="Expand sidebar"
              aria-label="Expand sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-[11px] text-slate-500">
              <span>v{appVersion ?? '0.0.0'}</span>
              {version ? (
                <span
                  className="ml-2 font-mono text-[10px] text-slate-400"
                  title={`build ${version} (source: ${versionSource ?? 'unknown'})`}
                >
                  {version}
                </span>
              ) : null}
            </div>
            <ThemeToggle compact />
          </div>
        )}
      </div>
    </aside>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────
function Section({
  section, collapsed, onToggle, isActive,
}: {
  section: NavSection;
  collapsed: boolean;
  onToggle: () => void;
  isActive: (href: string) => boolean;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  // Mark the header tinted if any item inside is active — gives a sense of
  // "you're somewhere in this group" even when the section is folded.
  const groupActive = section.items.some((i) => isActive(i.href));
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider rounded-md transition-colors',
          groupActive ? 'text-slate-700' : 'text-slate-400 hover:text-slate-700',
        )}
        aria-expanded={!collapsed}
      >
        <Chevron className="h-3 w-3 opacity-70" />
        <span>{section.title}</span>
      </button>
      {!collapsed ? (
        <div className="mt-0.5 space-y-0.5">
          {section.items.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-primary-50 text-primary-700 font-medium ring-1 ring-primary-500/20'
                    : 'text-slate-700 hover:bg-slate-100',
                )}
              >
                <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary-600' : 'text-slate-500 group-hover:text-slate-700')} strokeWidth={2} />
                <span className="truncate">{label}</span>
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Rail (icons-only) variant ────────────────────────────────────────────
function RailNav({ sections, isActive }: { sections: NavSection[]; isActive: (href: string) => boolean }) {
  // Flatten with thin dividers between sections.
  const grouped = useMemo(() => sections.flatMap((s, i) => [
    { type: 'divider' as const, id: 'div-' + s.id, hideFirst: i === 0 },
    ...s.items.map((item) => ({ type: 'item' as const, item, sectionTitle: s.title })),
  ]), [sections]);
  return (
    <>
      {grouped.map((g, idx) => {
        if (g.type === 'divider') {
          if (g.hideFirst) return null;
          return <div key={g.id} className="h-px bg-line my-2 mx-2" />;
        }
        const Icon = g.item.icon;
        const active = isActive(g.item.href);
        return (
          <Link
            key={g.item.href + idx}
            href={g.item.href}
            title={`${g.sectionTitle} · ${g.item.label}`}
            className={cn(
              'group flex items-center justify-center rounded-md p-2 transition-colors relative',
              active
                ? 'bg-primary-50 text-primary-700 ring-1 ring-primary-500/20'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )}
          >
            <Icon className="h-5 w-5" strokeWidth={2} />
            {/* Floating tooltip on hover (no JS library — CSS-only) */}
            <span className="pointer-events-none absolute left-full ml-2 z-50 whitespace-nowrap rounded-md bg-slate-900 text-on-accent text-[11px] px-2 py-1 shadow-glow opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all">
              {g.item.label}
            </span>
          </Link>
        );
      })}
    </>
  );
}

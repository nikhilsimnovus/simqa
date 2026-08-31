import { Wifi, WifiOff } from 'lucide-react';

interface HeaderProps {
  title: string;
  subtitle?: string;
  /** Rendered to the LEFT of the title — for a Back control on pages you
   *  navigate into, so it sits where you'd look for it rather than among the
   *  actions on the right. */
  left?: React.ReactNode;
  right?: React.ReactNode;
  uesimHost?: string;
  /** Whether the box is answering. Undefined = unknown, shown as reachable —
   *  pages that don't probe shouldn't imply an outage they haven't observed. */
  uesimOnline?: boolean;
}

export function Header({ title, subtitle, left, right, uesimHost, uesimOnline }: HeaderProps) {
  const offline = uesimOnline === false;
  return (
    // hero-grid paints the faint blueprint lattice from the Simnovus
    // handout behind the title; it fades out before the content starts.
    // sticky: the content column is the scroll container, so without this the
    // page header scrolls away with the body.
    <header
      className="hero-grid h-14 shrink-0 sticky top-0 z-10 border-b border-line bg-surface flex items-center px-6 justify-between gap-4"
    >
      <div className="flex items-center gap-3 min-w-0">
        {left}
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold tracking-tight text-slate-900 leading-none">{title}</h1>
          {subtitle ? <p className="truncate text-xs font-light text-slate-500 mt-1">{subtitle}</p> : null}
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {uesimHost ? (
          <div
            className={
              'flex items-center gap-2 rounded-full border px-3 py-1.5 ' +
              (offline
                ? 'border-slate-300/60 bg-slate-100 text-slate-500'
                : 'border-emerald-600/25 bg-emerald-50 text-emerald-700')
            }
            title={offline ? `${uesimHost} is not responding` : `${uesimHost} is reachable`}
          >
            {/* The redesign's badge assumed the box is always up. Keeping the
                offline state: a page that has actually observed an unreachable
                box must not paint it green. */}
            {offline ? <WifiOff className="h-3.5 w-3.5" aria-hidden /> : <Wifi className="h-3.5 w-3.5" aria-hidden />}
            <span className="num text-[11px] font-medium">{uesimHost}</span>
            {offline ? <span className="text-[11px]">offline</span> : null}
          </div>
        ) : null}
        {right}
      </div>
    </header>
  );
}

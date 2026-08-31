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
    // sticky: the content column is the scroll container now, so without this
    // the page header would scroll away with the body.
    <header className="h-14 shrink-0 sticky top-0 z-10 border-b border-slate-200 bg-white flex items-center px-6 justify-between">
      <div className="flex items-center gap-3 min-w-0">
        {left}
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-slate-900 leading-none truncate">{title}</h1>
          {subtitle ? <p className="text-xs text-slate-500 mt-1 truncate">{subtitle}</p> : null}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {uesimHost ? (
          <div
            className={
              'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ' +
              (offline ? 'bg-slate-100 text-slate-500' : 'bg-success-100 text-success-700')
            }
            title={offline ? `${uesimHost} is not responding` : `${uesimHost} is reachable`}
          >
            {offline ? <WifiOff className="h-3.5 w-3.5" /> : <Wifi className="h-3.5 w-3.5" />}
            {uesimHost}
            {offline ? <span className="ml-1">offline</span> : null}
          </div>
        ) : null}
        {right}
      </div>
    </header>
  );
}

import { Wifi } from 'lucide-react';

interface HeaderProps {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  uesimHost?: string;
}

export function Header({ title, subtitle, right, uesimHost }: HeaderProps) {
  return (
    // hero-grid paints the faint blueprint lattice from the Simnovus
    // handout behind the title; it fades out before the content starts.
    <header
      className="hero-grid h-14 shrink-0 border-b border-line bg-surface flex items-center px-6 justify-between gap-4"
    >
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold tracking-tight text-slate-900 leading-none">{title}</h1>
        {subtitle ? <p className="truncate text-xs font-light text-slate-500 mt-1">{subtitle}</p> : null}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {uesimHost ? (
          <div
            className="flex items-center gap-2 rounded-full border border-emerald-600/25 bg-emerald-50 px-3 py-1.5 text-emerald-700"
            title="UESIM under test"
          >
            <Wifi className="h-3.5 w-3.5" aria-hidden />
            <span className="num text-[11px] font-medium">{uesimHost}</span>
          </div>
        ) : null}
        {right}
      </div>
    </header>
  );
}

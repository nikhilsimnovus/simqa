import { Wifi } from 'lucide-react';

interface HeaderProps {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  uesimHost?: string;
}

export function Header({ title, subtitle, right, uesimHost }: HeaderProps) {
  return (
    <header className="h-14 shrink-0 border-b border-slate-200 bg-white flex items-center px-6 justify-between">
      <div>
        <h1 className="text-base font-semibold text-slate-900 leading-none">{title}</h1>
        {subtitle ? <p className="text-xs text-slate-500 mt-1">{subtitle}</p> : null}
      </div>
      <div className="flex items-center gap-3">
        {uesimHost ? (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-success-100 text-success-700 text-xs font-medium">
            <Wifi className="h-3.5 w-3.5" />
            {uesimHost}
          </div>
        ) : null}
        {right}
      </div>
    </header>
  );
}

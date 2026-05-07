// Minimal shadcn-flavored primitives. Just what the QA UI needs — no
// dialogs, popovers, or sheets yet (use them when a flow requires them).

import * as React from 'react';
import { cn } from '@/lib/cn';

// ---------- Card ----------

export function Card({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('bg-white border border-slate-200 rounded-lg shadow-sm', className)} {...rest} />;
}
export function CardHeader({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4 border-b border-slate-100', className)} {...rest} />;
}
export function CardTitle({ className, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold text-slate-900', className)} {...rest} />;
}
export function CardBody({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...rest} />;
}

// ---------- Button ----------

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}
export function Button({ className, variant = 'primary', size = 'md', ...rest }: ButtonProps) {
  const v: Record<string, string> = {
    primary:   'bg-primary-700 hover:bg-primary-800 text-white border-transparent',
    secondary: 'bg-white hover:bg-slate-50 text-slate-700 border-slate-300',
    ghost:     'bg-transparent hover:bg-slate-100 text-slate-700 border-transparent',
    danger:    'bg-danger hover:opacity-90 text-white border-transparent',
  };
  const s: Record<string, string> = {
    sm: 'h-8 px-3 text-xs',
    md: 'h-9 px-4 text-sm',
  };
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-300',
        v[variant], s[size], className,
      )}
      {...rest}
    />
  );
}

// ---------- Badge ----------

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: 'default' | 'success' | 'danger' | 'warning' | 'info';
}
export function Badge({ className, tone = 'default', ...rest }: BadgeProps) {
  const t: Record<string, string> = {
    default: 'bg-slate-100 text-slate-700',
    success: 'bg-success-100 text-success-700',
    danger:  'bg-red-100 text-red-700',
    warning: 'bg-amber-100 text-amber-700',
    info:    'bg-primary-50 text-primary-700',
  };
  return <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium', t[tone], className)} {...rest} />;
}

// ---------- Input ----------

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900',
          'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400',
          className,
        )}
        {...rest}
      />
    );
  },
);

// ---------- Field ----------

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <span className="mt-1 block text-[11px] text-slate-500">{hint}</span> : null}
    </label>
  );
}

// ---------- Stat ----------

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card>
      <CardBody>
        <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
        <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
        {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

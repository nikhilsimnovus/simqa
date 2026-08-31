// Minimal shadcn-flavored primitives, styled to the Simnovus design
// language (petrol/orange/mist, Poppins + JetBrains Mono).
//
// The public API is unchanged — Card, Button, Badge, Input, Field, Stat all
// take the same props as before, so the ~25 pages using them pick up the new
// look without edits. Colours go through the Tailwind scales defined in
// tailwind.config.ts, which resolve to CSS variables, so everything here
// themes automatically.

import * as React from 'react';
import { cn } from '@/lib/cn';

// ---------- Card ----------

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Draw the handout's 2px orange hairline across the top edge. */
  accent?: boolean;
  /** Lift slightly on hover — for cards that are themselves clickable. */
  interactive?: boolean;
}
export function Card({ className, accent = false, interactive = false, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border border-line bg-surface shadow-glow',
        accent &&
          'before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-gradient-to-r ' +
          'before:from-primary-500 before:to-transparent before:to-75%',
        interactive &&
          'transition duration-200 ease-out hover:-translate-y-0.5 hover:border-primary-500/45',
        className,
      )}
      {...rest}
    />
  );
}
// ComponentPropsWithRef (not HTMLAttributes) so callers can attach a ref —
// React 19 passes ref through as a normal prop. The Test Cases toolbar needs
// one to measure its height for the sticky table header offset.
export function CardHeader({ className, ...rest }: React.ComponentPropsWithRef<'div'>) {
  return <div className={cn('px-4 py-2.5 border-b border-line', className)} {...rest} />;
}
export function CardTitle({ className, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold tracking-tight text-slate-900', className)} {...rest} />;
}
export function CardBody({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...rest} />;
}

/** Uppercase mono micro-label — the handout's `.blk-t` / `.r-kicker`. */
export function Kicker({ className, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'block font-mono text-[10px] font-semibold uppercase tracking-label text-slate-500',
        className,
      )}
      {...rest}
    />
  );
}

// ---------- Button ----------

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}
export function Button({ className, variant = 'primary', size = 'md', ...rest }: ButtonProps) {
  const v: Record<string, string> = {
    // Gradient fill + warm shadow, lifted from the handout's pressed segment.
    primary:
      'border-transparent bg-gradient-to-br from-primary-500 to-primary-600 text-on-accent ' +
      'font-semibold shadow-accent hover:from-primary-400 hover:to-primary-500',
    secondary:
      'border-line-strong bg-surface text-slate-700 hover:border-slate-400 hover:text-slate-900',
    ghost:
      'border-transparent bg-transparent text-slate-700 hover:bg-slate-100 hover:text-slate-900',
    danger:
      'border-transparent bg-red-600 text-on-accent font-semibold hover:bg-red-500',
  };
  const s: Record<string, string> = {
    sm: 'h-8 px-3 text-xs',
    md: 'h-9 px-4 text-sm',
  };
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg border font-medium',
        'transition-all duration-150 ease-out active:translate-y-px',
        'disabled:pointer-events-none disabled:opacity-50',
        'focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
        v[variant], s[size], className,
      )}
      {...rest}
    />
  );
}

// ---------- Badge ----------

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: 'default' | 'success' | 'danger' | 'warning' | 'info';
  /** Uppercase mono "tag" treatment, as on the handout's tier cards. */
  tag?: boolean;
}
export function Badge({ className, tone = 'default', tag = false, ...rest }: BadgeProps) {
  const t: Record<string, string> = {
    default: 'bg-slate-100 text-slate-700 ring-line',
    success: 'bg-emerald-50 text-emerald-700 ring-emerald-600/25',
    danger:  'bg-red-50 text-red-700 ring-red-600/25',
    warning: 'bg-amber-50 text-amber-700 ring-amber-600/25',
    info:    'bg-primary-50 text-primary-700 ring-primary-500/25',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md ring-1 ring-inset',
        tag
          ? 'px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-label'
          : 'px-2 py-0.5 text-[11px] font-medium',
        t[tone],
        className,
      )}
      {...rest}
    />
  );
}

// ---------- Input ----------

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-slate-900',
          'transition-colors placeholder:text-slate-400',
          'focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/25',
          'disabled:cursor-not-allowed disabled:opacity-60',
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
      {hint ? <span className="mt-1 block text-[11px] font-light text-slate-500">{hint}</span> : null}
    </label>
  );
}

// ---------- Stat ----------

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card accent interactive>
      <CardBody>
        <Kicker>{label}</Kicker>
        {/* Mono + tabular figures so columns of metrics line up. */}
        <div className="num mt-1.5 text-lg font-bold leading-tight text-slate-900">{value}</div>
        {hint ? <div className="mt-1 text-[11px] font-light text-slate-500">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

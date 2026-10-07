'use client';

// The field used on every authentication screen: an icon well, the input, and
// — for passwords — the eye that shows what was typed.
//
// One component so sign-in, sign-up, reset and change-password cannot drift
// into four slightly different fields, and so the accessibility details are
// written once: a real <label> tied to the input, the error announced rather
// than only coloured, and autocomplete set deliberately per use.

import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export function AuthField({
  label, value, onChange, type = 'text', placeholder, autoComplete, icon,
  error, hint, autoFocus, disabled, onEnter,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'password' | 'email';
  placeholder?: string;
  autoComplete?: string;
  icon?: React.ReactNode;
  /** Shown under the field and announced; also turns the border red. */
  error?: string | null;
  hint?: React.ReactNode;
  autoFocus?: boolean;
  disabled?: boolean;
  onEnter?: () => void;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const isPassword = type === 'password';
  const bad = !!error;

  return (
    <div className="mt-4 first:mt-0">
      <label htmlFor={id} className="block text-sm font-semibold text-slate-800 mb-1.5">{label}</label>
      <div className={
        'flex items-stretch rounded-lg border overflow-hidden bg-surface transition-colors focus-within:ring-2 ' +
        (bad ? 'border-red-400 focus-within:ring-red-200' : 'border-slate-300 focus-within:ring-blue-200 focus-within:border-blue-400')
      }>
        {icon ? (
          <span className="grid place-items-center w-11 shrink-0 border-r border-slate-200 bg-slate-50 text-slate-400" aria-hidden>
            {icon}
          </span>
        ) : null}
        <input
          id={id}
          type={isPassword && shown ? 'text' : type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) onEnter(); }}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          disabled={disabled}
          spellCheck={false}
          aria-invalid={bad || undefined}
          aria-describedby={bad ? `${id}-err` : undefined}
          className="flex-1 h-11 px-3.5 text-sm text-slate-900 bg-transparent placeholder:text-slate-400 focus:outline-none disabled:text-slate-400"
        />
        {isPassword ? (
          <button
            type="button"
            onClick={() => setShown(v => !v)}
            className="px-3 text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
            aria-label={shown ? 'Hide password' : 'Show password'}
            aria-pressed={shown}
          >
            {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        ) : null}
      </div>
      {error ? <p id={`${id}-err`} role="alert" className="mt-1.5 text-xs text-red-600">{error}</p> : null}
      {!error && hint ? <div className="mt-1.5">{hint}</div> : null}
    </div>
  );
}

/** The one button every auth form submits with: disabled while it is working,
 *  and saying so rather than looking frozen. */
export function AuthSubmit({ label, busyLabel, busy, disabled }: {
  label: string; busyLabel: string; busy: boolean; disabled?: boolean;
}) {
  const off = busy || disabled;
  return (
    <button
      type="submit"
      disabled={off}
      aria-busy={busy || undefined}
      className={
        'mt-6 w-full h-12 rounded-lg text-on-accent text-[15px] font-semibold transition-colors ' +
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 ' +
        (off ? 'bg-slate-300 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700')
      }
    >
      {busy ? (
        <span className="inline-flex items-center gap-2">
          <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden />
          {busyLabel}
        </span>
      ) : label}
    </button>
  );
}

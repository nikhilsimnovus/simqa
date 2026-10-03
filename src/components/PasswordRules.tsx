'use client';

// The password rules, shown while someone types one.
//
// Driven by the same checkPassword the server enforces with, so the list can
// never promise something the backend then rejects. It is guidance, not a
// gate: the form's own submit check and the API both decide separately.

import { checkPassword, strength } from '@/lib/passwordPolicy';

export function PasswordRules({ password, show = true }: { password: string; show?: boolean }) {
  if (!show) return null;
  const { rules } = checkPassword(password);
  const s = strength(password);

  return (
    <div className="mt-2">
      {/* A meter that is blank until there is something to measure — a bar
          sitting at zero reads as a failure before anyone has typed. */}
      {password ? (
        <div className="flex items-center gap-2 mb-2">
          <div className="h-1.5 flex-1 rounded bg-slate-200 overflow-hidden">
            <div
              className={
                'h-full transition-all ' +
                (s.score <= 1 ? 'bg-red-500' : s.score === 2 ? 'bg-amber-500' : s.score === 3 ? 'bg-blue-500' : 'bg-emerald-500')
              }
              style={{ width: `${(s.score / 4) * 100}%` }}
            />
          </div>
          <span className="text-[11px] text-slate-500 w-12 text-right">{s.label}</span>
        </div>
      ) : null}

      <ul className="grid grid-cols-2 gap-x-3 gap-y-1" aria-label="Password requirements">
        {rules.map(r => (
          <li key={r.id} className={'flex items-center gap-1.5 text-[11px] ' + (r.ok ? 'text-emerald-700' : 'text-slate-500')}>
            <span aria-hidden className={r.ok ? 'text-emerald-600' : 'text-slate-300'}>{r.ok ? '✓' : '○'}</span>
            {r.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** True when every rule passes — what a submit button should wait for. */
export function passwordMeetsPolicy(password: string): boolean {
  return checkPassword(password).ok;
}

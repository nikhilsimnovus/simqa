'use client';

// A single transient message, top-right.
//
// For the outcome of something the person just did — saved, refused — where a
// line of text buried in the form would be missed. It closes itself after a
// few seconds and can be dismissed sooner; the caller owns the state, so a
// toast can never outlive the screen that raised it.
//
// Errors stay up twice as long as confirmations: being told why something was
// refused is worth reading, being told it worked is not.

import { useEffect } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';

export type ToastKind = 'success' | 'error';
export interface ToastMessage { kind: ToastKind; title: string; message?: string }

export function Toast({ toast, onClose }: { toast: ToastMessage | null; onClose: () => void }) {
  const bad = toast?.kind === 'error';

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(onClose, bad ? 8000 : 4000);
    return () => window.clearTimeout(t);
  }, [toast, bad, onClose]);

  if (!toast) return null;

  return (
    <div
      // assertive for a refusal, polite for a confirmation: one interrupts what
      // a screen reader is saying, the other waits its turn.
      role={bad ? 'alert' : 'status'}
      aria-live={bad ? 'assertive' : 'polite'}
      className={
        'fixed right-4 top-4 z-50 w-[min(92vw,420px)] rounded-lg border bg-surface px-4 py-3 shadow-lg ' +
        (bad ? 'border-red-400' : 'border-emerald-400')
      }
    >
      <div className="flex items-start gap-2.5">
        {bad
          ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden />
          : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className={'text-sm font-bold ' + (bad ? 'text-red-600' : 'text-emerald-700')}>{toast.title}</p>
          {toast.message ? <p className="mt-0.5 break-words text-[13px] text-slate-600">{toast.message}</p> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className={'shrink-0 rounded p-0.5 ' + (bad ? 'text-red-500 hover:bg-red-50' : 'text-emerald-600 hover:bg-emerald-50')}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

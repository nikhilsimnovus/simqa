'use client';

// A confirmation the app draws itself, centred over the page.
//
// window.confirm() is the browser's dialog, not ours: it pins itself to the
// top of the window, ignores the app's theme entirely — white box on a dark
// page — and says "192.168.1.36:4100 says" above whatever you wrote. For a
// destructive action that is the one moment the message should look like it
// belongs to the thing being destroyed.
//
// `useConfirm` keeps the shape of the call it replaces:
//
//     if (!(await confirm({ title: 'Delete report 2026…?' }))) return;
//
// so a call site reads as it did, and the dialog is rendered by dropping
// {dialog} anywhere in the tree.

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface ConfirmOptions {
  title: string;
  /** The consequence, in a sentence. Shown under the title. */
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' for anything that removes or overwrites. */
  tone?: 'danger' | 'default';
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  dialog: React.ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    [],
  );

  const settle = useCallback((ok: boolean) => {
    setPending((p) => { p?.resolve(ok); return null; });
  }, []);

  // Escape cancels, as it does in every other dialog in the app — and as it
  // does in the browser's own, which this replaces.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); settle(false); }
      if (e.key === 'Enter') { e.preventDefault(); settle(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, settle]);

  // The destructive button takes focus, so Enter does the thing the dialog is
  // asking about and Tab reaches Cancel first.
  useEffect(() => { if (pending) confirmRef.current?.focus(); }, [pending]);

  const dialog = pending ? (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 px-4"
      role="presentation"
      onClick={() => settle(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={pending.title}
        className="w-full max-w-md rounded-xl border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5">
          <h2 className="text-base font-semibold text-slate-900">{pending.title}</h2>
          {pending.message ? (
            <p className="mt-2 text-sm text-slate-600 whitespace-pre-line">{pending.message}</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={() => settle(false)}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
          >
            {pending.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => settle(true)}
            className={cn(
              'rounded-md px-4 py-2 text-sm font-semibold text-on-accent',
              pending.tone === 'danger'
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-primary-600 hover:bg-primary-700',
            )}
          >
            {pending.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, dialog };
}

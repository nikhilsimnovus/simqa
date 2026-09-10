'use client';

// A <select> you can type into.
//
// Built for Pick Configuration on the testcase page, where the callbox offers
// 108 radio cfg files and 27 core ones in a native dropdown — finding
// "SA-1cell.cfg" meant scrolling a 108-row list whose names share long
// prefixes. A native <select> cannot hold a text field, so this is a button
// that opens a panel containing one.
//
// THE PANEL IS A PORTAL, and it has to be. Every Card in this app is
// `overflow-hidden` (see ui.tsx), and the Pick Configuration card ends a few
// pixels below these controls — an absolutely-positioned panel inside it is
// clipped to almost nothing, which is not obvious from the markup because a
// native <select> popup is drawn by the browser outside the DOM and never had
// the problem. So the panel renders into document.body, positioned `fixed`
// against the button's rect, which escapes ancestor overflow, transforms and
// stacking contexts alike.
//
// Deliberately not a library: the behaviour needed here is a filter, a list,
// and the four keys you expect to work.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronDown, X } from 'lucide-react';

/** Shown as the first row, always, so clearing a selection is one click and
 *  never something you have to search for. */
const NONE_LABEL = '— none —';

/** Tallest the panel is allowed to get, including its search box and footer.
 *  Used to decide whether it opens downwards or flips above the button. */
const PANEL_MAX_H = 340;

/** Below this the panel is not worth opening as a list, so a very short window
 *  gets a small scroller rather than a sliver. */
const MIN_PANEL_H = 160;

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  disabled?: boolean;
  /** Placeholder for the search box, e.g. "Search 108 files…". */
  placeholder?: string;
  /** Accessible name, since the visible label sits outside this component. */
  ariaLabel?: string;
}

export function SearchableSelect({ value, onChange, options, disabled, placeholder, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  /** Index into `filtered`, or -1 for the "none" row above it. */
  const [cursor, setCursor] = useState(-1);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; flip: boolean; maxH: number } | null>(null);

  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.toLowerCase().includes(needle));
  }, [options, q]);

  /** Where the panel goes: under the button, or above it when the viewport has
   *  no room below (these controls sit low on the page often enough). */
  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const GAP = 4;
    const MARGIN = 8;
    const below = window.innerHeight - b.bottom - GAP;
    const above = b.top - GAP;
    // Open downwards unless there is genuinely more room above.
    const flip = below < PANEL_MAX_H && above > below;
    // Never taller than the side it opens on. Without this a control low in a
    // short window gets a 340px panel hanging off the screen, with the rows at
    // the bottom unreachable.
    const maxH = Math.max(MIN_PANEL_H, Math.min(PANEL_MAX_H, (flip ? above : below) - MARGIN));
    // And never off the right edge, for a control near it.
    const left = Math.max(MARGIN, Math.min(b.left, window.innerWidth - b.width - MARGIN));
    setRect({ top: flip ? b.top : b.bottom + GAP, left, width: b.width, flip, maxH });
  }, []);

  // Position before paint, so the panel never appears in the wrong place first.
  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  // Follow the button if anything scrolls or the window resizes. `true` puts
  // the scroll listener in the capture phase, so scrolling an inner pane —
  // which does not bubble — still repositions the panel.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place]);

  // Close on a click anywhere else. The panel is a portal, so "elsewhere" has
  // to exclude BOTH the button and the panel — checking only the button's
  // subtree would close it on every click inside the list. Tracked on mousedown
  // rather than blur, which fires before the click on a row lands.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Opening resets the filter and focuses the box, so opening and typing is one
  // gesture rather than open-then-click-the-field.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setCursor(-1);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Keep the highlighted row in view when arrowing through 108 of them.
  useEffect(() => {
    if (!open || cursor < 0) return;
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  const pick = (v: string) => { onChange(v); setOpen(false); btnRef.current?.focus(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, -1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      pick(cursor < 0 ? '' : filtered[cursor] ?? '');
    }
  };

  const panel = open && rect && typeof document !== 'undefined' ? createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        ...(rect.flip
          ? { bottom: window.innerHeight - rect.top + 4, maxHeight: rect.maxH }
          : { top: rect.top, maxHeight: rect.maxH }),
      }}
      className="z-[100] flex flex-col rounded-lg border border-line-strong bg-surface shadow-xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-2.5 py-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setCursor(-1); }}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? `Search ${options.length} files…`}
          className="w-full bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
        />
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        <button
          type="button"
          data-idx={-1}
          onClick={() => pick('')}
          className={`block w-full truncate px-3 py-1.5 text-left text-sm text-slate-500 hover:bg-slate-100 ${cursor === -1 ? 'bg-slate-100' : ''}`}
        >
          {NONE_LABEL}
        </button>

        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-xs text-slate-500">No file matches “{q}”.</div>
        ) : filtered.map((o, i) => (
          <button
            key={o}
            type="button"
            data-idx={i}
            onClick={() => pick(o)}
            title={o}
            className={
              'block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-slate-100 ' +
              (o === value ? 'font-medium text-primary-700 ' : 'text-slate-800 ') +
              (cursor === i ? 'bg-slate-100' : '')
            }
          >
            {o}
          </button>
        ))}
      </div>

      {/* Says how much of the list you are looking at — with 108 files, a
          filter that hides 104 of them should say so. */}
      <div className="shrink-0 border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
        {filtered.length === options.length
          ? `${options.length} file${options.length === 1 ? '' : 's'}`
          : `${filtered.length} of ${options.length} files`}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { e.preventDefault(); setOpen(true); } }}
        className={
          'w-full h-9 rounded-lg border border-line-strong bg-surface px-3 text-sm text-left flex items-center gap-2 ' +
          'transition-colors focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/25 ' +
          'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400'
        }
      >
        <span className={`flex-1 truncate ${value ? 'text-slate-900' : 'text-slate-400'}`} title={value || NONE_LABEL}>
          {value || NONE_LABEL}
        </span>
        {/* Clearing without opening the panel — the common correction after
            picking the wrong file. A <button> inside a <button> is invalid, so
            this is a span carrying the click. */}
        {value && !disabled ? (
          <span
            role="button"
            aria-label="Clear"
            onClick={(e) => { e.stopPropagation(); onChange(''); }}
            className="shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {panel}
    </div>
  );
}

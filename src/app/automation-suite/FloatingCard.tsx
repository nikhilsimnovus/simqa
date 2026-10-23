'use client';

// A hover card that is not trapped inside the table.
//
// The test case table scrolls sideways, so its container is
// `overflow-x: auto` — and CSS makes the other axis `auto` with it. An
// absolutely positioned card hanging below a row was therefore CLIPPED at the
// bottom of that box: the card was being rendered correctly and could not be
// seen, which is the worst way for a feature to fail.
//
// So the card goes into a portal on <body>, positioned from the cell's own
// rectangle: below it when there is room, above it when there is not, and
// never off the side of the window. It also stays up while the pointer is on
// IT rather than on the cell, because a card you cannot move onto is a card
// you cannot read to the end of.

import React, { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function FloatingCard({ anchor, width = 440, onMouseEnter, onMouseLeave, onDoubleClick, children }: {
  /** The cell this card belongs to. Null closes it. */
  anchor: HTMLElement | null;
  width?: number;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) { setPos(null); return; }
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const gap = 6;
      const edge = 8;
      const below = window.innerHeight - r.bottom - gap - edge;
      const above = r.top - gap - edge;
      // Below unless there is plainly more room above: a card that flips for
      // the sake of four pixels moves around while you read it.
      const useBelow = below >= 220 || below >= above;
      const maxHeight = Math.max(160, Math.min(520, useBelow ? below : above));
      const left = Math.min(Math.max(edge, r.left), Math.max(edge, window.innerWidth - width - edge));
      setPos({ left, top: useBelow ? r.bottom + gap : Math.max(edge, r.top - gap - maxHeight), maxHeight });
    };
    place();
    // Follow the cell if the page moves under it.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, width]);

  if (!anchor || !pos || typeof document === 'undefined') return null;

  return createPortal(
    <div
      style={{ position: 'fixed', left: pos.left, top: pos.top, width, maxHeight: pos.maxHeight }}
      className="z-[60] overflow-auto cursor-default whitespace-normal rounded-lg border border-line
                 bg-surface p-3 text-left shadow-xl"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onDoubleClick={onDoubleClick}>
      {children}
    </div>,
    document.body,
  );
}

/**
 * Open/closed state for a hover card, with the small delay that makes one
 * usable: leaving the cell does not shut it instantly, so the pointer can
 * travel onto the card.
 */
export function useHoverAnchor(): {
  anchor: HTMLElement | null;
  cellProps: { ref: (el: HTMLElement | null) => void; onMouseEnter: () => void; onMouseLeave: () => void };
  cardProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  close: () => void;
} {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const show = () => { cancel(); setOpen(true); };
  const hide = () => { cancel(); timer.current = setTimeout(() => setOpen(false), 140); };

  React.useEffect(() => cancel, []);

  return {
    anchor: open ? el : null,
    cellProps: { ref: setEl, onMouseEnter: show, onMouseLeave: hide },
    cardProps: { onMouseEnter: show, onMouseLeave: hide },
    close: () => { cancel(); setOpen(false); },
  };
}

// Spreadsheet-style resizable table columns.
//
// Extracted from the Run History table so /testcases could have the same
// behaviour without a second copy of the drag logic — two copies of a
// pointer-tracking effect drift, and the subtleties below are exactly the kind
// that get lost in a copy:
//
//   - The drag is tracked on the WINDOW, not on the handle. The pointer
//     routinely leaves a few-pixel strip mid-drag, and a handle-scoped
//     listener drops the resize the moment it does.
//   - The table must be `table-fixed` with a <colgroup>. Under the default
//     auto layout the browser re-derives widths from the content, so a dragged
//     width springs back on the next render.
//   - Cells want `truncate`, so a narrowed column clips with an ellipsis
//     instead of spilling into its neighbour.

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/** Narrow enough to tuck a column out of the way, wide enough that its own
 *  resize handle stays grabbable. */
export const MIN_COL_WIDTH = 48;

export interface ColumnWidths {
  /** Current width of each column, in table order. */
  colWidths: number[];
  /** Sum of the widths — the table's `width`, so it can exceed its pane and
   *  scroll horizontally. Pair with `minWidth: '100%'` to fill a wider one. */
  tableWidth: number;
  /** `onMouseDown` for the handle on column `index`'s right edge. */
  startResize: (index: number) => (ev: React.MouseEvent) => void;
}

export function useColumnWidths(defaults: number[]): ColumnWidths {
  const [colWidths, setColWidths] = useState<number[]>(defaults);
  const dragRef = useRef<{ index: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const next = Math.max(MIN_COL_WIDTH, d.startWidth + (ev.clientX - d.startX));
      setColWidths((prev) => {
        if (prev[d.index] === next) return prev;
        const copy = [...prev];
        copy[d.index] = next;
        return copy;
      });
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startResize = (index: number) => (ev: React.MouseEvent) => {
    // stopPropagation keeps the drag from also firing the heading's sort.
    ev.preventDefault();
    ev.stopPropagation();
    dragRef.current = { index, startX: ev.clientX, startWidth: colWidths[index] };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const tableWidth = useMemo(() => colWidths.reduce((a, b) => a + b, 0), [colWidths]);

  return { colWidths, tableWidth, startResize };
}

/** The grab strip on a column's right edge. Sits over the column rule so the
 *  target is the line you'd aim at, and is wider than it looks because a 1px
 *  target is not grabbable. Its <th> needs `relative`. */
export function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <span
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize select-none hover:bg-sky-400/40"
      aria-hidden
    />
  );
}

/** `<colgroup>` for a table driven by useColumnWidths. */
export function ColGroup({ widths }: { widths: number[] }) {
  return (
    <colgroup>
      {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
    </colgroup>
  );
}

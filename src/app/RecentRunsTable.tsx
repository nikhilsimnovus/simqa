'use client';

// Recent runs, as a spreadsheet.
//
// This was two columns — the testcase name with its timestamp stacked
// underneath, and a status badge — inside a half-width card, both `truncate`.
// A long name (the CSI testcases are the ones that showed it) was clipped with
// no way to see the rest, because the column had no width of its own to give.
//
// So: the same table the Run History and Test Cases pages use. `table-fixed`
// with a <colgroup>, drag any column's right edge to widen it, and the table
// scrolls sideways inside the card rather than stretching it. Started moves
// into its own column instead of hiding under the name.
//
// A server component renders this, so the rows arrive already formatted:
// stamping the date here would format it in the browser's timezone over
// server-rendered HTML that used the server's, and React would flag the
// mismatch.

import Link from 'next/link';
import { Badge } from '@/components/ui';
import { useColumnWidths, ResizeHandle, ColGroup } from '@/components/resizableColumns';

export interface RecentRunRow {
  key: string;
  href: string;
  name: string;
  /** Both already formatted — see the note above. `window` is the
   *  "start – end · date" line that sits under the duration. */
  duration: string;
  window: string;
  status: string;
}

/** Test Case gets the width, because the name is what gets clipped. */
const DEFAULT_COL_WIDTHS = [250, 210, 110];

/** Covers simqa's own run states AND the verdicts the box reports for
 *  executions started from its GUI (incomplete / aborted / stopped / error).
 *  Moved here from the dashboard page with the table it belongs to. */
function RunStatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (s === 'passed' || s === 'pass')       return <Badge tone="success">passed</Badge>;
  if (s === 'failed' || s === 'fail')       return <Badge tone="danger">failed</Badge>;
  if (s === 'error')                        return <Badge tone="danger">error</Badge>;
  if (s === 'in progress' || s === 'running') return <Badge tone="info">in progress</Badge>;
  if (s === 'queued')                       return <Badge tone="warning">queued</Badge>;
  if (s === 'incomplete' || s === 'aborted' || s === 'stopped') return <Badge tone="warning">{s}</Badge>;
  return <Badge>{s}</Badge>;
}

export function RecentRunsTable({ rows }: { rows: RecentRunRow[] }) {
  const { colWidths, tableWidth, startResize } = useColumnWidths(DEFAULT_COL_WIDTHS);

  return (
    <div className="overflow-x-auto">
      <table className="text-sm table-fixed" style={{ width: tableWidth, minWidth: '100%' }}>
        <ColGroup widths={colWidths} />
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            {['Test Case', 'Duration', 'Status'].map((label, i) => (
              <th
                key={label}
                className={`relative px-4 py-2 font-medium border-r border-slate-200 last:border-r-0 ${i === 2 ? 'text-right' : 'text-left'}`}
              >
                <span className="truncate block">{label}</span>
                {i < colWidths.length - 1 ? <ResizeHandle onMouseDown={startResize(i)} /> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.key} className="hover:bg-slate-50">
              {/* title so the full name is readable even when the column is
                  narrow — a truncated name you cannot inspect is the bug this
                  table exists to fix. */}
              <td className="px-4 py-2.5 border-r border-slate-100">
                <Link href={r.href} className="block truncate text-sm font-medium text-slate-900" title={r.name}>
                  {r.name}
                </Link>
              </td>
              {/* No host or origin column: the list is already scoped to the
                  selected box, and it deliberately merges runs started from
                  SimQA with the box's own. */}
              {/* How long, and under it when — start to end with the date.
                  One column rather than two: they are the same fact, and the
                  card is narrow enough that a separate end column cost the
                  testcase name width it needed more. */}
              <td className="px-4 py-2.5 border-r border-slate-100" title={r.window}>
                <div className="text-sm text-slate-700 num truncate">{r.duration}</div>
                <div className="text-xs text-slate-500 truncate">{r.window}</div>
              </td>
              <td className="px-4 py-2.5 text-right">
                <RunStatusBadge status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

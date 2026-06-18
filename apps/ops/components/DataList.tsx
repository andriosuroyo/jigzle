'use client';

import type { ReactNode } from 'react';

// Shared responsive list primitive: ONE column config renders a real <table> on desktop and
// stacked, labeled cards on mobile (≤760px). Presentational/uncontrolled — sort state lives in the
// consumer; DataList just calls onSort(key). Desktop reuses the existing .inv-table styling so
// boards that adopt it look unchanged on a wide screen.

export type SortDir = 'asc' | 'desc';

export type DataListColumn<T> = {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  mobileLabel?: string; // label on the mobile card; defaults to header
  sortable?: boolean;
  primary?: boolean; // on mobile, render as the card heading (no label)
  className?: string; // extra class on the <td> / mobile value
  thClassName?: string; // extra class on the <th>
  hideOnMobile?: boolean; // skip this column in the mobile card
};

export type DataListProps<T> = {
  rows: T[];
  columns: DataListColumn<T>[];
  getRowKey: (row: T) => string;
  sort?: { column: string; dir: SortDir };
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  rowLimitNote?: ReactNode;
};

export default function DataList<T>({
  rows,
  columns,
  getRowKey,
  sort,
  onSort,
  onRowClick,
  empty,
  rowLimitNote,
}: DataListProps<T>) {
  const emptyNode = empty ?? 'Nothing to show.';
  const cellValue = (col: DataListColumn<T>, row: T): ReactNode =>
    col.render ? col.render(row) : ((row as Record<string, unknown>)[col.key] as ReactNode);
  const alignClass = (col: DataListColumn<T>) => (col.align === 'right' ? 'num' : col.align === 'center' ? 'ctr' : '');
  const sortableCols = columns.filter((c) => c.sortable);

  return (
    <div className="datalist">
      {/* Mobile-only sort control (the table headers are the desktop sort affordance). */}
      {onSort && sortableCols.length > 0 && (
        <div className="datalist-sort">
          <label htmlFor="datalist-sort-sel">Sort</label>
          <select
            id="datalist-sort-sel"
            value={sort?.column ?? ''}
            onChange={(e) => onSort(e.target.value)}
          >
            {sortableCols.map((c) => (
              <option key={c.key} value={c.key}>{c.header}</option>
            ))}
          </select>
          {sort && (
            <button
              type="button"
              className="datalist-sort-dir"
              onClick={() => onSort(sort.column)}
              aria-label={`Toggle sort direction (currently ${sort.dir === 'asc' ? 'ascending' : 'descending'})`}
            >
              {sort.dir === 'asc' ? '▲' : '▼'}
            </button>
          )}
        </div>
      )}

      {/* Desktop: table */}
      <div className="inv-table-wrap datalist-table">
        <table className="inv-table">
          <thead>
            <tr>
              {columns.map((c) => {
                const isSorted = sort?.column === c.key;
                const sortable = !!(c.sortable && onSort);
                return (
                  <th
                    key={c.key}
                    className={[alignClass(c), c.thClassName].filter(Boolean).join(' ') || undefined}
                    onClick={sortable ? () => onSort!(c.key) : undefined}
                    style={sortable ? { cursor: 'pointer' } : undefined}
                    aria-sort={isSorted ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {c.header}
                    {isSorted && <span className="sort-ind">{sort!.dir === 'asc' ? '▲' : '▼'}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="inv-empty" colSpan={columns.length}>{emptyNode}</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={getRowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={onRowClick ? { cursor: 'pointer' } : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={[alignClass(c), c.className].filter(Boolean).join(' ') || undefined}>
                      {cellValue(c, row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile: one labeled card per row */}
      <div className="datalist-cards">
        {rows.length === 0 ? (
          <div className="datalist-empty">{emptyNode}</div>
        ) : (
          rows.map((row) => (
            <div
              key={getRowKey(row)}
              className="datalist-card"
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={onRowClick ? { cursor: 'pointer' } : undefined}
            >
              {columns
                .filter((c) => !c.hideOnMobile)
                .map((c) =>
                  c.primary ? (
                    <div key={c.key} className="datalist-card-head">{cellValue(c, row)}</div>
                  ) : (
                    <div key={c.key} className="datalist-card-row">
                      <span className="datalist-card-label">{c.mobileLabel ?? c.header}</span>
                      <span className={['datalist-card-val', c.className].filter(Boolean).join(' ') || undefined}>
                        {cellValue(c, row)}
                      </span>
                    </div>
                  )
                )}
            </div>
          ))
        )}
      </div>

      {rowLimitNote && <div className="inv-count">{rowLimitNote}</div>}
    </div>
  );
}

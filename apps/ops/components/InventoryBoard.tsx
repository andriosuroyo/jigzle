'use client';

import { useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import type { InventoryFilter, InventorySortColumn, InventoryState, StockRow } from '@jigzle/db/types';
import { getInventory, refreshSnapshot } from '@/app/inventory/actions';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';

const ROW_LIMIT = 1000; // matches the server LIMIT — used only for the "refine your search" hint

const STATES: { key: InventoryState; label: string }[] = [
  { key: 'all', label: 'all active' },
  { key: 'on_order', label: 'on order' },
  { key: 'shipping', label: 'being shipped' },
  { key: 'warehouse', label: 'in warehouse' },
];

const COLUMNS: { key: InventorySortColumn; label: string; num: boolean }[] = [
  { key: 'item_code', label: 'SKU', num: false },
  { key: 'name', label: 'Name', num: false },
  { key: 'pending', label: 'On order', num: true },
  { key: 'on_the_way', label: 'Shipping', num: true },
  { key: 'physical', label: 'Warehouse', num: true },
  { key: 'available', label: 'Available', num: true },
  { key: 'last_receive', label: 'Last in', num: false },
];

// numeric columns + last-received default to descending (most stock / most recent first)
function defaultDir(col: InventorySortColumn): 'asc' | 'desc' {
  return col === 'item_code' || col === 'name' ? 'asc' : 'desc';
}

function fmtAsOf(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function InventoryBoard({
  initialRows,
  refreshedAt: initialRefreshedAt,
  userEmail,
}: {
  initialRows: StockRow[];
  refreshedAt: string | null;
  userEmail: string;
}) {
  const [rows, setRows] = useState<StockRow[]>(initialRows);
  const [search, setSearch] = useState('');
  const [state, setState] = useState<InventoryState>('all');
  const [sort, setSort] = useState<{ column: InventorySortColumn; dir: 'asc' | 'desc' }>({ column: 'item_code', dir: 'asc' });
  const [refreshedAt, setRefreshedAt] = useState<string | null>(initialRefreshedAt);

  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  async function runLoad(f: InventoryFilter) {
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const r = await getInventory(f);
      if (reqRef.current !== myReq) return; // superseded by a newer request
      setRows(r);
      if (r[0]?.refreshed_at) setRefreshedAt(r[0].refreshed_at);
    } catch (e) {
      if (reqRef.current !== myReq) return;
      setError(e instanceof Error ? e.message : 'Failed to load inventory.');
    } finally {
      if (reqRef.current === myReq) setLoading(false);
    }
  }

  function submitSearch() {
    runLoad({ search, state, sort });
  }
  function pickState(s: InventoryState) {
    setState(s);
    runLoad({ search, state: s, sort });
  }
  function clickSort(col: InventorySortColumn) {
    const dir: 'asc' | 'desc' = sort.column === col ? (sort.dir === 'asc' ? 'desc' : 'asc') : defaultDir(col);
    const next = { column: col, dir };
    setSort(next);
    runLoad({ search, state, sort: next });
  }
  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const { refreshed_at } = await refreshSnapshot();
      if (refreshed_at) setRefreshedAt(refreshed_at);
      await runLoad({ search, state, sort });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  }

  const truncated = rows.length >= ROW_LIMIT;

  // SKU images for the visible rows — lazy; only on-screen rows fetch (browser/CDN handles it).
  const imgCodes = useMemo(() => rows.map((r) => r.item_code), [rows]);
  const imgMap = useSkuImages(imgCodes);

  return (
    <div className="ops">
      <AppHeader active="inventory" userEmail={userEmail} />

      <div className="inv-wrap">
        <div className="inv-bar">
          <div className="inv-search">
            <input
              type="text"
              placeholder="search SKU code or name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitSearch(); } }}
            />
            <button className="btn-secondary" onClick={submitSearch} disabled={loading}>{loading ? '…' : 'search'}</button>
          </div>
          <div className="inv-asof">
            <span>as of {fmtAsOf(refreshedAt)}</span>
            <button className="btn-secondary" onClick={refresh} disabled={refreshing}>{refreshing ? 'refreshing…' : '⟳ refresh'}</button>
          </div>
        </div>

        <div className="inv-states">
          {STATES.map((s) => (
            <button key={s.key} className={`inv-state ${state === s.key ? 'active' : ''}`} onClick={() => pickState(s.key)}>{s.label}</button>
          ))}
        </div>

        {error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}

        <div className="inv-table-wrap" style={{ marginTop: 12 }}>
          <table className="inv-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.key} className={c.num ? 'num' : ''} onClick={() => clickSort(c.key)}>
                    {c.label}
                    {sort.column === c.key && <span className="sort-ind">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td className="inv-empty" colSpan={COLUMNS.length}>{loading ? 'Loading…' : 'No matching SKUs.'}</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.item_code}>
                  <td className="inv-code"><span className="inv-code-cell"><SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name || ''} size={26} />{r.item_code}</span></td>
                  <td className="inv-name">{r.name || '—'}</td>
                  <td className={`num inv-num ${r.pending ? '' : 'zero'}`}>{r.pending}</td>
                  <td className={`num inv-num ${r.on_the_way ? '' : 'zero'}`}>{r.on_the_way}</td>
                  <td className={`num inv-num ${r.physical ? '' : 'zero'}`}>{r.physical}</td>
                  <td className={`num inv-num ${r.available ? '' : 'zero'}`}>{r.available}</td>
                  <td>{r.last_receive || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="inv-count">
          {rows.length} SKU{rows.length === 1 ? '' : 's'}{truncated ? ` — showing the first ${ROW_LIMIT}; refine your search to narrow` : ''} · read-only
        </div>
      </div>
    </div>
  );
}

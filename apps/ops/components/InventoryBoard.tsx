'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import type { InventoryFilter, InventorySortColumn, InventoryState, StockRow } from '@jigzle/db/types';
import { getInventory, refreshSnapshot } from '@/app/inventory/actions';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import DataList, { type DataListColumn } from '@/components/DataList';

const ROW_LIMIT = 1000; // matches the server LIMIT — used only for the "refine your search" hint

const STATES: { key: InventoryState; label: string }[] = [
  { key: 'all', label: 'all active' },
  { key: 'on_order', label: 'on order' },
  { key: 'shipping', label: 'being shipped' },
  { key: 'warehouse', label: 'in warehouse' },
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
  const firstRun = useRef(true); // skip the debounced refetch on mount (initialRows already loaded)

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
  // live search: debounce the text query (empty = show all). The `state` dropdown auto-applies
  // via pickState; sort via clickSort — so only `search` drives this effect. Skip the mount run —
  // initialRows is already loaded — so we only refetch once the user types.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => { submitSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
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

  const numCell = (n: number) => <span className={`inv-num ${n ? '' : 'zero'}`}>{n}</span>;
  const columns: DataListColumn<StockRow>[] = [
    {
      key: 'item_code', header: 'SKU', sortable: true, primary: true, className: 'inv-code',
      render: (r) => (
        <span className="inv-code-cell">
          <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name || ''} size={SKU_IMG.sm} />
          {r.item_code}
        </span>
      ),
    },
    { key: 'name', header: 'Name', sortable: true, className: 'inv-name', render: (r) => r.name || '—' },
    { key: 'pending', header: 'On order', align: 'right', sortable: true, render: (r) => numCell(r.pending) },
    { key: 'on_the_way', header: 'Shipping', align: 'right', sortable: true, render: (r) => numCell(r.on_the_way) },
    { key: 'physical', header: 'Warehouse', align: 'right', sortable: true, render: (r) => numCell(r.physical) },
    { key: 'available', header: 'Available', align: 'right', sortable: true, render: (r) => numCell(r.available) },
    { key: 'last_receive', header: 'Last in', sortable: true, render: (r) => r.last_receive || '—' },
  ];

  return (
    <div className="ops">
      <AppHeader active="inventory" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Inventory', href: '/inventory' }, { label: STATES.find((s) => s.key === state)?.label ?? 'all active' }]} />

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

        <div style={{ marginTop: 12 }}>
          <DataList<StockRow>
            rows={rows}
            columns={columns}
            getRowKey={(r) => r.item_code}
            sort={sort}
            onSort={(key) => clickSort(key as InventorySortColumn)}
            empty={loading ? 'Loading…' : 'No matching SKUs.'}
            rowLimitNote={`${rows.length} SKU${rows.length === 1 ? '' : 's'}${truncated ? ` — showing the first ${ROW_LIMIT}; refine your search to narrow` : ''} · read-only`}
          />
        </div>
      </div>
    </div>
  );
}

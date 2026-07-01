'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import type { InventoryCounts, InventoryFilter, InventoryState, StockRow } from '@jigzle/db/types';
import { getInventory, getInventoryCounts, refreshSnapshot } from '@/app/inventory/actions';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const ROW_LIMIT = 1000; // matches the server LIMIT — used only for the "refine your search" hint

// Tabs: All + the three inventory states. Each stat also renders on the card with the same icon.
const STATES: { key: InventoryState; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'on_order', label: 'On order' },
  { key: 'shipping', label: 'Shipped' },
  { key: 'warehouse', label: 'Warehouse' },
];

// compact stat icons (line style, inherit currentColor). On order = incoming order, Shipped = truck,
// Warehouse = box. Kept tiny (14px) for the dense card.
const IconOnOrder = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 2l1.5 3M18 2l-1.5 3M3 6h18l-1.6 8.5a2 2 0 0 1-2 1.6H8.1" /><circle cx="9" cy="20" r="1.4" /><circle cx="17" cy="20" r="1.4" />
  </svg>
);
const IconShipped = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 5h13v11H1zM14 8h4l3 3v5h-7" /><circle cx="6" cy="18" r="1.6" /><circle cx="18" cy="18" r="1.6" />
  </svg>
);
const IconWarehouse = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 21V8l9-5 9 5v13M3 21h18M9 21v-6h6v6" />
  </svg>
);

function fmtAsOf(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// compact time-only label for the inline refresh control (full date lives in the button title)
function fmtAsOfShort(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function InventoryBoard({
  initialRows,
  initialCounts,
  refreshedAt: initialRefreshedAt,
  userEmail,
}: {
  initialRows: StockRow[];
  initialCounts: InventoryCounts;
  refreshedAt: string | null;
  userEmail: string;
}) {
  const [rows, setRows] = useState<StockRow[]>(initialRows);
  const [counts, setCounts] = useState<InventoryCounts>(initialCounts);
  const [search, setSearch] = useState('');
  const [state, setState] = useState<InventoryState>('all');
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
    runLoad({ search, state });
  }
  // live search: debounce the text query (empty = show all). Skip the mount run — initialRows is
  // already loaded — so we only refetch once the user types.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => { submitSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function pickState(s: InventoryState) {
    setState(s);
    runLoad({ search, state: s });
  }

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const { refreshed_at } = await refreshSnapshot();
      if (refreshed_at) setRefreshedAt(refreshed_at);
      const [, freshCounts] = await Promise.all([
        runLoad({ search, state }),
        getInventoryCounts(),
      ]);
      setCounts(freshCounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  }

  // auto-refresh the snapshot the first time Inventory is opened, so the numbers are current without
  // a manual tap. Runs once on mount.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const truncated = rows.length >= ROW_LIMIT;

  // SKU images for the visible rows — lazy; only on-screen rows fetch (browser/CDN handles it).
  const imgCodes = useMemo(() => rows.map((r) => r.item_code), [rows]);
  const imgMap = useSkuImages(imgCodes);

  const countFor = (k: InventoryState) => counts[k];

  return (
    <div className="ops">
      <AppHeader active="inventory" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Inventory', href: '/inventory' }, { label: STATES.find((s) => s.key === state)?.label ?? 'All' }]} />

      <div className="inv-wrap">
        {/* autocomplete-style search bar; the refresh + "as of" timestamp fold into its right edge to
            reclaim the row they used to occupy. */}
        <div className="search-row inv-search-row">
          <input
            type="text"
            placeholder="search SKU code or name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitSearch(); } }}
          />
          {search && <button className="btn-link" onClick={() => setSearch('')}>Clear</button>}
          <span className="inv-asof-inline" title={`Stock as of ${fmtAsOf(refreshedAt)}`}>{fmtAsOfShort(refreshedAt)}</span>
          <button className={`inv-refresh ${refreshing ? 'spin' : ''}`} onClick={refresh} disabled={refreshing} aria-label="Refresh stock" title={`Stock as of ${fmtAsOf(refreshedAt)} — tap to refresh`}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>

        {/* underline tabs with live counts (mirrors the Pending queue filter) */}
        <div className="fq-filters" role="tablist" aria-label="Filter by stock state">
          {STATES.map((s) => (
            <button
              key={s.key}
              role="tab"
              aria-selected={state === s.key}
              className={`fq-filter ${state === s.key ? 'active' : ''}`}
              onClick={() => pickState(s.key)}
              disabled={loading}
            >
              {s.label}
              <span className="fq-filter-count">{countFor(s.key)}</span>
            </button>
          ))}
        </div>

        {error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}

        <div className="inv-cards">
          {rows.length === 0 && <div className="inv-empty">{loading ? 'Loading…' : 'No matching SKUs.'}</div>}
          {rows.map((r) => (
            <div key={r.item_code} className="inv-card">
              <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name || ''} size={SKU_IMG.sm} />
              <div className="inv-card-main">
                <div className="inv-card-code">{r.item_code}</div>
                <div className="inv-card-name">{r.name || '—'}</div>
              </div>
              <div className="inv-card-stats">
                <span className={`inv-stat ${r.pending ? '' : 'zero'}`} title="On order"><IconOnOrder />{r.pending}</span>
                <span className={`inv-stat ${r.on_the_way ? '' : 'zero'}`} title="Shipped"><IconShipped />{r.on_the_way}</span>
                <span className={`inv-stat ${r.physical ? '' : 'zero'}`} title="Warehouse"><IconWarehouse />{r.physical}</span>
                {r.on_hold > 0 && <span className="inv-hold" title="Held for a customer">On hold: {r.on_hold}</span>}
              </div>
            </div>
          ))}
        </div>

        {rows.length > 0 && (
          <div className="inv-count">
            {rows.length} SKU{rows.length === 1 ? '' : 's'}{truncated ? ` — showing the first ${ROW_LIMIT}; refine your search to narrow` : ''} · read-only
          </div>
        )}
      </div>
    </div>
  );
}

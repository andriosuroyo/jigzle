'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import type { InventoryCounts, InventoryFilter, InventoryState, StockRow } from '@jigzle/db/types';
import { getInventory, getInventoryCounts, refreshSnapshot, getSkuLedger, getLedgerSkus } from '@/app/inventory/actions';
import type { SkuLedger, LedgerSku } from '@/app/inventory/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import SearchInput from '@/components/SearchInput';
import { isRealName } from '@/components/skuName';
import { IconOnOrder, IconShipped, IconWarehouse } from '@/components/StockStats';
import AdjustmentsTab from '@/components/AdjustmentsTab';
import StockCheckBoard from '@/components/StockCheckBoard';
import type { BrandOption, SessionRow } from '@/app/stock-check/types';
import { fmtNiceDate } from '@jigzle/lib';

const ROW_LIMIT = 1000; // matches the server LIMIT — used only for the "refine your search" hint

// Tabs: All + the three inventory states. Each stat also renders on the card with the same icon.
const STATES: { key: InventoryState; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'on_order', label: 'On order' },
  { key: 'shipping', label: 'Shipped' },
  { key: 'warehouse', label: 'Warehouse' },
];

// compact stat icons — extracted to the shared StockStats module (PR156) so Sales' item search shows
// the same On order / Shipped / Warehouse glyphs.

function fmtAsOf(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// compact two-line label for the inline refresh control: date over time (full date in the title)
function fmtAsOfDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtAsOfTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function InventoryBoard({
  initialRows,
  initialCounts,
  refreshedAt: initialRefreshedAt,
  userEmail,
  stockSessions,
  brands,
}: {
  initialRows: StockRow[];
  initialCounts: InventoryCounts;
  refreshedAt: string | null;
  userEmail: string;
  // PR171: Stock Count folded into Inventory as a mode (Stock Check nav item retired)
  stockSessions: SessionRow[];
  brands: BrandOption[];
}) {
  const [rows, setRows] = useState<StockRow[]>(initialRows);
  const [counts, setCounts] = useState<InventoryCounts>(initialCounts);
  const [view, setView] = useState<'browse' | 'adjustments' | 'history'>('browse'); // PR170: adjustments; PR176: history
  const [countMode, setCountMode] = useState(false); // PR171: Stock Count mode (embedded StockCheckBoard)
  const [ledger, setLedger] = useState<SkuLedger | null>(null); // PR172: per-SKU stock ledger drill-down
  const [ledgerCode, setLedgerCode] = useState<string | null>(null); // the SKU whose ledger is open (loading gate)

  // PR176 — History tab: the A-Z list of SKUs that have moved; tap one to open its in/out ledger.
  const [histSearch, setHistSearch] = useState('');
  const [histRows, setHistRows] = useState<LedgerSku[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const histReq = useRef(0);
  const histLoaded = useRef(false);

  async function loadHist(term: string) {
    const myReq = ++histReq.current;
    setHistLoading(true);
    try {
      const r = await getLedgerSkus(term || undefined);
      if (histReq.current === myReq) setHistRows(r);
    } catch {
      if (histReq.current === myReq) setHistRows([]);
    } finally {
      if (histReq.current === myReq) setHistLoading(false);
    }
  }
  // load the History list when the tab is first opened, then refresh on debounced search
  useEffect(() => {
    if (view !== 'history') return;
    if (!histLoaded.current) { histLoaded.current = true; void loadHist(histSearch); return; }
    const t = setTimeout(() => { void loadHist(histSearch); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, histSearch]);

  async function openLedger(code: string) {
    setLedgerCode(code); setLedger(null);
    try {
      const l = await getSkuLedger(code);
      setLedgerCode((cur) => { if (cur === code) setLedger(l); return cur; }); // commit only if still the open SKU
    } catch { setLedgerCode((cur) => (cur === code ? null : cur)); }
  }
  function closeLedger() { setLedgerCode(null); setLedger(null); }
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
  // cover both the Browse rows and the History list so a ledger opened from either tab has its image
  const imgCodes = useMemo(() => [...rows.map((r) => r.item_code), ...histRows.map((h) => h.item_code)], [rows, histRows]);
  const imgMap = useSkuImages(imgCodes);

  const countFor = (k: InventoryState) => counts[k];

  // Breadcrumb: Home › Inventory › <tab> [› <state/SKU> for Browse] (PR173).
  const stateLabel = STATES.find((s) => s.key === state)?.label ?? 'All';
  const crumbs: { label: string; href?: string; onClick?: () => void }[] = [
    { label: 'Home', href: '/' },
    { label: 'Inventory', href: '/inventory' },
  ];
  if (countMode) crumbs.push({ label: 'Stock Count' });
  else if (view === 'adjustments') crumbs.push({ label: 'Adjustments' });
  else if (view === 'history') {
    if (ledgerCode) {
      crumbs.push({ label: 'History', onClick: closeLedger });
      crumbs.push({ label: ledger?.item_code ?? ledgerCode });
    } else {
      crumbs.push({ label: 'History' });
    }
  } else {
    crumbs.push({ label: 'Browse', onClick: closeLedger });
    crumbs.push({ label: ledgerCode ? (ledger?.item_code ?? ledgerCode) : stateLabel });
  }

  return (
    <div className="ops">
      <AppHeader active="inventory" userEmail={userEmail} />
      <Breadcrumbs items={crumbs} />

      {/* PR171 — Stock Count is a MODE of Inventory (its own nav item retired); the count workspace
          renders embedded, with its own "← back to Inventory". */}
      {countMode ? (
        <StockCheckBoard embedded onExitEmbed={() => setCountMode(false)} initialSessions={stockSessions} brands={brands} userEmail={userEmail} />
      ) : (
      <div className="inv-wrap">
        {/* PR170 — Inventory owns the two-way stock views: Browse (read-only levels) + Adjustments
            (the signed ± ledger, moved here from Stock Check since Inbound is +only). PR171 adds the
            Stock Count launcher on the right of the tab row. */}
        <div className="inv-tabrow">
          <div className="sc-tabs">
            <button className={`sc-tab ${view === 'browse' ? 'active' : ''}`} onClick={() => { setView('browse'); closeLedger(); }}>Browse</button>
            <button className={`sc-tab ${view === 'adjustments' ? 'active' : ''}`} onClick={() => { setView('adjustments'); closeLedger(); }}>Adjustments</button>
            <button className={`sc-tab ${view === 'history' ? 'active' : ''}`} onClick={() => { setView('history'); closeLedger(); }}>History</button>
          </div>
          <button className="btn-secondary inv-count-btn" onClick={() => setCountMode(true)}>Stock Count</button>
        </div>

        {view === 'adjustments' ? <AdjustmentsTab /> : ledgerCode ? (
          /* PR172 — per-SKU stock ledger drill-down (tap a Browse card) */
          <div className="inv-ledger">
            <button className="btn-link bv-back" onClick={closeLedger}>← back</button>
            {!ledger ? <div className="hint">Loading ledger…</div> : (
              <>
                <div className="ledg-head">
                  <SkuImage status={imgMap[ledger.item_code]?.status} displayUrl={imgMap[ledger.item_code]?.displayUrl} name={ledger.name || ''} size={SKU_IMG.md} />
                  <div className="ledg-head-main">
                    <div className="inv-card-code">{ledger.item_code}</div>
                    {isRealName(ledger.name, ledger.item_code) && <div className="inv-card-name">{ledger.name}</div>}
                    <div className="ledg-now">In stock <b>{ledger.physical}</b>{ledger.available !== ledger.physical ? ` · available ${ledger.available}` : ''}</div>
                  </div>
                </div>
                <ul className="ledg-list">
                  {ledger.entries.length === 0 && <li className="hint">No stock movements on record.</li>}
                  {ledger.entries.map((e, i) => (
                    <li key={i} className={`ledg-row ledg-${e.kind}`}>
                      <span className="ledg-date">{fmtNiceDate(e.date) || '—'}</span>
                      <span className="ledg-label">{e.label}</span>
                      <span className={`ledg-delta ${e.delta >= 0 ? 'in' : 'out'}`}>{e.delta > 0 ? `+${e.delta}` : e.delta}</span>
                      <span className="ledg-bal">{e.balance}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : view === 'history' ? (
          /* PR176 — History: browse every SKU that has moved (A-Z), tap for its in/out ledger */
          <>
            <div className="search-row inv-search-row">
              <SearchInput
                value={histSearch}
                onChange={setHistSearch}
                placeholder="search any SKU to see its in/out log"
              />
            </div>
            <div className="inv-cards">
              {histRows.length === 0 && (
                <div className="inv-empty">
                  {histLoading ? 'Loading…' : histSearch ? 'No SKU with movement matches — nothing received under that code.' : 'No SKUs with movement yet.'}
                </div>
              )}
              {histRows.map((r) => (
                <button key={r.item_code} className="inv-card inv-card-btn inv-card-hist" onClick={() => openLedger(r.item_code)}>
                  <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name || ''} size={SKU_IMG.sm} />
                  <div className="inv-card-main">
                    <div className="inv-card-code">{r.item_code}</div>
                    {isRealName(r.name, r.item_code) && <div className="inv-card-name">{r.name}</div>}
                  </div>
                  <svg className="inv-card-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              ))}
            </div>
            {histRows.length > 0 && (
              <div className="inv-count">
                {histRows.length}{histRows.length >= ROW_LIMIT ? '+' : ''} SKU{histRows.length === 1 ? '' : 's'} with movement{histRows.length >= ROW_LIMIT ? ' — refine your search to narrow' : ''} · tap for the in/out log
              </div>
            )}
          </>
        ) : (
        <>
        {/* autocomplete-style search bar; the refresh + "as of" timestamp fold into its right edge to
            reclaim the row they used to occupy. */}
        <div className="search-row inv-search-row">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="search SKU code or name"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitSearch(); } }}
          />
          <span className="inv-asof-inline" title={`Stock as of ${fmtAsOf(refreshedAt)}`}>
            <span>{fmtAsOfDate(refreshedAt)}</span>
            <span>{fmtAsOfTime(refreshedAt)}</span>
          </span>
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
            /* PR172 — tap a card to open its stock ledger */
            <button key={r.item_code} className="inv-card inv-card-btn" onClick={() => openLedger(r.item_code)}>
              <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name || ''} size={SKU_IMG.sm} />
              <div className="inv-card-main">
                <div className="inv-card-code">{r.item_code}</div>
                {isRealName(r.name, r.item_code) && <div className="inv-card-name">{r.name}</div>}
              </div>
              <div className="inv-card-stats">
                <span className={`inv-stat ${r.pending ? '' : 'zero'}`} title="On order"><IconOnOrder />{r.pending}</span>
                <span className={`inv-stat ${r.on_the_way ? '' : 'zero'}`} title="Shipped"><IconShipped />{r.on_the_way}</span>
                <span className={`inv-stat ${r.physical ? '' : 'zero'}`} title="Warehouse"><IconWarehouse />{r.physical}</span>
                {r.on_hold > 0 && <span className="inv-hold" title="Held for a customer">On hold: {r.on_hold}</span>}
              </div>
            </button>
          ))}
        </div>

        {rows.length > 0 && (
          <div className="inv-count">
            {rows.length} SKU{rows.length === 1 ? '' : 's'}{truncated ? ` — showing the first ${ROW_LIMIT}; refine your search to narrow` : ''} · read-only
          </div>
        )}
        </>
        )}
      </div>
      )}
    </div>
  );
}

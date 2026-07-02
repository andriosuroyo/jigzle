'use client';

// Inbound → History tab: confirmed receipts grouped per ship_id, read from the inbound ledger via
// getReceiveHistory. Read-only, searchable by ship id / SKU / name. Each row carries its own detail, so
// the detail pane renders straight from the selected row. Mirrors OutboundHistoryBoard's shape.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getReceiveHistory, deleteInboundShipment, moveShipId } from '@/app/inbound/actions';
import type { InboundHistoryRow } from '@/app/inbound/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');

// "YYYY-MM-DD HH:MM" in Asia/Jakarta from a timestamptz (0052). Falls back to the plain receive_date
// (date only) when there's no created_at stamp (older rows). Empty → '—'.
function fmtDateTime(iso: string | null, fallbackDate: string | null): string {
  if (!iso) return fmtDate(fallbackDate);
  const d = new Date(iso);
  if (isNaN(d.getTime())) return fmtDate(fallbackDate);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export default function InboundHistoryBoard({
  initialRows,
  onCountChange,
  reloadKey = 0,
}: {
  initialRows: InboundHistoryRow[];
  onCountChange?: (n: number) => void;
  reloadKey?: number;
}) {
  const [rows, setRows] = useState<InboundHistoryRow[]>(initialRows);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [yearFilter, setYearFilter] = useState<string | null>(null); // the selected year sub-tab
  const [selKey, setSelKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // edit-ship-id overlay
  const [editing, setEditing] = useState(false);
  const [editShipId, setEditShipId] = useState('');
  const [editClose, setEditClose] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const reqRef = useRef(0);
  const firstRun = useRef(true); // skip the debounced refetch on mount (initialRows already loaded)

  // year sub-tabs (newest first; null-date receipts bucket under '—' at the end), each with a count.
  const yearOf = (r: InboundHistoryRow): string => (r.receive_date ? r.receive_date.slice(0, 4) : '—');
  const years = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(yearOf(r), (m.get(yearOf(r)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => {
      if (a[0] === '—') return 1;
      if (b[0] === '—') return -1;
      return a[0] < b[0] ? 1 : -1; // newest first
    });
  }, [rows]);

  // keep the selected year valid as the list changes (search / reload): default to the newest year.
  useEffect(() => {
    if (!years.length) { if (yearFilter !== null) setYearFilter(null); return; }
    if (!yearFilter || !years.some(([y]) => y === yearFilter)) setYearFilter(years[0][0]);
  }, [years, yearFilter]);

  const visibleRows = useMemo(
    () => (yearFilter ? rows.filter((r) => yearOf(r) === yearFilter) : rows),
    [rows, yearFilter]
  );

  const sel = useMemo(() => rows.find((r) => r.ship_id === selKey) ?? null, [rows, selKey]);

  const imgCodes = useMemo(
    () => (sel?.items ?? []).map((i) => i.item_code).filter((c): c is string => !!c),
    [sel]
  );
  const imgMap = useSkuImages(imgCodes);

  async function runSearch() {
    setSearching(true);
    const myReq = ++reqRef.current;
    try {
      const r = await getReceiveHistory(query.trim());
      if (reqRef.current === myReq) setRows(r);
    } catch {
      /* keep current on transient error */
    } finally {
      if (reqRef.current === myReq) setSearching(false);
    }
  }

  // delete this received entry — removes its inbound rows (stock self-corrects via the stock_check
  // view). Destructive, so it's behind an inline confirm.
  async function doDelete() {
    if (!sel) return;
    setDeleting(true);
    try {
      await deleteInboundShipment(sel.ship_id);
      setRows((prev) => prev.filter((r) => r.ship_id !== sel.ship_id));
      setSelKey(null);
      setConfirmDelete(false);
    } catch {
      /* keep the row on a transient error */
    } finally {
      setDeleting(false);
    }
  }

  // open the edit-ship-id overlay for the selected entry
  function openEdit() {
    if (!sel) return;
    setEditShipId(sel.ship_id);
    setEditClose(false);
    setEditErr(null);
    setEditing(true);
  }
  async function saveEdit() {
    if (!sel) return;
    const next = editShipId.trim();
    if (!next) { setEditErr('Enter a ship id.'); return; }
    if (next === sel.ship_id) { setEditing(false); return; }
    setEditBusy(true); setEditErr(null);
    try {
      await moveShipId(sel.ship_id, next, editClose);
      setEditing(false);
      const r = await getReceiveHistory(query.trim());
      setRows(r);
      setSelKey(next); // follow the entry to its new id
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : 'Move failed.');
    } finally {
      setEditBusy(false);
    }
  }

  useEffect(() => { onCountChange?.(rows.length); }, [rows, onCountChange]);
  // reset the delete confirm + edit overlay whenever the selection changes
  useEffect(() => { setConfirmDelete(false); setEditing(false); }, [selKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) runSearch(); }, [reloadKey]);
  // live search: re-query as you type (empty = recent), debounced. Skip the mount run — initialRows
  // is already loaded — so we only refetch once the user types.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => { runSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div className="fulfill-layout">
      {/* ── List ── */}
      <aside className="fq-pane">
        <div className="search-row" style={{ padding: '8px' }}>
          <input
            type="text"
            inputMode="search"
            placeholder="Search ship id, SKU, or name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {/* Year sub-tabs (Sales-Pending style), newest first, each with a count. */}
        {years.length > 0 && (
          <div className="fq-filters" role="tablist" aria-label="Filter by year">
            {years.map(([y, n]) => (
              <button
                key={y}
                role="tab"
                aria-selected={yearFilter === y}
                className={`fq-filter ${yearFilter === y ? 'active' : ''}`}
                onClick={() => setYearFilter(y)}
              >
                {y}<span className="fq-filter-count">{n}</span>
              </button>
            ))}
          </div>
        )}
        {visibleRows.length === 0 && <div className="hint fq-empty">{searching ? 'Searching…' : 'No received shipments.'}</div>}
        <ul className="fq-list">
          {visibleRows.map((r) => (
            <li key={r.ship_id}>
              <button className={`fq-row ${selKey === r.ship_id ? 'active' : ''}`} onClick={() => setSelKey(r.ship_id)}>
                <div className="fq-row-top">
                  <span className="fq-id">{r.ship_id}</span>
                  <span className="fq-id-sub">{fmtDate(r.receive_date)}</span>
                </div>
                <div className="fq-row-bot">
                  <span className="ff-items-skus">
                    {r.item_count} {r.item_count === 1 ? 'item' : 'items'}{r.sku_codes.length ? ` · ${r.sku_codes.join(', ')}` : ''}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Detail (read-only) ── */}
      <main className="fd-pane">
        {!sel && <div className="fd-empty">Pick a shipment to see what was received.</div>}
        {sel && (
          <>
            <div className="fd-head">
              <div className="fd-title-row">
                <div className="fd-title">{sel.ship_id}</div>
                <button className="btn-link" onClick={openEdit} disabled={editing}>Edit ship id</button>
              </div>
              <div className="fd-sub">
                Received {fmtDateTime(sel.received_at, sel.receive_date)}{sel.staff ? ` by ${sel.staff}` : ''}
              </div>
            </div>

            <section className="fd-section">
              <div className="fd-section-head">Received items</div>
              <ul className="ff-lines">
                {sel.items.map((l, i) => (
                  <li key={i} className="ff-line pend-line">
                    <SkuImage status={imgMap[l.item_code ?? '']?.status} displayUrl={imgMap[l.item_code ?? '']?.displayUrl} name={l.name} size={SKU_IMG.sm} />
                    <div className="pend-line-main">
                      <span className="ff-code">{l.item_code || '—'}</span>
                      <span className="ff-name">{l.name}</span>
                    </div>
                    <span className="ff-qty">
                      ×{l.qty}
                      {l.excluded_qty > 0 && <span className="hint" style={{ marginLeft: 6 }}>+{l.excluded_qty} excl</span>}
                    </span>
                  </li>
                ))}
                {sel.items.length === 0 && <li className="hint">No received items.</li>}
              </ul>
            </section>

            {/* Delete this received entry (text-button; removes the inbound rows, stock self-corrects). */}
            <div className="ob-return">
              {!confirmDelete ? (
                <button className="btn-link danger" onClick={() => setConfirmDelete(true)} disabled={deleting}>Delete entry</button>
              ) : (
                <span className="rcv-reverse-ask">
                  Delete {sel.ship_id}? Its received stock will be removed.
                  <button className="btn-secondary" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</button>
                  <button className="btn-primary danger" onClick={doDelete} disabled={deleting}>{deleting ? 'Deleting…' : 'Yes, delete'}</button>
                </span>
              )}
            </div>
          </>
        )}
      </main>

      {/* Edit ship id — relocates the receipt(s) to a new ship id and re-runs PO allocation (0053). */}
      {editing && sel && (
        <div className="sc-modal-backdrop" onClick={() => !editBusy && setEditing(false)}>
          <div className="sc-modal rcv-manual-modal" role="dialog" aria-modal="true" aria-label="Edit ship id" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head">
              <div className="sc-modal-title">Edit ship id</div>
              <div className="sc-modal-sub">Move “{sel.ship_id}” to the correct ship id. Its POs re-allocate; the old shipment re-opens.</div>
            </div>
            <div className="sc-modal-body">
              <label className="rcv-map-barcode">
                <span className="fd-label">New ship id</span>
                <input
                  type="text"
                  autoFocus
                  placeholder="e.g. SUB 191"
                  value={editShipId}
                  onChange={(e) => setEditShipId(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveEdit(); } }}
                />
              </label>
              <label className="rcv-ctl" style={{ marginTop: 10 }}>
                <input type="checkbox" checked={editClose} onChange={(e) => setEditClose(e.target.checked)} />
                <span>Close the shipment after moving (all goods received)</span>
              </label>
              {editErr && <div className="validation err" style={{ marginTop: 10 }}>{editErr}</div>}
            </div>
            <div className="sc-modal-foot">
              <button className="btn-secondary" onClick={() => setEditing(false)} disabled={editBusy}>Cancel</button>
              <button className="btn-primary" onClick={saveEdit} disabled={editBusy}>{editBusy ? 'Moving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

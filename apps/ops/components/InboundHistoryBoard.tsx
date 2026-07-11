'use client';

// Inbound → History tab: confirmed receipts grouped per ship_id, read from the inbound ledger via
// getReceiveHistory. Read-only, searchable by ship id / SKU / name. Each row carries its own detail, so
// the detail pane renders straight from the selected row. Mirrors OutboundHistoryBoard's shape.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getReceiveHistory, deleteInboundShipment, moveShipId } from '@/app/inbound/actions';
import { setShipmentCourier } from '@/app/purchasing/actions';
import DropSearch from '@/components/DropSearch';
import type { InboundHistoryRow } from '@/app/inbound/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import SearchInput from '@/components/SearchInput';
import ConfirmModal from '@/components/ConfirmModal';
import { useOverlayClose } from '@/components/useOverlayClose';
import { fmtNiceDate } from '@jigzle/lib';

// PR314 — detail action-bar glyphs (edit pencil + delete trash), matching the app's 16px icon set.
const _ic = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, width: 16, height: 16, 'aria-hidden': true };
const PencilIcon = () => (<svg {..._ic}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);
const TrashIcon = () => (<svg {..._ic}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>);

const fmtDate = (s: string | null): string => fmtNiceDate(s) || '—';

// "Jul 9, 2026 14:30" in Asia/Jakarta from a timestamptz (0052) — friendly date + 24h time (PR269).
// Falls back to the plain receive_date (date only) when there's no created_at stamp (older rows). Empty → '—'.
function fmtDateTime(iso: string | null, fallbackDate: string | null): string {
  if (!iso) return fmtDate(fallbackDate);
  const d = new Date(iso);
  if (isNaN(d.getTime())) return fmtDate(fallbackDate);
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.month} ${p.day}, ${p.year} ${p.hour}:${p.minute}`;
}

export default function InboundHistoryBoard({
  initialRows,
  active = true,
  onCountChange,
  onDetailOpenChange,
  reloadKey = 0,
  shipmentCouriers = [],
}: {
  initialRows: InboundHistoryRow[];
  // PR317 — Settings-managed shipment-courier pick-list, for editing courier/tracking here (see below).
  shipmentCouriers?: string[];
  // PR181: whether the History tab is on screen. The shell no longer preloads the (paged full-scan)
  // received history; we fetch it once the first time this turns true, so Inbound opens fast on Active.
  active?: boolean;
  onCountChange?: (n: number) => void;
  // PR154: the shell hides the tab bar while a receipt detail bodyview is open (breadcrumb stays).
  onDetailOpenChange?: (open: boolean) => void;
  reloadKey?: number;
}) {
  const [rows, setRows] = useState<InboundHistoryRow[]>(initialRows);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [yearFilter, setYearFilter] = useState<string | null>(null); // the selected year sub-tab
  const [selKey, setSelKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // edit-ship-id overlay (PR317 — also edits shipment courier + tracking, since the tracking lives on the
  // shipments row keyed by ship_id and can end up on the wrong entry).
  const [editing, setEditing] = useState(false);
  const [editShipId, setEditShipId] = useState('');
  const [editCourier, setEditCourier] = useState('');
  const [editTracking, setEditTracking] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const reqRef = useRef(0);
  const firstRun = useRef(true); // skip the debounced refetch on mount (initialRows already loaded)
  const loadedRef = useRef(initialRows.length > 0); // PR181: false until the deferred first load lands

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
    loadedRef.current = true; // any fetch (deferred load, search, reload) counts as loaded
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

  // PR181: deferred first load — fetch the received history the first time the History tab is shown.
  useEffect(() => {
    if (active && !loadedRef.current) runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

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

  // open the edit-ship-id overlay for the selected entry (seed id + courier/tracking drafts)
  function openEdit() {
    if (!sel) return;
    setEditShipId(sel.ship_id);
    setEditCourier(sel.courier ?? '');
    setEditTracking(sel.tracking ?? '');
    setEditErr(null);
    setEditing(true);
  }
  async function saveEdit() {
    if (!sel) return;
    const next = editShipId.trim();
    if (!next) { setEditErr('Enter a ship id.'); return; }
    const idChanged = next !== sel.ship_id;
    // PR317 — courier/tracking live on the shipments row; save them (on the possibly-new id) when changed.
    const courierChanged = (editCourier.trim() || null) !== (sel.courier ?? null)
      || (editTracking.trim() || null) !== (sel.tracking ?? null);
    if (!idChanged && !courierChanged) { setEditing(false); return; }
    setEditBusy(true); setEditErr(null);
    try {
      // PR314 — SOP: moving a received entry closes the target shipment (all goods accounted for).
      if (idChanged) await moveShipId(sel.ship_id, next, true);
      if (courierChanged) {
        const { error } = await setShipmentCourier(next, editCourier, editTracking);
        if (error) { setEditErr(error); setEditBusy(false); return; }
      }
      setEditing(false);
      const r = await getReceiveHistory(query.trim());
      setRows(r);
      setSelKey(next); // follow the entry to its (possibly new) id
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setEditBusy(false);
    }
  }

  // PR307 — shared overlay-close for the edit-ship-id form (unsaved edits route through a discard
  // confirm; the existing busy guard is preserved by gating onClose on editBusy).
  const editIdClose = useOverlayClose({
    open: editing && !!sel,
    onClose: () => { if (!editBusy) setEditing(false); },
    dirty: editShipId.trim() !== (sel?.ship_id ?? '')
      || editCourier.trim() !== (sel?.courier ?? '')
      || editTracking.trim() !== (sel?.tracking ?? ''),
  });

  useEffect(() => { onCountChange?.(rows.length); }, [rows, onCountChange]);
  // reset the delete confirm + edit overlay whenever the selection changes
  useEffect(() => { setConfirmDelete(false); setEditing(false); }, [selKey]);
  // PR154: bodyview — the shell hides the tab bar while a detail is open.
  useEffect(() => { onDetailOpenChange?.(!!selKey); }, [selKey, onDetailOpenChange]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey && loadedRef.current) runSearch(); }, [reloadKey]);
  // live search: re-query as you type (empty = recent), debounced. Skip the mount run — initialRows
  // is already loaded — so we only refetch once the user types.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => { runSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // PR154 — bodyview: the body shows EITHER the search + year tabs + full-width list OR the tapped
  // receipt's detail with a ← back button; the shell hides the tab bar while the detail is open.
  return (
    <div className="bodyview">
      {/* ── List ── */}
      {!sel && (
        <>
        <div className="search-row" style={{ padding: '0 0 8px' }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Search ship id, SKU, or name…" />
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
        {visibleRows.length === 0 && <div className="hint fq-empty">{searching ? (query.trim() ? 'Searching…' : 'Loading history…') : 'No received shipments.'}</div>}
        <ul className="fq-list">
          {visibleRows.map((r) => (
            <li key={r.ship_id}>
              <button className="fq-row" onClick={() => setSelKey(r.ship_id)}>
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
        </>
      )}

      {/* ── Detail (read-only) ── */}
      {sel && (
        <>
          <button className="btn-link bv-back" onClick={() => setSelKey(null)}>← back</button>
          <div className="bv-detail">
            <div className="fd-head">
              <div className="fd-title-row">
                <div className="fd-title">{sel.ship_id}</div>
              </div>
              <div className="fd-sub">
                {sel.is_opening_balance
                  ? 'Opening balance — arrivals recorded up to 2023'
                  : `Received ${fmtDateTime(sel.received_at, sel.receive_date)}${sel.staff ? ` by ${sel.staff}` : ''}`}
              </div>
              {/* PR154 header subtext: shipped date + shipment courier & tracking (ledger shipments only) */}
              {!sel.is_adhoc && !sel.is_opening_balance && (
                <div className="fd-sub">
                  shipped {fmtDate(sel.ship_date)} · {[sel.courier, sel.tracking].filter(Boolean).join(' ') || 'no tracking'}
                </div>
              )}
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

            {/* PR314 — one bottom action row: Edit shipment ID (secondary) then Delete entry (destructive).
                Hidden for the read-only opening-balance entry (no ship_id to edit/delete by). */}
            {!sel.is_opening_balance && (
              <div className="td-actions">
                <button className="btn-secondary btn-ico" onClick={openEdit} disabled={editing}><PencilIcon />Edit shipment ID</button>
                <button className="btn-danger btn-ico" onClick={() => setConfirmDelete(true)} disabled={deleting}><TrashIcon />Delete entry</button>
              </div>
            )}
          </div>
          {confirmDelete && sel && (
            <ConfirmModal
              title={`Delete ${sel.ship_id}?`}
              busy={deleting}
              confirmLabel={deleting ? 'Deleting…' : 'Delete entry'}
              cancelLabel="Cancel"
              danger
              onConfirm={doDelete}
              onCancel={() => setConfirmDelete(false)}
            >
              <div>This removes the received rows for this entry; the affected stock self-corrects.</div>
            </ConfirmModal>
          )}
        </>
      )}

      {/* Edit ship id — relocates the receipt(s) to a new ship id and re-runs PO allocation (0053). */}
      {editing && sel && (
        <div className="sc-modal-backdrop" onClick={editIdClose.requestClose}>
          <div className="sc-modal rcv-manual-modal" role="dialog" aria-modal="true" aria-label="Edit ship id" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head">
              <div className="sc-modal-title">Edit shipment ID</div>
            </div>
            <div className="sc-modal-body">
              {/* PR317 — full-width ship-id field; below it the shipment courier + tracking (edited here
                  because the tracking sits on the shipments row and can land on the wrong received entry). */}
              <label className="rcv-map-field">
                <span className="fd-section-head">New shipment ID</span>
                <input
                  type="text"
                  autoFocus
                  placeholder="e.g. SUB 191"
                  value={editShipId}
                  onChange={(e) => setEditShipId(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveEdit(); } }}
                />
              </label>
              {/* only a ledger shipment carries a courier/tracking (an ad-hoc 📦 entry has no shipments row). */}
              {!sel.is_adhoc && (
                <div className="rcv-map-field">
                  <span className="fd-section-head">Shipment courier &amp; tracking</span>
                  <div className="po-inline2 po-inline-courier">
                    <DropSearch
                      value={editCourier || null}
                      onChange={(v) => setEditCourier(v)}
                      options={[...shipmentCouriers, ...(editCourier && !shipmentCouriers.includes(editCourier) ? [editCourier] : [])].map((c) => ({ value: c, label: c }))}
                      placeholder="— Pick courier —"
                      clearable
                      ariaLabel="Shipment courier"
                    />
                    <input
                      className="field"
                      type="text"
                      placeholder="Tracking number"
                      value={editTracking}
                      onChange={(e) => setEditTracking(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveEdit(); } }}
                    />
                  </div>
                </div>
              )}
              {editErr && <div className="validation err" style={{ marginTop: 10 }}>{editErr}</div>}
            </div>
            <div className="sc-modal-foot">
              <button className="btn-secondary" onClick={editIdClose.requestClose} disabled={editBusy}>Cancel</button>
              <button className="btn-primary" onClick={saveEdit} disabled={editBusy}>{editBusy ? 'Moving…' : 'Save'}</button>
            </div>
          </div>
          {editIdClose.confirm}
        </div>
      )}
    </div>
  );
}

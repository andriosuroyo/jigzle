'use client';

// Outbound → History tab: the full shipped log, read from outbound_shipments (canonical). Read-only,
// searchable by name / SKU / courier. Each shipment row carries its own detail (CSV/legacy rows have no
// sales_id to re-fetch by), so the detail pane renders straight from the selected row. Past shipments
// with no box dims are shown as the assumed Custom 1×1×1 box; ✅ marks barcode-scanned items.
//
// PR320 — the list is grouped into month tabs (newest first, count per tab) and lazy-loads one month at a
// time (getOutboundHistory(_, ym)); a light month index (getOutboundHistoryMonths) loads on tab-open. The
// search bar sits ABOVE the month tabs (like Sales → Pending) and matches across ALL months.

import { useEffect, useMemo, useRef, useState } from 'react';
import { volWeight, fmtNiceDate } from '@jigzle/lib';
import { getOutboundHistory, getOutboundHistoryMonths, cancelShipment, dispatchSend, getOutboundNote, setOutboundNote } from '@/app/outbound/actions';
import type { ShipmentHistoryRow, ShipmentHistoryBox } from '@/app/outbound/types';
import type { BoxPreset } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import SearchInput from '@/components/SearchInput';

const fmtDate = (s: string | null): string => fmtNiceDate(s) || '—';

// "2026-06" → "Jun 2026" (friendly, per the PR269 date standard).
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymLabel = (ym: string): string => {
  const mi = Number(ym.slice(5, 7)) - 1;
  return `${MONTH_ABBR[mi] ?? ym.slice(5, 7)} ${ym.slice(0, 4)}`;
};
const ymOf = (s: string | null): string => (s ?? '').slice(0, 7);

export default function OutboundHistoryBoard({
  boxPresets,
  active = true,
  onDetailOpenChange,
  onCancelled,
}: {
  boxPresets: BoxPreset[];
  // PR181: whether the History tab is on screen. We fetch the month index the first time this turns true,
  // so Outbound opens fast on Dispatch.
  active?: boolean;
  // PR155: the shell hides the tab bar while a shipment detail bodyview is open (breadcrumb stays).
  onDetailOpenChange?: (open: boolean) => void;
  // PR195: a shipment was un-recorded → the shell reloads the Dispatch queue (the lines return there).
  onCancelled?: () => void;
}) {
  // PR320 — month index (tabs) + per-month lazy cache
  const [months, setMonths] = useState<{ ym: string; count: number }[]>([]);
  const [monthsReady, setMonthsReady] = useState(false);
  const monthsLoadedRef = useRef(false);
  const [activeYm, setActiveYm] = useState<string | null>(null);
  const [byMonth, setByMonth] = useState<Record<string, ShipmentHistoryRow[]>>({});
  const [monthLoading, setMonthLoading] = useState(false);
  // search (across all months)
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ShipmentHistoryRow[]>([]);
  const [searching, setSearching] = useState(false);
  const searchReq = useRef(0);

  const [selKey, setSelKey] = useState<string | null>(null);
  // PR195: cancel-shipment inline confirm (app ships only). Its error stays under the action.
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false); // PR198: mark-dispatched in flight
  // PR190 — editable per-shipment note (available on every shipment)
  const [note, setNote] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteMsg, setNoteMsg] = useState<string | null>(null);

  const searchMode = query.trim().length > 0;
  // the rows currently on screen: search hits (all months) or the active month's cache.
  const rows = searchMode ? searchResults : (activeYm ? byMonth[activeYm] ?? [] : []);
  // a selected row can come from any loaded month or the search results.
  const sel = useMemo(() => {
    const pool = [...Object.values(byMonth).flat(), ...searchResults];
    return pool.find((o) => o.key === selKey) ?? null;
  }, [byMonth, searchResults, selKey]);

  // PR320 — load the month index the first time History is shown; default to the newest month.
  useEffect(() => {
    if (!active || monthsLoadedRef.current) return;
    monthsLoadedRef.current = true;
    let live = true;
    getOutboundHistoryMonths()
      .then((ms) => { if (!live) return; setMonths(ms); if (ms.length) setActiveYm((cur) => cur ?? ms[0].ym); })
      .catch(() => {})
      .finally(() => { if (live) setMonthsReady(true); });
    return () => { live = false; };
  }, [active]);

  // PR320 — lazy-load the active month's rows (cached; skipped while searching).
  useEffect(() => {
    if (searchMode || !activeYm || byMonth[activeYm]) return;
    let live = true;
    setMonthLoading(true);
    getOutboundHistory('', activeYm)
      .then((r) => { if (live) setByMonth((prev) => ({ ...prev, [activeYm]: r })); })
      .catch(() => {})
      .finally(() => { if (live) setMonthLoading(false); });
    return () => { live = false; };
  }, [activeYm, searchMode, byMonth]);

  // PR320 — search runs across all months (debounced); empty query returns to the month view.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setSearchResults([]); setSearching(false); return; }
    setSearching(true);
    const myReq = ++searchReq.current;
    const t = setTimeout(() => {
      getOutboundHistory(q)
        .then((r) => { if (searchReq.current === myReq) setSearchResults(r); })
        .catch(() => { if (searchReq.current === myReq) setSearchResults([]); })
        .finally(() => { if (searchReq.current === myReq) setSearching(false); });
    }, 220);
    return () => clearTimeout(t);
  }, [query]);

  // PR190 — load the manual note whenever a shipment is opened; save/clear on demand
  useEffect(() => {
    setNote(''); setNoteMsg(null);
    if (!selKey) return;
    let live = true;
    getOutboundNote(selKey).then((n) => { if (live) setNote(n ?? ''); }).catch(() => {});
    return () => { live = false; };
  }, [selKey]);
  async function saveNote() {
    if (!selKey) return;
    setNoteBusy(true); setNoteMsg(null);
    const { error } = await setOutboundNote(selKey, note);
    setNoteBusy(false);
    setNoteMsg(error ? error : 'Saved.');
  }

  const imgCodes = useMemo(
    () => (sel?.items ?? []).map((i) => i.item_code).filter((c): c is string => !!c),
    [sel]
  );
  const imgMap = useSkuImages(imgCodes);

  // a box's type label: match real dims back to a SETTINGS preset, else "Custom".
  function boxType(b: ShipmentHistoryBox): string {
    if (b.dim_p == null || b.dim_l == null || b.dim_t == null) return 'Custom';
    const m = boxPresets.find((p) => p.dim_p === b.dim_p && p.dim_l === b.dim_l && p.dim_t === b.dim_t);
    return m ? m.code : 'Custom';
  }

  // PR320 — apply a row edit/removal across every loaded month cache + the search results.
  function patchRows(fn: (rows: ShipmentHistoryRow[]) => ShipmentHistoryRow[]) {
    setByMonth((prev) => {
      const next: Record<string, ShipmentHistoryRow[]> = {};
      for (const k of Object.keys(prev)) next[k] = fn(prev[k]);
      return next;
    });
    setSearchResults((prev) => fn(prev));
  }

  const courierLine = sel?.courier || null;

  // PR155: bodyview — the shell hides the tab bar while a detail is open.
  useEffect(() => { onDetailOpenChange?.(!!selKey); }, [selKey, onDetailOpenChange]);
  // PR195: reset the cancel confirm/error whenever the selection changes.
  useEffect(() => { setConfirmCancel(false); setCancelErr(null); setDispatching(false); }, [selKey]);

  // PR195: un-record the selected app shipment — its lines return to Dispatch (no stock move) and the
  // order goes back to Need send. Remove the row from every cache + drop the month count.
  async function doCancelShipment() {
    if (!sel?.send_id) return;
    setCancelling(true);
    setCancelErr(null);
    const { error } = await cancelShipment(sel.send_id);
    if (error) { setCancelErr(error); setCancelling(false); return; }
    const gone = sel.key;
    const ym = ymOf(sel.ship_date);
    patchRows((rs) => rs.filter((o) => o.key !== gone));
    const remaining = months
      .map((m) => (m.ym === ym ? { ...m, count: Math.max(0, m.count - 1) } : m))
      .filter((m) => m.count > 0);
    setMonths(remaining);
    // if the active month emptied out, jump to the newest remaining month
    if (!remaining.some((m) => m.ym === activeYm)) setActiveYm(remaining[0]?.ym ?? null);
    setSelKey(null);
    setConfirmCancel(false);
    setCancelling(false);
    onCancelled?.();
  }

  // PR198: mark the selected packed send as dispatched (handed to courier) — the point of no return.
  async function doDispatch() {
    if (!sel?.send_id) return;
    setDispatching(true);
    setCancelErr(null);
    const { error } = await dispatchSend(sel.send_id);
    if (error) { setCancelErr(error); setDispatching(false); return; }
    const stamp = new Date().toISOString();
    const k = sel.key;
    patchRows((rs) => rs.map((o) => (o.key === k ? { ...o, dispatched_at: stamp } : o)));
    setConfirmCancel(false);
    setDispatching(false);
  }

  // Shipped-to block: recipient name leads, phone ends (PR155).
  const shippedTo = sel ? [sel.recipient, sel.address, sel.phone].filter(Boolean).join('\n') : '';

  // empty / loading text for the current view
  const emptyText = searchMode
    ? (searching ? 'Searching…' : 'No matches.')
    : monthLoading
      ? 'Loading…'
      : !monthsReady
        ? 'Loading history…'
        : months.length === 0
          ? 'No shipped orders.'
          : 'No shipped orders this month.';

  // PR155 — bodyview: the body shows EITHER the search + month tabs + list OR the tapped shipment's detail.
  return (
    <div className="bodyview">
      {/* ── List ── */}
      {!sel && (
        <>
        {/* PR320 — search stays ABOVE the month tabs (Sales-Pending style); it matches across all months. */}
        <div className="search-row" style={{ padding: '0 0 8px' }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Search name, SKU, or courier…" />
        </div>
        {!searchMode && months.length > 0 && (
          <div className="fq-filters" role="tablist" aria-label="Filter by month">
            {months.map((mo) => (
              <button
                key={mo.ym}
                role="tab"
                aria-selected={activeYm === mo.ym}
                className={`fq-filter ${activeYm === mo.ym ? 'active' : ''}`}
                onClick={() => setActiveYm(mo.ym)}
              >
                {ymLabel(mo.ym)}<span className="fq-filter-count">{mo.count}</span>
              </button>
            ))}
          </div>
        )}
        {rows.length === 0 && <div className="hint fq-empty">{emptyText}</div>}
        <ul className="fq-list">
          {rows.map((o) => (
            <li key={o.key}>
              <button className="fq-row" onClick={() => setSelKey(o.key)}>
                <div className="fq-row-top">
                  <span className="fq-headline">{o.customer || '—'}</span>
                  <span className="fq-id-sub">{fmtDate(o.ship_date)}</span>
                </div>
                <div className="fq-row-bot">
                  {/* SKU codes (CSV rows carry no tracking) — like the Fulfill rows, helps SKU search. */}
                  <span className="ff-items-skus">{o.item_count} {o.item_count === 1 ? 'item' : 'items'}{o.sku_codes.length ? ` (${o.sku_codes.join(', ')})` : ''}</span>
                  {o.courier && <span className="badge ready">{o.courier}</span>}
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
            {/* PR155 header: customer ID headline; "shipped <date> by <staff>" subtext */}
            <div className="fd-head">
              <div className="fd-title fd-title-plain">{sel.customer || '—'}</div>
              <div className="fd-sub">
                packed {fmtDate(sel.ship_date)}{sel.staff ? ` by ${sel.staff}` : ''}
                {sel.dispatched_at ? ` · dispatched ${fmtDate(sel.dispatched_at)}` : sel.send_id ? ' · not yet dispatched' : ''}
              </div>
            </div>

            {shippedTo && (
              <section className="fd-section">
                <div className="fd-section-head">Shipped to</div>
                <pre className="ob-addr-block">{shippedTo}</pre>
              </section>
            )}

            {courierLine && (
              <section className="fd-section">
                <div className="fd-section-head">Courier &amp; tracking</div>
                <div className="order-note">{courierLine}</div>
              </section>
            )}

            {sel.note && (
              <section className="fd-section">
                <div className="fd-section-head">Item notes</div>
                <pre className="ob-addr-block">{sel.note}</pre>
              </section>
            )}

            {/* PR190 — editable shipment note (any shipment): e.g. the export-courier tracking number */}
            <section className="fd-section">
              <div className="fd-section-head">Shipment note</div>
              <textarea
                className="ob-note-input"
                rows={3}
                placeholder="e.g. export courier tracking number, follow-up notes…"
                value={note}
                onChange={(e) => { setNote(e.target.value); setNoteMsg(null); }}
              />
              <div className="ob-note-actions">
                <button className="btn-secondary sc-mini" onClick={saveNote} disabled={noteBusy}>{noteBusy ? 'Saving…' : 'Save note'}</button>
                {noteMsg && <span className={noteMsg === 'Saved.' ? 'hint' : 'validation err'}>{noteMsg}</span>}
              </div>
            </section>

            <section className="fd-section">
              <div className="fd-section-head">Shipped items</div>
              <ul className="ff-lines">
                {sel.items.map((l, i) => (
                  <li key={i} className="ff-line pend-line">
                    {/* ✅ scanned · ○ manually checked */}
                    {l.verify_method === 'scan'
                      ? <span className="vmark scan" title="Barcode scanned">✅</span>
                      : l.verify_method === 'manual'
                        ? <span className="vmark manual" title="Manually checked">○</span>
                        : <span className="vmark" aria-hidden="true" />}
                    <SkuImage status={imgMap[l.item_code ?? '']?.status} displayUrl={imgMap[l.item_code ?? '']?.displayUrl} name={l.name} size={SKU_IMG.sm} />
                    <div className="pend-line-main">
                      <span className="ff-code">{l.item_code || '—'}</span>
                      <span className="ff-name">{l.name}</span>
                    </div>
                    <span className="ff-qty">×{l.qty}</span>
                  </li>
                ))}
                {sel.items.length === 0 && <li className="hint">No shipped items.</li>}
              </ul>

              <div className="fd-section-head" style={{ marginTop: 12 }}>Boxes</div>
              <ul className="ff-lines">
                {sel.boxes.length > 0 ? (
                  sel.boxes.map((b, i) => {
                    const dims = b.dim_p != null && b.dim_l != null && b.dim_t != null
                      ? `${b.dim_p} x ${b.dim_l} x ${b.dim_t} cm`
                      : '— cm';
                    // PR155: line 2 = real + vol (rounded to whole grams); the right side carries the
                    // chargeable weight (= the bigger of the two), also whole grams.
                    const vol = b.dim_p != null && b.dim_l != null && b.dim_t != null
                      ? Math.round(volWeight(b.dim_p, b.dim_l, b.dim_t))
                      : null;
                    return (
                      <li key={i} className="box-sum">
                        <span className="box-idx" aria-label={`Box ${i + 1}`}>{i + 1}</span>
                        <div className="box-sum-main">
                          <span className="box-sum-l1">{boxType(b)} · {dims}</span>
                          <span className="box-sum-l2">real: {b.real_weight != null ? `${b.real_weight} g` : '—'} · vol: {vol != null ? `${vol} g` : '—'}</span>
                        </div>
                        <span className="ff-qty">{b.chargeable_weight != null ? `${Math.round(b.chargeable_weight)} g` : '—'}</span>
                      </li>
                    );
                  })
                ) : (
                  // legacy/CSV shipment: no box dims captured → assume a Custom 1×1×1 box, real weight filled in.
                  <li className="box-sum">
                    <span className="box-idx" aria-label="Box 1">1</span>
                    <div className="box-sum-main">
                      <span className="box-sum-l1">Custom · 1 x 1 x 1 cm</span>
                      <span className="box-sum-l2">real: {sel.real_weight != null ? `${sel.real_weight} g` : '—'} · assumed box</span>
                    </div>
                    <span className="ff-qty">{sel.chargeable_g != null ? `${Math.round(sel.chargeable_g)} g` : '—'}</span>
                  </li>
                )}
              </ul>
            </section>

            {/* PR195: Cancel shipment (app ships only — CSV/legacy rows have no send_id). Un-records the
                send: items return to Dispatch, order back to Need send, no stock adjustment. Inline
                confirm; the error stays under the action. */}
            {sel.send_id && (
              <div className="ob-return">
                {sel.dispatched_at ? (
                  <span className="hint">Dispatched {fmtDate(sel.dispatched_at)} — handed to the courier, so this send can no longer be cancelled.</span>
                ) : !confirmCancel ? (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn-secondary" onClick={doDispatch} disabled={dispatching || cancelling}>{dispatching ? 'Marking…' : 'Mark dispatched'}</button>
                    <button className="btn-link danger" onClick={() => setConfirmCancel(true)} disabled={cancelling || dispatching}>Cancel shipment</button>
                    <span className="hint">Packed — mark dispatched when it&apos;s handed to the courier (that locks cancellation).</span>
                  </div>
                ) : (
                  <span className="rcv-reverse-ask">
                    Cancel this shipment? Its {sel.item_count} {sel.item_count === 1 ? 'item' : 'items'} return to Dispatch and the order goes back to Need send. No stock is changed (nothing left the shelf).
                    <button className="btn-secondary" onClick={() => setConfirmCancel(false)} disabled={cancelling}>Keep</button>
                    <button className="btn-primary danger" onClick={doCancelShipment} disabled={cancelling}>{cancelling ? 'Cancelling…' : 'Yes, cancel'}</button>
                  </span>
                )}
                {cancelErr && <div className="validation err" style={{ marginTop: 6 }}>{cancelErr}</div>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

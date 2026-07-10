'use client';

// Outbound → History tab: the full shipped log, read from outbound_shipments (canonical) via
// getOutboundHistory. Read-only, searchable by name / SKU / courier. Each shipment row carries its own
// detail (CSV/legacy rows have no sales_id to re-fetch by), so the detail pane renders straight from the
// selected row. Past shipments with no box dims are shown as the assumed Custom 1×1×1 box with the real
// weight filled in; ✅ marks barcode-scanned items, ○ manually checked ones.

import { useEffect, useMemo, useRef, useState } from 'react';
import { volWeight, fmtNiceDate } from '@jigzle/lib';
import { getOutboundHistory, cancelShipment, dispatchSend, getOutboundNote, setOutboundNote } from '@/app/outbound/actions';
import type { ShipmentHistoryRow, ShipmentHistoryBox } from '@/app/outbound/types';
import type { BoxPreset } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import SearchInput from '@/components/SearchInput';

const fmtDate = (s: string | null): string => fmtNiceDate(s) || '—';

export default function OutboundHistoryBoard({
  initialOrders,
  boxPresets,
  active = true,
  onCountChange,
  onDetailOpenChange,
  onCancelled,
  reloadKey = 0,
}: {
  initialOrders: ShipmentHistoryRow[];
  boxPresets: BoxPreset[];
  // PR181: whether the History tab is on screen. The shell no longer preloads shipped history; we fetch
  // it once the first time this turns true, so Outbound opens fast on Ready to ship.
  active?: boolean;
  onCountChange?: (n: number) => void;
  // PR155: the shell hides the tab bar while a shipment detail bodyview is open (breadcrumb stays).
  onDetailOpenChange?: (open: boolean) => void;
  // PR195: a shipment was un-recorded → the shell reloads the Ready-to-ship queue (the lines return there).
  onCancelled?: () => void;
  reloadKey?: number;
}) {
  const [orders, setOrders] = useState<ShipmentHistoryRow[]>(initialOrders);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
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
  const reqRef = useRef(0);
  const firstRun = useRef(true); // skip the debounced refetch on mount (initialOrders already loaded)
  const loadedRef = useRef(initialOrders.length > 0); // PR181: false until the deferred first load lands

  const sel = useMemo(() => orders.find((o) => o.key === selKey) ?? null, [orders, selKey]);

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

  async function runSearch() {
    setSearching(true);
    loadedRef.current = true; // any fetch (deferred load, search, reload) counts as loaded
    const myReq = ++reqRef.current;
    try {
      const rows = await getOutboundHistory(query.trim());
      if (reqRef.current === myReq) setOrders(rows);
    } catch {
      /* keep current on transient error */
    } finally {
      if (reqRef.current === myReq) setSearching(false);
    }
  }

  // PR181: deferred first load — fetch the shipped history the first time the History tab is shown.
  useEffect(() => {
    if (active && !loadedRef.current) runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => { onCountChange?.(orders.length); }, [orders, onCountChange]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey && loadedRef.current) runSearch(); }, [reloadKey]);
  // live search: re-query as you type (empty = recent), debounced. Skip the mount run — initialOrders
  // is already loaded — so we only refetch once the user types.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => { runSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const courierLine = sel?.courier || null;

  // PR155: bodyview — the shell hides the tab bar while a detail is open.
  useEffect(() => { onDetailOpenChange?.(!!selKey); }, [selKey, onDetailOpenChange]);
  // PR195: reset the cancel confirm/error whenever the selection changes.
  useEffect(() => { setConfirmCancel(false); setCancelErr(null); setDispatching(false); }, [selKey]);

  // PR195: un-record the selected app shipment — its lines return to Ready-to-ship (no stock move) and
  // the order goes back to Need send. Remove the row here and tell the shell to reload the Ready queue.
  async function doCancelShipment() {
    if (!sel?.send_id) return;
    setCancelling(true);
    setCancelErr(null);
    const { error } = await cancelShipment(sel.send_id);
    if (error) { setCancelErr(error); setCancelling(false); return; }
    setOrders((prev) => prev.filter((o) => o.key !== sel.key));
    setSelKey(null);
    setConfirmCancel(false);
    setCancelling(false);
    onCancelled?.();
  }

  // PR198: mark the selected packed send as dispatched (handed to courier) — the point of no return.
  // Optimistically reflect it (hides Cancel, shows "dispatched"); the stamped date is today.
  async function doDispatch() {
    if (!sel?.send_id) return;
    setDispatching(true);
    setCancelErr(null);
    const { error } = await dispatchSend(sel.send_id);
    if (error) { setCancelErr(error); setDispatching(false); return; }
    const stamp = new Date().toISOString();
    setOrders((prev) => prev.map((o) => (o.key === sel.key ? { ...o, dispatched_at: stamp } : o)));
    setConfirmCancel(false);
    setDispatching(false);
  }

  // Shipped-to block: recipient name leads, phone ends (PR155).
  const shippedTo = sel ? [sel.recipient, sel.address, sel.phone].filter(Boolean).join('\n') : '';

  // PR155 — bodyview: the body shows EITHER the search + full-width shipped list OR the tapped
  // shipment's detail with a ← back button; the shell hides the tab bar while the detail is open.
  return (
    <div className="bodyview">
      {/* ── List ── */}
      {!sel && (
        <>
        <div className="search-row" style={{ padding: '0 0 8px' }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Search name, SKU, or courier…" />
        </div>
        {orders.length === 0 && <div className="hint fq-empty">{searching ? (query.trim() ? 'Searching…' : 'Loading history…') : 'No shipped orders.'}</div>}
        <ul className="fq-list">
          {orders.map((o) => (
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
                send: items return to Ready-to-ship, order back to Need send, no stock adjustment. Inline
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
                    Cancel this shipment? Its {sel.item_count} {sel.item_count === 1 ? 'item' : 'items'} return to Ready-to-ship and the order goes back to Need send. No stock is changed (nothing left the shelf).
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

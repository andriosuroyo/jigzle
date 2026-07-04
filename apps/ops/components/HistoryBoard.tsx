'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { volWeight } from '@jigzle/lib';
import AppHeader from '@/components/AppHeader';
import { getHistory, setOrderNote } from '@/app/history/actions';
import { getOrderSummary, deleteOrder } from '@/app/pending/actions';
import DeleteOrderConfirm from '@/components/DeleteOrderConfirm';
import type { HistoryRow, HistoryState } from '@/app/history/types';
import type { OrderSummary, BoxSummary } from '@/app/pending/types';
import type { BoxPreset } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import SearchInput from '@/components/SearchInput';
import StatusCircles, { payTone, type CircleTone } from '@/components/StatusCircles';

const STATE_LABEL: Record<HistoryState, string> = {
  cancelled: 'Cancelled',
  need_payment: 'Need payment',
  need_send: 'Need send',
  ready_to_ship: 'Ready to ship',
  complete: 'Complete',
};
const fmtIDR = (n: number | null | undefined): string => 'Rp ' + (n ?? 0).toLocaleString('id-ID');

// PR146 — the box circle's tone from the lifecycle state. History is terminal-only (PR149:
// Complete + Cancelled), so in practice: complete green, cancelled grey.
function boxToneOf(state: HistoryState): CircleTone {
  if (state === 'complete') return 'green';
  if (state === 'ready_to_ship') return 'yellow';
  return 'grey';
}

export default function HistoryBoard({
  initialOrders,
  boxPresets,
  userEmail,
  embedded = false,
  onCountChange,
  reloadKey = 0,
}: {
  initialOrders: HistoryRow[];
  boxPresets: BoxPreset[];
  userEmail: string;
  // JZ-001: Orders pipeline window. History is a read-only log → no onAdvance, just count + reload.
  // Settling payment is intentionally NOT here — Pending is the single gateway for that (avoids two
  // places that can drift out of sync).
  embedded?: boolean;
  onCountChange?: (n: number) => void;
  reloadKey?: number;
}) {
  const [orders, setOrders] = useState<HistoryRow[]>(initialOrders);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [yearFilter, setYearFilter] = useState<string | null>(null); // the selected year sub-tab

  const [selRow, setSelRow] = useState<HistoryRow | null>(null); // the clicked row → date + derived status
  const [summary, setSummary] = useState<OrderSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // PR148: delete goes through the overlay confirm; its error stays in the modal.
  const [confirmDel, setConfirmDel] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [copiedId, setCopiedId] = useState(false); // PR165: order-number copy feedback
  const sumReqRef = useRef(0);
  const searchSeq = useRef(0);   // stale-response guard for the live search
  const firstRun = useRef(true); // skip the debounced refetch on mount (initialOrders already loaded)
  const selId = selRow?.sales_id ?? null;

  // Reverse-map a shipped box's stored dims → a SETTINGS preset code (XS/M2/…); 'Custom' if no exact
  // match. The box table only stores dims, not the preset, so this is a best-effort label.
  function boxType(b: BoxSummary): string {
    if (b.dim_p == null || b.dim_l == null || b.dim_t == null) return 'Custom';
    const m = boxPresets.find((p) => p.dim_p === b.dim_p && p.dim_l === b.dim_l && p.dim_t === b.dim_t);
    return m ? m.code : 'Custom';
  }

  const imgCodes = useMemo(
    () => (summary?.lines ?? []).map((l) => l.item_code).filter((c): c is string => !!c),
    [summary]
  );
  const imgMap = useSkuImages(imgCodes);

  // PR164 — year sub-tabs (newest first; null-date orders bucket under '—' at the end), each with a
  // count. Mirrors Inbound/Outbound History so the full terminal-order log is browsable by year, and a
  // new year (e.g. 2027) appears automatically as soon as an order lands in it.
  const yearOf = (o: HistoryRow): string => (o.order_date ? o.order_date.slice(0, 4) : '—');
  const years = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of orders) m.set(yearOf(o), (m.get(yearOf(o)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => {
      if (a[0] === '—') return 1;
      if (b[0] === '—') return -1;
      return a[0] < b[0] ? 1 : -1; // newest first
    });
  }, [orders]);
  // keep the selected year valid as the list changes (search / reload): default to the newest year.
  useEffect(() => {
    if (!years.length) { if (yearFilter !== null) setYearFilter(null); return; }
    if (!yearFilter || !years.some(([y]) => y === yearFilter)) setYearFilter(years[0][0]);
  }, [years, yearFilter]);
  const visibleRows = useMemo(
    () => (yearFilter ? orders.filter((o) => yearOf(o) === yearFilter) : orders),
    [orders, yearFilter]
  );

  async function runSearch() {
    const _id = ++searchSeq.current;
    setSearching(true);
    try {
      const rows = await getHistory(query.trim());
      if (searchSeq.current !== _id) return; // a newer search superseded this one
      setOrders(rows);
    } catch {
      /* keep current on transient error */
    } finally {
      if (searchSeq.current === _id) setSearching(false);
    }
  }

  // JZ-001: live count badge + external reload (re-runs the current search; see PendingBoard).
  useEffect(() => { onCountChange?.(orders.length); }, [orders, onCountChange]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) runSearch(); }, [reloadKey]);
  // live search: re-query as you type (empty query = recent orders), debounced. Skip the mount run —
  // initialOrders is already loaded — so we only refetch once the user actually types.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => { runSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function startEditNote() {
    setNoteDraft(summary?.order_note ?? '');
    setEditingNote(true);
  }

  // PR165: one-tap copy of the order number, with a brief ✓ confirmation.
  async function copyOrderId() {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary.sales_id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    } catch {
      setError('Copy failed — select the order number and copy manually.');
    }
  }

  async function doSaveNote() {
    if (!summary) return;
    setSavingNote(true);
    setError(null);
    try {
      const saved = await setOrderNote(summary.sales_id, noteDraft);
      setSummary({ ...summary, order_note: saved });
      setEditingNote(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save note failed.');
    } finally {
      setSavingNote(false);
    }
  }

  // PR148: delete via delete_order — payments + shipping records go with the order; shipped units
  // stay deducted from stock (the RPC logs a compensating adjustment). Snapshot in order_delete_log.
  async function doDelete() {
    if (!summary) return;
    setDeleting(true);
    setDelErr(null);
    try {
      const { error: err } = await deleteOrder(summary.sales_id);
      if (err) { setDelErr(err); return; }
      setConfirmDel(false);
      setSuccess(`${summary.sales_id} deleted.`);
      setSelRow(null);
      setSummary(null);
      await runSearch();
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  }

  async function openOrder(row: HistoryRow) {
    setError(null);
    setSuccess(null);
    setEditingNote(false);
    setSelRow(row);
    setSummary(null);
    const myReq = ++sumReqRef.current;
    setLoadingSummary(true);
    try {
      const s = await getOrderSummary(row.sales_id);
      if (sumReqRef.current === myReq) setSummary(s);
    } catch (e) {
      if (sumReqRef.current === myReq) setError(e instanceof Error ? e.message : 'Failed to load summary.');
    } finally {
      if (sumReqRef.current === myReq) setLoadingSummary(false);
    }
  }

  // PR147 — bodyview: the body shows EITHER the full-width list OR the tapped order's detail with a
  // ← back button (the Purchasing-History pattern); breadcrumb + pipeline tabs stay put above.
  const body = (
    <div className="bodyview">
      {error && <div className="validation err">{error}</div>}
      {success && <div className="validation ok">{success}</div>}

      {/* ── List ── */}
      {!selId && (
        <>
          <div className="search-row" style={{ padding: '0 0 8px' }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Search by customer ID, order ID, or SKU…" />
          </div>
          {/* Year sub-tabs (newest first, each with a count) — the full log divided by order year. */}
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
          {visibleRows.length === 0 && <div className="hint fq-empty">{searching ? 'Searching…' : 'No orders.'}</div>}
          <ul className="fq-list">
            {visibleRows.map((o) => (
              <li key={o.sales_id}>
                {/* PR146 row: customer id + date on top; state (Complete implied → no pill) + item
                    count left, dual status circles bottom-right. */}
                <button className="fq-row" onClick={() => openOrder(o)}>
                  <div className="fq-row-top">
                    <span className="fq-headline">{o.customer_name || '—'}</span>
                    <span className="ord-date">{o.order_date ? o.order_date.slice(0, 10) : '—'}</span>
                  </div>
                  <div className="fq-row-bot">
                    {o.state !== 'complete' && <span className={`ord-state ${o.state}`}>{STATE_LABEL[o.state]}</span>}
                    <span>{o.item_count} {o.item_count === 1 ? 'item' : 'items'}</span>
                    <StatusCircles box={boxToneOf(o.state)} pay={payTone(o.payment_status)} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── Detail (read-only summary + note) ── */}
      {selId && (
        <>
          <button className="btn-link bv-back" onClick={() => { setSelRow(null); setSummary(null); }}>← back</button>
          <div className="bv-detail">
          {loadingSummary && <div className="hint">Loading summary…</div>}
          {!loadingSummary && summary && (
            <>
              {/* PR144 header: customer id left, order date right; the sales id moved to the bottom. */}
              <div className="fd-head">
                <div className="fd-head-row">
                  <div className="fd-title fd-title-plain">{summary.customer_name || '—'}</div>
                  {selRow?.order_date && <span className="fd-date">{selRow.order_date.slice(0, 10)}</span>}
                </div>
              </div>

              <section className="fd-section">
                <div className="ord-pay-grid">
                  <div><span className="ord-pay-k">Total</span><span className="ord-pay-v">{fmtIDR(summary.sales_total_idr)}</span></div>
                  <div><span className="ord-pay-k">Paid</span><span className="ord-pay-v">{fmtIDR(summary.paid_idr)}</span></div>
                  {/* Status mirrors the quick-view list pill (same derivation) — right-aligned. */}
                  <div className="ord-pay-status-col">
                    <span className="ord-pay-k">Status</span>
                    {selRow && <span className={`ord-state ${selRow.state}`}>{STATE_LABEL[selRow.state]}</span>}
                  </div>
                </div>

                <div className="fd-section-head" style={{ marginTop: 12 }}>Shipped items</div>
                <ul className="ff-lines">
                  {summary.lines.map((l) => (
                    <li key={l.line_id} className="ff-line pend-line">
                      <SkuImage status={imgMap[l.item_code ?? '']?.status} displayUrl={imgMap[l.item_code ?? '']?.displayUrl} name={l.name} size={SKU_IMG.sm} />
                      <div className="pend-line-main">
                        <span className="ff-code">{l.item_code || '—'}</span>
                        <span className="ff-name">{l.name}</span>
                      </div>
                      <span className="ff-qty">×{l.qty}</span>
                      {(l.courier_label || l.courier_tracking) && (
                        <span className="ord-sum-courier">{l.courier_label || '—'}{l.courier_tracking ? ` · #${l.courier_tracking}` : ''}</span>
                      )}
                    </li>
                  ))}
                  {summary.lines.length === 0 && <li className="hint">No shipped lines yet.</li>}
                </ul>

                {summary.boxes.length > 0 && (
                  <>
                    <div className="fd-section-head" style={{ marginTop: 12 }}>Boxes</div>
                    <ul className="ff-lines">
                      {summary.boxes.map((b, i) => {
                        const dims = b.dim_p != null && b.dim_l != null && b.dim_t != null
                          ? `${b.dim_p} x ${b.dim_l} x ${b.dim_t} cm`
                          : '— cm';
                        const vol = b.dim_p != null && b.dim_l != null && b.dim_t != null
                          ? Math.round(volWeight(b.dim_p, b.dim_l, b.dim_t))
                          : null;
                        return (
                          <li key={b.box_id} className="box-sum">
                            <span className="box-idx" aria-label={`Box ${i + 1}`}>{i + 1}</span>
                            <div className="box-sum-main">
                              <span className="box-sum-l1">{boxType(b)} · {dims}</span>
                              <span className="box-sum-l2">vol: {vol != null ? `${vol} g` : '—'} · real: {b.real_weight != null ? `${b.real_weight} g` : '—'}</span>
                            </div>
                            <span className="ff-qty">{b.chargeable_weight != null ? `${Math.round(b.chargeable_weight)} g` : '—'}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>

              {/* Address (PR144) — the selected address in full format: recipient, address, phone.
                  "No address selected yet" when the order has none (SA-1 deferred). */}
              <section className="fd-section">
                <div className="fd-section-head">Address</div>
                {summary.ship_address || summary.ship_recipient ? (
                  <div className="fd-addr">
                    {summary.ship_recipient && <b>{summary.ship_recipient}</b>}
                    {summary.ship_address}
                    {summary.ship_phone ? `\n${summary.ship_phone}` : ''}
                  </div>
                ) : (
                  <div className="hint">No address selected yet.</div>
                )}
              </section>

              {/* Note — the one editable thing on History (free text on the order). Add / edit / clear. */}
              <section className="fd-section">
                <div className="fd-section-head">Note</div>
                {!editingNote ? (
                  <>
                    {summary.order_note ? (
                      <p className="order-note">{summary.order_note}</p>
                    ) : (
                      <div className="hint">No note yet.</div>
                    )}
                    <button className="btn-link" onClick={startEditNote}>{summary.order_note ? 'Edit note' : '+ Add note'}</button>
                  </>
                ) : (
                  <>
                    <textarea
                      className="note-input"
                      rows={3}
                      placeholder="Add a note for this order…"
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                    />
                    <div className="fd-commit-actions" style={{ marginTop: 8 }}>
                      <button className="btn-secondary" onClick={() => setEditingNote(false)} disabled={savingNote}>Cancel</button>
                      <button className="btn-primary" onClick={doSaveNote} disabled={savingNote}>{savingNote ? 'Saving…' : 'Save note'}</button>
                    </div>
                  </>
                )}
              </section>

              {/* Delete (PR148 — overlay confirm; available even on completed orders) */}
              <div className="ob-return">
                <button className="btn-link pend-delete" onClick={() => { setDelErr(null); setConfirmDel(true); }} disabled={deleting}>Delete order</button>
              </div>

              {/* PR165: order number at the bottom right with a one-tap copy icon */}
              <div className="fd-orderid">
                <span>{summary.sales_id}</span>
                <button className="fd-orderid-copy" onClick={copyOrderId} aria-label="Copy order number" title="Copy order number">
                  {copiedId ? '✓ Copied' : '⧉'}
                </button>
              </div>

              {confirmDel && (
                <DeleteOrderConfirm
                  salesId={summary.sales_id}
                  lines={[
                    'The order, its payments and its shipping records are removed.',
                    'Shipped units stay deducted from stock (a compensating adjustment is logged).',
                  ]}
                  busy={deleting}
                  error={delErr}
                  onConfirm={doDelete}
                  onCancel={() => setConfirmDel(false)}
                />
              )}
            </>
          )}
          {!loadingSummary && !summary && <div className="hint">Summary not available.</div>}
          </div>
        </>
      )}
    </div>
  );

  if (embedded) return body;
  return (
    <div className="ops">
      <AppHeader active="orders" userEmail={userEmail} />
      {body}
    </div>
  );
}

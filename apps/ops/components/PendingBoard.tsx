'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { getPending, sendReadyItems, deleteOrder, markOrderPaid } from '@/app/pending/actions';
import DeleteOrderConfirm from '@/components/DeleteOrderConfirm';
import type { OrderDot, PendingOrder } from '@/app/pending/types';
import type { CommonNote } from '@/app/settings/types';
import NoteEditor from '@/components/NoteEditor';
import SkuImage from '@/components/SkuImage';
import StatusCircles, { payTone } from '@/components/StatusCircles';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

type DotFilter = 'all' | OrderDot;
const FILTERS: { key: DotFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'red', label: 'To order' },
  { key: 'yellow', label: 'On the way' },
  { key: 'green', label: 'Ready' },
];
const STATUS_LABEL: Record<string, string> = { available: 'available', on_the_way: 'on the way', to_order: 'to order' };
const fmtIDR = (n: number | null | undefined): string => 'Rp ' + (n ?? 0).toLocaleString('id-ID');

export default function PendingBoard({
  initialOrders,
  userEmail,
  commonNotes = [],
  embedded = false,
  onCountChange,
  onAdvance,
  reloadKey = 0,
}: {
  initialOrders: PendingOrder[];
  userEmail: string;
  commonNotes?: CommonNote[];
  // JZ-001: when mounted inside the Orders pipeline window, drop the page chrome (the shell owns the
  // AppHeader + tab bar) and report list count / stage advances up to the shell. Optional → the
  // standalone /pending deep-link still renders unchanged.
  embedded?: boolean;
  onCountChange?: (n: number) => void;
  onAdvance?: (salesId: string, toStage: string) => void;
  reloadKey?: number;
}) {
  const [orders, setOrders] = useState<PendingOrder[]>(initialOrders);
  const [filter, setFilter] = useState<DotFilter>('all');
  const [loadingList, setLoadingList] = useState(false);

  const [selId, setSelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // PR148: delete goes through the overlay confirm (no bare window.confirm); its error stays in the modal.
  const [confirmDel, setConfirmDel] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const reqRef = useRef(0);

  const visible = useMemo(() => (filter === 'all' ? orders : orders.filter((o) => o.dot === filter)), [orders, filter]);

  // Per-filter counts for the readiness tabs (red+yellow+green sum to the All total — every order has
  // exactly one dot).
  const dotCounts = useMemo(() => {
    const c: Record<OrderDot, number> = { red: 0, yellow: 0, green: 0 };
    for (const o of orders) c[o.dot]++;
    return c;
  }, [orders]);
  const filterCount = (k: DotFilter) => (k === 'all' ? orders.length : dotCounts[k]);
  const sel = useMemo(() => orders.find((o) => o.sales_id === selId) ?? null, [orders, selId]);

  const imgCodes = useMemo(
    () => (sel?.lines ?? []).map((l) => l.item_code).filter((c): c is string => !!c),
    [sel]
  );
  const imgMap = useSkuImages(imgCodes);

  async function refresh() {
    setLoadingList(true);
    try {
      setOrders(await getPending());
    } catch {
      /* keep current on transient error */
    } finally {
      setLoadingList(false);
    }
  }

  // JZ-001: live count badge — report the queue size to the shell whenever it changes.
  useEffect(() => { onCountChange?.(orders.length); }, [orders, onCountChange]);
  // JZ-001: refetch when the shell bumps reloadKey (e.g. a new order was just created in the overlay).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) refresh(); }, [reloadKey]);

  function openOrder(o: PendingOrder) {
    setError(null);
    setSuccess(null);
    setSelId(o.sales_id);
  }

  // reflect a saved per-line note in local state so it survives re-renders without a refetch.
  function applyLineNote(salesId: string, lineId: string, note: string | null) {
    setOrders((prev) =>
      prev.map((o) =>
        o.sales_id === salesId
          ? { ...o, lines: o.lines.map((l) => (l.line_id === lineId ? { ...l, line_note: note } : l)) }
          : o
      )
    );
  }

  // FP-6: cut the ready lines (available ≥ qty). Short lines stay in Pending; the cut lines move to Fulfill.
  async function doSendReady() {
    if (!sel) return;
    const readyIds = sel.lines.filter((l) => l.ready).map((l) => l.line_id);
    if (!readyIds.length) return;
    setBusy(true);
    setError(null);
    try {
      const { error: sendErr } = await sendReadyItems(sel.sales_id, readyIds);
      if (sendErr) { setError(sendErr); return; }
      setSuccess(`${sel.sales_id}: sent ${readyIds.length} ready item${readyIds.length === 1 ? '' : 's'} to Fulfill.`);
      onAdvance?.(sel.sales_id, 'Fulfill'); // JZ-001: pipeline toast — order advanced a stage
      setSelId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send ready items failed.');
    } finally {
      setBusy(false);
    }
  }

  // One-tap settle: pay off the whole remaining balance, method recorded as 'manual' (no amount/method
  // entry — that detail isn't tracked here). Pending is the single gateway for settling payment.
  async function doMarkPaid() {
    if (!sel || sel.balance <= 0) return;
    const myReq = ++reqRef.current;
    setBusy(true);
    setError(null);
    try {
      const { error: payErr, result: res } = await markOrderPaid(sel.sales_id, sel.balance, 'manual');
      if (reqRef.current !== myReq) return;
      if (payErr || !res) { setError(payErr ?? 'Mark paid failed.'); return; }
      setSuccess(`${sel.sales_id}: ${res.balance <= 0 ? 'fully paid' : 'partially paid'}.`);
      await refresh();
    } catch (e) {
      if (reqRef.current === myReq) setError(e instanceof Error ? e.message : 'Mark paid failed.');
    } finally {
      if (reqRef.current === myReq) setBusy(false);
    }
  }

  // FP-4 / PR148: hard delete via delete_order (any stage; snapshotted into order_delete_log).
  // Runs from the overlay confirm; errors render inside the modal.
  async function doDelete() {
    if (!sel) return;
    setBusy(true);
    setDelErr(null);
    try {
      const { error: err } = await deleteOrder(sel.sales_id);
      if (err) { setDelErr(err); return; }
      setConfirmDel(false);
      setSuccess(`${sel.sales_id} deleted.`);
      setSelId(null);
      await refresh();
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  // PR147 — bodyview: the body shows EITHER the filter tabs + full-width queue OR the tapped order's
  // detail with a ← back button (the Purchasing-History pattern); breadcrumb + pipeline tabs stay put.
  const body = (
    <div className="bodyview">
      {/* success / error pinned to the top for both actions (mark paid + send ready) */}
      {error && <div className="validation err">{error}</div>}
      {success && <div className="validation ok">{success}</div>}

      {/* ── Queue ── */}
      {!sel && (
        <>
          {/* Readiness filter — underline tabs at the top of the queue, each with a live count badge. */}
          <div className="fq-filters" role="tablist" aria-label="Filter by stock readiness">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={filter === f.key}
                className={`fq-filter ${filter === f.key ? 'active' : ''}`}
                onClick={() => setFilter(f.key)}
                disabled={loadingList}
              >
                {f.label}
                <span className="fq-filter-count">{filterCount(f.key)}</span>
              </button>
            ))}
          </div>
          {visible.length === 0 && <div className="hint fq-empty">{loadingList ? 'Loading…' : 'Nothing waiting in Pending.'}</div>}
          <ul className="fq-list">
            {visible.map((o) => (
              <li key={o.sales_id}>
                {/* PR146 row: customer id + date on top; items/ready left, dual status circles
                    (box = readiness dot, $ = payment) bottom-right. */}
                <button className="fq-row" onClick={() => openOrder(o)}>
                  <div className="fq-row-top">
                    <span className="fq-headline">{o.customer_name || '—'}</span>
                    <span className="ord-date">{o.order_date ? o.order_date.slice(0, 10) : '—'}</span>
                  </div>
                  <div className="fq-row-bot">
                    <span>{o.lines.length} {o.lines.length === 1 ? 'item' : 'items'}</span>
                    {o.ready_count > 0 && <span className="pend-ready">{o.ready_count} ready</span>}
                    <StatusCircles box={o.dot === 'red' ? 'red' : o.dot === 'yellow' ? 'yellow' : 'green'} pay={payTone(o.payment_status)} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── Detail ── */}
      {sel && (
        <>
          <button className="btn-link bv-back" onClick={() => setSelId(null)}>← back</button>
          <div className="bv-detail">
            <>
              {/* PR144 header: customer id left, order date right; the sales id moved to the bottom. */}
              <div className="fd-head">
                <div className="fd-head-row">
                  <div className="fd-title fd-title-plain">{sel.customer_name || '—'}</div>
                  {sel.order_date && <span className="fd-date">{sel.order_date.slice(0, 10)}</span>}
                </div>
              </div>

              {/* Lines — compact row: image left, code / name / qty / status to its right */}
              <section className="fd-section">
                <ul className="ff-lines">
                  {sel.lines.map((l) => (
                    <li key={l.line_id} className="ff-line pend-line-card">
                      <div className="pend-line">
                        <SkuImage status={imgMap[l.item_code ?? '']?.status} displayUrl={imgMap[l.item_code ?? '']?.displayUrl} name={l.name} size={SKU_IMG.sm} />
                        <div className="pend-line-main">
                          <span className="ff-code">{l.item_code || '—'}</span>
                          <span className="ff-name">{l.name}</span>
                        </div>
                        <span className="ff-qty">×{l.qty}</span>
                        <span className={`pend-status ${l.status}`}>{STATUS_LABEL[l.status] ?? l.status}</span>
                      </div>
                      <NoteEditor lineId={l.line_id} value={l.line_note} commonNotes={commonNotes} onSaved={(note) => applyLineNote(sel.sales_id, l.line_id, note)} />
                    </li>
                  ))}
                </ul>
              </section>

              {/* Payment — totals only; balance right-aligned, green when clear. Settling is the single
                  "Mark as paid" button below (pays the full balance, method 'manual'). */}
              <section className="fd-section">
                <div className="ord-pay-grid">
                  <div><span className="ord-pay-k">Total</span><span className="ord-pay-v">{fmtIDR(sel.sales_total_idr)}</span></div>
                  <div><span className="ord-pay-k">Paid</span><span className="ord-pay-v">{fmtIDR(sel.paid_idr)}</span></div>
                  <div className="ord-pay-bal-col">
                    <span className="ord-pay-k">Balance</span>
                    <span className={`ord-pay-v ord-pay-bal ${sel.balance > 0 ? 'bal-due' : 'bal-clear'}`}>{fmtIDR(sel.balance)}</span>
                  </div>
                </div>
              </section>

              {/* Actions — Mark as paid + Send ready items, left-aligned at the bottom. PR144: Fulfill =
                  ready AND paid, so Send ready gates on a settled balance (green-but-unpaid stays here). */}
              <div className="fd-commit">
                <div className="fd-commit-actions">
                  {sel.balance > 0 && (
                    <button className="btn-secondary" onClick={doMarkPaid} disabled={busy}>{busy ? 'Saving…' : 'Mark as paid'}</button>
                  )}
                  <button className="btn-primary" onClick={doSendReady} disabled={busy || sel.ready_count === 0 || sel.balance > 0}>
                    {busy ? 'Working…' : `Send ready items${sel.ready_count ? ` (${sel.ready_count})` : ''}`}
                  </button>
                </div>
                {sel.balance > 0 && sel.ready_count > 0 && !busy && (
                  <span className="warn-text">settle payment before sending</span>
                )}
              </div>

              {/* Delete (FP-4 / PR148 — overlay confirm) */}
              <div className="ob-return">
                <button className="btn-link pend-delete" onClick={() => { setDelErr(null); setConfirmDel(true); }} disabled={busy}>Delete order</button>
              </div>

              <div className="fd-orderid">{sel.sales_id}</div>

              {confirmDel && (
                <DeleteOrderConfirm
                  salesId={sel.sales_id}
                  lines={[
                    `${sel.lines.length} pending item${sel.lines.length === 1 ? '' : 's'} removed with the order.`,
                    sel.paid_idr > 0
                      ? `${fmtIDR(sel.paid_idr)} in recorded payments is erased.`
                      : 'No payments recorded on this order.',
                  ]}
                  busy={busy}
                  error={delErr}
                  onConfirm={doDelete}
                  onCancel={() => setConfirmDel(false)}
                />
              )}
            </>
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

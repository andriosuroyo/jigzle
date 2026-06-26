'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { getPending, sendReadyItems, deletePendingOrder, markOrderPaid } from '@/app/pending/actions';
import type { OrderDot, PendingOrder } from '@/app/pending/types';
import type { PaymentMethod } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
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
  paymentMethods,
  userEmail,
  embedded = false,
  onCountChange,
  onAdvance,
  reloadKey = 0,
}: {
  initialOrders: PendingOrder[];
  paymentMethods: PaymentMethod[];
  userEmail: string;
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
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(paymentMethods[0]?.label ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const reqRef = useRef(0);

  const visible = useMemo(() => (filter === 'all' ? orders : orders.filter((o) => o.dot === filter)), [orders, filter]);
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
    setAmount(String(o.balance));
    setMethod(paymentMethods[0]?.label ?? '');
  }

  // FP-6: cut the ready lines (available ≥ qty). Short lines stay in Pending; the cut lines move to Fulfill.
  async function doSendReady() {
    if (!sel) return;
    const readyIds = sel.lines.filter((l) => l.ready).map((l) => l.line_id);
    if (!readyIds.length) return;
    setBusy(true);
    setError(null);
    try {
      await sendReadyItems(sel.sales_id, readyIds);
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

  async function doMarkPaid() {
    if (!sel) return;
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Enter a payment amount.');
      return;
    }
    const myReq = ++reqRef.current;
    setBusy(true);
    setError(null);
    try {
      const res = await markOrderPaid(sel.sales_id, amt, method || null);
      if (reqRef.current !== myReq) return;
      setSuccess(`${sel.sales_id}: paid ${fmtIDR(res.paid)}, balance ${fmtIDR(res.balance)} (${res.payment_status}).`);
      await refresh();
      setAmount('0');
    } catch (e) {
      if (reqRef.current === myReq) setError(e instanceof Error ? e.message : 'Mark paid failed.');
    } finally {
      if (reqRef.current === myReq) setBusy(false);
    }
  }

  // FP-4: hard delete. Confirm popup warns when the order has recorded payments.
  async function doDelete() {
    if (!sel) return;
    const warn =
      sel.paid_idr > 0
        ? `${sel.sales_id} has ${fmtIDR(sel.paid_idr)} recorded — deleting erases the order AND its payments. Continue?`
        : `Delete ${sel.sales_id}? This permanently removes the order. Continue?`;
    if (!window.confirm(warn)) return;
    setBusy(true);
    setError(null);
    try {
      await deletePendingOrder(sel.sales_id);
      setSuccess(`${sel.sales_id} deleted.`);
      setSelId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <>
      <div className="fulfill-layout">
        {/* ── Board ── */}
        <aside className="fq-pane">
          <div className="inv-states" style={{ padding: '8px 8px 0', marginTop: 0 }}>
            {FILTERS.map((f) => (
              <button key={f.key} className={`inv-state ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)} disabled={loadingList}>
                {f.label}
              </button>
            ))}
          </div>
          {visible.length === 0 && <div className="hint fq-empty">{loadingList ? 'Loading…' : 'Nothing waiting in Pending.'}</div>}
          <ul className="fq-list">
            {visible.map((o) => (
              <li key={o.sales_id}>
                <button className={`fq-row ${selId === o.sales_id ? 'active' : ''}`} onClick={() => openOrder(o)}>
                  <div className="fq-row-top">
                    <span className={`pend-dot ${o.dot}`} aria-hidden="true" />
                    <span className="fq-id">{o.sales_id}</span>
                    <span className="fq-cust">{o.customer_name || '—'}</span>
                  </div>
                  <div className="fq-row-bot">
                    <span className={`pay pay-${(o.payment_status || '').toLowerCase()}`}>{o.payment_status || '—'}</span>
                    <span>{o.lines.length} {o.lines.length === 1 ? 'item' : 'items'}</span>
                    {o.ready_count > 0 && <span className="pend-ready">{o.ready_count} ready</span>}
                    <span className="ord-date">{o.order_date ? o.order_date.slice(0, 10) : '—'}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* ── Detail ── */}
        <main className="fd-pane">
          {!sel && <div className="fd-empty">Pick an order to send ready items, settle payment, or delete.</div>}
          {error && <div className="validation err">{error}</div>}
          {success && <div className="validation ok">{success}</div>}

          {sel && (
            <>
              <div className="fd-head">
                <div className="fd-title">{sel.sales_id}</div>
                <div className="fd-sub">{sel.customer_name || '—'}</div>
              </div>

              {/* Lines (Pattern A) */}
              <section className="fd-section">
                <div className="fd-section-head">Items</div>
                <ul className="ff-lines">
                  {sel.lines.map((l) => (
                    <li key={l.line_id} className="ff-line pend-line">
                      <SkuImage status={imgMap[l.item_code ?? '']?.status} displayUrl={imgMap[l.item_code ?? '']?.displayUrl} name={l.name} size={SKU_IMG.md} />
                      <div className="pend-line-main">
                        <span className="ff-code">{l.item_code || '—'}</span>
                        <span className="ff-name">{l.name}</span>
                      </div>
                      <span className="ff-qty">×{l.qty}</span>
                      <span className={`pend-status ${l.status}`}>{STATUS_LABEL[l.status] ?? l.status}</span>
                    </li>
                  ))}
                </ul>
                <div className="fd-commit">
                  {sel.ready_count === 0 && <span className="warn-text">no ready items yet</span>}
                  <button className="btn-primary" onClick={doSendReady} disabled={busy || sel.ready_count === 0}>
                    {busy ? 'Working…' : `Send ready items${sel.ready_count ? ` (${sel.ready_count})` : ''}`}
                  </button>
                </div>
              </section>

              {/* Payment (FP-7) — show when there's a balance */}
              {sel.balance > 0 && (
                <section className="fd-section">
                  <div className="fd-section-head">Payment</div>
                  <div className="ord-pay-grid">
                    <div><span className="ord-pay-k">Total</span><span className="ord-pay-v">{fmtIDR(sel.sales_total_idr)}</span></div>
                    <div><span className="ord-pay-k">Paid</span><span className="ord-pay-v">{fmtIDR(sel.paid_idr)}</span></div>
                    <div><span className="ord-pay-k">Balance</span><span className="ord-pay-v ord-pay-bal">{fmtIDR(sel.balance)}</span></div>
                  </div>
                  <div className="po-field" style={{ marginTop: 12 }}>
                    <label>Amount (full IDR)</label>
                    <input type="number" inputMode="numeric" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
                    <button className="btn-link" type="button" onClick={() => setAmount(String(sel.balance))} style={{ marginTop: 4 }}>
                      Set to balance ({fmtIDR(sel.balance)})
                    </button>
                  </div>
                  <div className="po-field">
                    <label>Method</label>
                    {paymentMethods.length === 0 ? (
                      <div className="hint">No payment methods — add them in Settings.</div>
                    ) : (
                      <select value={method} onChange={(e) => setMethod(e.target.value)}>
                        {paymentMethods.map((m) => <option key={m.id} value={m.label}>{m.label}</option>)}
                      </select>
                    )}
                  </div>
                  <div className="fd-commit">
                    <button className="btn-secondary" onClick={doMarkPaid} disabled={busy}>{busy ? 'Saving…' : 'Mark paid'}</button>
                  </div>
                </section>
              )}

              {/* Delete pending (FP-4) */}
              <div className="ob-return">
                <button className="btn-link pend-delete" onClick={doDelete} disabled={busy}>Delete pending order</button>
                <span className="hint">Permanently removes the order{sel.paid_idr > 0 ? ' and its recorded payments' : ''}.</span>
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );

  if (embedded) return body;
  return (
    <div className="ops">
      <AppHeader active="orders" userEmail={userEmail} />
      {body}
    </div>
  );
}

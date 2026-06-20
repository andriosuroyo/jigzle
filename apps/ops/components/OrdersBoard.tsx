'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { getOrders, getOrderSummary, markOrderPaid } from '@/app/orders/actions';
import type { OrderFilter, OrderRow, OrderState, OrderSummary } from '@/app/orders/types';
import type { PaymentMethod } from '@/app/settings/types';

const FILTERS: { key: OrderFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'need_payment', label: 'Need payment' },
  { key: 'need_send', label: 'Need send' },
  { key: 'ready_to_ship', label: 'Ready to ship' },
  { key: 'complete', label: 'Complete' },
];

const STATE_LABEL: Record<OrderState, string> = {
  need_payment: 'Need payment',
  need_send: 'Need send',
  ready_to_ship: 'Ready to ship',
  complete: 'Complete',
};

const fmtIDR = (n: number | null | undefined): string => 'Rp ' + (n ?? 0).toLocaleString('id-ID');

export default function OrdersBoard({
  initialOrders,
  paymentMethods,
  userEmail,
}: {
  initialOrders: OrderRow[];
  paymentMethods: PaymentMethod[];
  userEmail: string;
}) {
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [orders, setOrders] = useState<OrderRow[]>(initialOrders);
  const [loadingList, setLoadingList] = useState(false);

  const [sel, setSel] = useState<OrderRow | null>(null);
  const [summary, setSummary] = useState<OrderSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(paymentMethods[0]?.label ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const reqRef = useRef(0);

  async function refresh(f: OrderFilter = filter) {
    setLoadingList(true);
    try {
      setOrders(await getOrders(f));
    } catch {
      /* keep current on transient error */
    } finally {
      setLoadingList(false);
    }
  }

  async function changeFilter(f: OrderFilter) {
    setFilter(f);
    setSel(null);
    setSummary(null);
    await refresh(f);
  }

  async function openOrder(row: OrderRow) {
    setError(null);
    setSuccess(null);
    setSel(row);
    setSummary(null);
    if (row.state === 'need_payment') {
      setAmount(String(row.balance));
      setMethod(paymentMethods[0]?.label ?? '');
    } else if (row.state === 'complete') {
      const myReq = ++reqRef.current;
      setLoadingSummary(true);
      try {
        const s = await getOrderSummary(row.sales_id);
        if (reqRef.current === myReq) setSummary(s);
      } catch (e) {
        if (reqRef.current === myReq) setError(e instanceof Error ? e.message : 'Failed to load summary.');
      } finally {
        if (reqRef.current === myReq) setLoadingSummary(false);
      }
    }
  }

  async function doMarkPaid() {
    if (!sel) return;
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Enter a payment amount.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await markOrderPaid(sel.sales_id, amt, method || null);
      setSuccess(
        res.status === 'Need send'
          ? `${sel.sales_id} fully paid → Need send (now in the Fulfill queue).`
          : `${sel.sales_id}: paid ${fmtIDR(res.paid)}, balance ${fmtIDR(res.balance)} (still Need payment).`
      );
      setSel(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mark paid failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ops">
      <AppHeader active="orders" userEmail={userEmail} />

      <div className="fulfill-layout">
        {/* ── Board ── */}
        <aside className="fq-pane">
          <div className="inv-states" style={{ padding: '8px 8px 0', marginTop: 0 }}>
            {FILTERS.map((f) => (
              <button key={f.key} className={`inv-state ${filter === f.key ? 'active' : ''}`} onClick={() => changeFilter(f.key)} disabled={loadingList}>
                {f.label}
              </button>
            ))}
          </div>
          {orders.length === 0 && <div className="hint fq-empty">{loadingList ? 'Loading…' : 'No orders in this state.'}</div>}
          <ul className="fq-list">
            {orders.map((o) => (
              <li key={o.sales_id}>
                <button className={`fq-row ${sel?.sales_id === o.sales_id ? 'active' : ''}`} onClick={() => openOrder(o)}>
                  <div className="fq-row-top">
                    <span className="fq-id">{o.sales_id}</span>
                    <span className="fq-cust">{o.customer_name || '—'}</span>
                  </div>
                  <div className="fq-row-bot">
                    <span className={`ord-state ${o.state}`}>{STATE_LABEL[o.state]}</span>
                    <span className={`pay pay-${(o.payment_status || '').toLowerCase()}`}>{o.payment_status || '—'}</span>
                    <span>{o.item_count} {o.item_count === 1 ? 'item' : 'items'}</span>
                    <span className="ord-date">{o.order_date ? o.order_date.slice(0, 10) : '—'}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* ── Stage panel ── */}
        <main className="fd-pane">
          {!sel && <div className="fd-empty">Pick an order to see its next step.</div>}
          {error && <div className="validation err">{error}</div>}
          {success && <div className="validation ok">{success}</div>}

          {sel && (
            <>
              <div className="fd-head">
                <div className="fd-title">{sel.sales_id}</div>
                <div className="fd-sub">{sel.customer_name || '—'} · {STATE_LABEL[sel.state]}</div>
              </div>

              {/* Need payment → Payment panel */}
              {sel.state === 'need_payment' && (
                <section className="fd-section">
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
                    <button className="btn-primary" onClick={doMarkPaid} disabled={busy}>
                      {busy ? 'Saving…' : 'Mark paid'}
                    </button>
                  </div>
                </section>
              )}

              {/* Need send → route to the Fulfill screen (no duplicated pick logic) */}
              {sel.state === 'need_send' && (
                <section className="fd-section">
                  <div className="hint">This order is paid and ready to pick. {sel.item_count} item{sel.item_count === 1 ? '' : 's'}.</div>
                  <div className="fd-commit">
                    <Link className="btn-primary" href={`/fulfill?order=${encodeURIComponent(sel.sales_id)}`}>Open in Fulfill →</Link>
                  </div>
                </section>
              )}

              {/* Ready to ship → route to the Outbound screen */}
              {sel.state === 'ready_to_ship' && (
                <section className="fd-section">
                  <div className="hint">Fulfilled and waiting to ship. Pack-verify + ship (or Return to Fulfill) in Outbound.</div>
                  <div className="fd-commit">
                    <Link className="btn-primary" href={`/outbound?order=${encodeURIComponent(sel.sales_id)}`}>Open in Outbound →</Link>
                  </div>
                </section>
              )}

              {/* Complete → read-only summary */}
              {sel.state === 'complete' && (
                <section className="fd-section">
                  {loadingSummary && <div className="hint">Loading summary…</div>}
                  {!loadingSummary && summary && (
                    <>
                      <div className="ord-pay-grid">
                        <div><span className="ord-pay-k">Total</span><span className="ord-pay-v">{fmtIDR(summary.sales_total_idr)}</span></div>
                        <div><span className="ord-pay-k">Paid</span><span className="ord-pay-v">{fmtIDR(summary.paid_idr)}</span></div>
                        <div><span className="ord-pay-k">Payment</span><span className="ord-pay-v">{summary.payment_status || '—'}</span></div>
                      </div>
                      <div className="fd-section-head" style={{ marginTop: 12 }}>Shipped items</div>
                      <ul className="ord-sum-list">
                        {summary.lines.map((l) => (
                          <li key={l.line_id} className="ord-sum-line">
                            <span className="ff-code">{l.item_code || '—'}</span>
                            <span className="ff-name">{l.name}</span>
                            <span className="ff-qty">×{l.qty}</span>
                            <span className="ord-sum-courier">{l.courier_label || '—'}{l.courier_tracking ? ` · #${l.courier_tracking}` : ''}</span>
                          </li>
                        ))}
                        {summary.lines.length === 0 && <li className="hint">No shipped lines.</li>}
                      </ul>
                      {summary.boxes.length > 0 && (
                        <>
                          <div className="fd-section-head" style={{ marginTop: 12 }}>Boxes (chargeable, grams)</div>
                          <ul className="ord-sum-list">
                            {summary.boxes.map((b, i) => (
                              <li key={b.box_id} className="ord-sum-line">
                                <span>Box {i + 1}</span>
                                <span className="ff-name">{b.dim_p ?? '—'}·{b.dim_l ?? '—'}·{b.dim_t ?? '—'} cm · real {b.real_weight ?? '—'} g</span>
                                <span className="ff-qty">{b.chargeable_weight != null ? `${b.chargeable_weight} g` : '—'}</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </>
                  )}
                  {!loadingSummary && !summary && <div className="hint">Summary not available.</div>}
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

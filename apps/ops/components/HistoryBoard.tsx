'use client';

import { useEffect, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { getHistory } from '@/app/history/actions';
import { getOrderSummary, markOrderPaid } from '@/app/pending/actions';
import type { HistoryRow, HistoryState } from '@/app/history/types';
import type { OrderSummary } from '@/app/pending/types';
import type { PaymentMethod } from '@/app/settings/types';

const STATE_LABEL: Record<HistoryState, string> = {
  cancelled: 'Cancelled',
  need_payment: 'Need payment',
  need_send: 'Need send',
  ready_to_ship: 'Ready to ship',
  complete: 'Complete',
};
const fmtIDR = (n: number | null | undefined): string => 'Rp ' + (n ?? 0).toLocaleString('id-ID');

export default function HistoryBoard({
  initialOrders,
  paymentMethods,
  userEmail,
  embedded = false,
  onCountChange,
  reloadKey = 0,
}: {
  initialOrders: HistoryRow[];
  paymentMethods: PaymentMethod[];
  userEmail: string;
  // JZ-001: Orders pipeline window. History is a read-only log → no onAdvance, just count + reload.
  embedded?: boolean;
  onCountChange?: (n: number) => void;
  reloadKey?: number;
}) {
  const [orders, setOrders] = useState<HistoryRow[]>(initialOrders);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const [selId, setSelId] = useState<string | null>(null);
  const [summary, setSummary] = useState<OrderSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(paymentMethods[0]?.label ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const reqRef = useRef(0);
  const sumReqRef = useRef(0);

  async function runSearch() {
    setSearching(true);
    try {
      setOrders(await getHistory(query.trim()));
    } catch {
      /* keep current on transient error */
    } finally {
      setSearching(false);
    }
  }

  // JZ-001: live count badge + external reload (re-runs the current search; see PendingBoard).
  useEffect(() => { onCountChange?.(orders.length); }, [orders, onCountChange]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) runSearch(); }, [reloadKey]);

  async function openOrder(row: HistoryRow) {
    setError(null);
    setSuccess(null);
    setSelId(row.sales_id);
    setSummary(null);
    const myReq = ++sumReqRef.current;
    setLoadingSummary(true);
    try {
      const s = await getOrderSummary(row.sales_id);
      if (sumReqRef.current === myReq) {
        setSummary(s);
        const bal = s ? Math.max((s.sales_total_idr ?? 0) - s.paid_idr, 0) : 0;
        setAmount(String(bal));
        setMethod(paymentMethods[0]?.label ?? '');
      }
    } catch (e) {
      if (sumReqRef.current === myReq) setError(e instanceof Error ? e.message : 'Failed to load summary.');
    } finally {
      if (sumReqRef.current === myReq) setLoadingSummary(false);
    }
  }

  const balance = summary ? Math.max((summary.sales_total_idr ?? 0) - summary.paid_idr, 0) : 0;

  async function doMarkPaid() {
    if (!summary) return;
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Enter a payment amount.');
      return;
    }
    const myReq = ++reqRef.current;
    setBusy(true);
    setError(null);
    try {
      const res = await markOrderPaid(summary.sales_id, amt, method || null);
      if (reqRef.current !== myReq) return;
      setSuccess(`${summary.sales_id}: paid ${fmtIDR(res.paid)}, balance ${fmtIDR(res.balance)} (${res.payment_status}).`);
      // refresh both the row list and this order's summary
      try { setOrders(await getHistory(query.trim())); } catch { /* keep */ }
      const s = await getOrderSummary(summary.sales_id);
      if (reqRef.current === myReq) {
        setSummary(s);
        setAmount('0');
      }
    } catch (e) {
      if (reqRef.current === myReq) setError(e instanceof Error ? e.message : 'Mark paid failed.');
    } finally {
      if (reqRef.current === myReq) setBusy(false);
    }
  }

  const body = (
    <>
      <div className="fulfill-layout">
        {/* ── List ── */}
        <aside className="fq-pane">
          <div className="search-row" style={{ padding: '8px' }}>
            <input
              type="text"
              inputMode="search"
              placeholder="Name, order id, or date (YYYY-MM-DD)…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
            />
            <button className="btn-secondary" onClick={runSearch} disabled={searching}>{searching ? '…' : 'Search'}</button>
          </div>
          {orders.length === 0 && <div className="hint fq-empty">{searching ? 'Searching…' : 'No orders.'}</div>}
          <ul className="fq-list">
            {orders.map((o) => (
              <li key={o.sales_id}>
                <button className={`fq-row ${selId === o.sales_id ? 'active' : ''}`} onClick={() => openOrder(o)}>
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

        {/* ── Detail (read-only summary + Mark paid) ── */}
        <main className="fd-pane">
          {!selId && <div className="fd-empty">Pick an order to see its summary.</div>}
          {error && <div className="validation err">{error}</div>}
          {success && <div className="validation ok">{success}</div>}

          {selId && loadingSummary && <div className="hint">Loading summary…</div>}
          {selId && !loadingSummary && summary && (
            <>
              <div className="fd-head">
                <div className="fd-title">{summary.sales_id}</div>
                <div className="fd-sub">{summary.customer_name || '—'} · {summary.status || '—'}</div>
              </div>

              <section className="fd-section">
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
                  {summary.lines.length === 0 && <li className="hint">No shipped lines yet.</li>}
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
              </section>

              {/* HI-4: Mark paid (the one write on History) — shown when there's a balance */}
              {balance > 0 && (
                <section className="fd-section">
                  <div className="fd-section-head">Settle payment</div>
                  <div className="po-field">
                    <label>Amount (full IDR)</label>
                    <input type="number" inputMode="numeric" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
                    <button className="btn-link" type="button" onClick={() => setAmount(String(balance))} style={{ marginTop: 4 }}>
                      Set to balance ({fmtIDR(balance)})
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
            </>
          )}
          {selId && !loadingSummary && !summary && <div className="hint">Summary not available.</div>}
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

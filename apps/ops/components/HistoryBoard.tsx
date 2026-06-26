'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { volWeight } from '@jigzle/lib';
import AppHeader from '@/components/AppHeader';
import { getHistory } from '@/app/history/actions';
import { getOrderSummary } from '@/app/pending/actions';
import type { HistoryRow, HistoryState } from '@/app/history/types';
import type { OrderSummary, BoxSummary } from '@/app/pending/types';
import type { BoxPreset } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

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

  const [selRow, setSelRow] = useState<HistoryRow | null>(null); // the clicked row → date + derived status
  const [summary, setSummary] = useState<OrderSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sumReqRef = useRef(0);
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
                    <span className="fq-headline">{o.customer_name || '—'}</span>
                    <span className="fq-id-sub">{o.sales_id}</span>
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

          {selId && loadingSummary && <div className="hint">Loading summary…</div>}
          {selId && !loadingSummary && summary && (
            <>
              <div className="fd-head">
                <div className="fd-title fd-title-plain">{summary.customer_name || '—'}</div>
                <div className="fd-sub">{summary.sales_id}{selRow?.order_date ? ` · ${selRow.order_date.slice(0, 10)}` : ''}</div>
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
                            <span className="ff-qty">{b.chargeable_weight != null ? `${b.chargeable_weight} g` : '—'}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>
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

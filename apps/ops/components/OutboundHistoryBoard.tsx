'use client';

// Outbound → History tab: orders this team has shipped. Read-only, searchable by name / SKU / tracking.
// List comes from getShippedHistory; the detail reuses getOrderSummary (shipped lines + boxes), styled
// like the Sales History detail but with no note / no payment write.

import { useEffect, useMemo, useRef, useState } from 'react';
import { volWeight } from '@jigzle/lib';
import { getShippedHistory } from '@/app/outbound/actions';
import { getOrderSummary } from '@/app/pending/actions';
import type { ShippedOrderRow } from '@/app/outbound/types';
import type { OrderSummary, BoxSummary } from '@/app/pending/types';
import type { BoxPreset } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');

export default function OutboundHistoryBoard({
  initialOrders,
  boxPresets,
  onCountChange,
  reloadKey = 0,
}: {
  initialOrders: ShippedOrderRow[];
  boxPresets: BoxPreset[];
  onCountChange?: (n: number) => void;
  reloadKey?: number;
}) {
  const [orders, setOrders] = useState<ShippedOrderRow[]>(initialOrders);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const [selRow, setSelRow] = useState<ShippedOrderRow | null>(null);
  const [summary, setSummary] = useState<OrderSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sumReqRef = useRef(0);
  const selId = selRow?.sales_id ?? null;

  const imgCodes = useMemo(
    () => (summary?.lines ?? []).map((l) => l.item_code).filter((c): c is string => !!c),
    [summary]
  );
  const imgMap = useSkuImages(imgCodes);

  function boxType(b: BoxSummary): string {
    if (b.dim_p == null || b.dim_l == null || b.dim_t == null) return 'Custom';
    const m = boxPresets.find((p) => p.dim_p === b.dim_p && p.dim_l === b.dim_l && p.dim_t === b.dim_t);
    return m ? m.code : 'Custom';
  }

  async function runSearch() {
    setSearching(true);
    try {
      setOrders(await getShippedHistory(query.trim()));
    } catch {
      /* keep current on transient error */
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => { onCountChange?.(orders.length); }, [orders, onCountChange]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) runSearch(); }, [reloadKey]);

  async function openOrder(row: ShippedOrderRow) {
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

  return (
    <div className="fulfill-layout">
      {/* ── List ── */}
      <aside className="fq-pane">
        <div className="search-row" style={{ padding: '8px' }}>
          <input
            type="text"
            inputMode="search"
            placeholder="Search name, SKU, or tracking…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
          />
          <button className="btn-secondary" onClick={runSearch} disabled={searching}>{searching ? '…' : 'Search'}</button>
        </div>
        {orders.length === 0 && <div className="hint fq-empty">{searching ? 'Searching…' : 'No shipped orders.'}</div>}
        <ul className="fq-list">
          {orders.map((o) => (
            <li key={o.sales_id}>
              <button className={`fq-row ${selId === o.sales_id ? 'active' : ''}`} onClick={() => openOrder(o)}>
                <div className="fq-row-top">
                  <span className="fq-headline">{o.customer_name || '—'}</span>
                  <span className="fq-id-sub">{o.sales_id}</span>
                </div>
                <div className="fq-row-bot">
                  {/* SKU codes (not the often-blank tracking) — like the Fulfill rows, helps SKU search. */}
                  <span className="ff-items-skus">{o.item_count} {o.item_count === 1 ? 'item' : 'items'}{o.sku_codes.length ? ` (${o.sku_codes.join(', ')})` : ''}</span>
                  {o.courier_label && <span className="badge ready">{o.courier_label}</span>}
                  <span className="ord-date">{fmtDate(o.ship_date)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Detail (read-only) ── */}
      <main className="fd-pane">
        {!selId && <div className="fd-empty">Pick an order to see what shipped.</div>}
        {error && <div className="validation err">{error}</div>}
        {selId && loadingSummary && <div className="hint">Loading…</div>}
        {selId && !loadingSummary && summary && (
          <>
            <div className="fd-head">
              <div className="fd-title fd-title-plain">{summary.customer_name || '—'}</div>
              <div className="fd-sub">{summary.sales_id}{selRow?.ship_date ? ` · shipped ${fmtDate(selRow.ship_date)}` : ''}</div>
            </div>

            {summary.ship_address && (
              <section className="fd-section">
                <div className="fd-section-head">Shipped to</div>
                <pre className="ob-addr-block">{summary.ship_address}</pre>
              </section>
            )}

            <section className="fd-section">
              <div className="fd-section-head">Shipped items</div>
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
                {summary.lines.length === 0 && <li className="hint">No shipped lines.</li>}
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
  );
}

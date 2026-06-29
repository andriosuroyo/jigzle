'use client';

// Outbound → History tab: the full shipped log, read from outbound_shipments (canonical) via
// getOutboundHistory. Read-only, searchable by name / SKU / courier. Each shipment row carries its own
// detail (CSV/legacy rows have no sales_id to re-fetch by), so the detail pane renders straight from the
// selected row. Past shipments with no box dims are shown as the assumed Custom 1×1×1 box with the real
// weight filled in; ✅ marks barcode-scanned items, ○ manually checked ones.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getOutboundHistory } from '@/app/outbound/actions';
import type { ShipmentHistoryRow, ShipmentHistoryBox } from '@/app/outbound/types';
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
  initialOrders: ShipmentHistoryRow[];
  boxPresets: BoxPreset[];
  onCountChange?: (n: number) => void;
  reloadKey?: number;
}) {
  const [orders, setOrders] = useState<ShipmentHistoryRow[]>(initialOrders);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [selKey, setSelKey] = useState<string | null>(null);
  const reqRef = useRef(0);
  const firstRun = useRef(true); // skip the debounced refetch on mount (initialOrders already loaded)

  const sel = useMemo(() => orders.find((o) => o.key === selKey) ?? null, [orders, selKey]);

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

  useEffect(() => { onCountChange?.(orders.length); }, [orders, onCountChange]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) runSearch(); }, [reloadKey]);
  // live search: re-query as you type (empty = recent), debounced. Skip the mount run — initialOrders
  // is already loaded — so we only refetch once the user types.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => { runSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const courierLine = sel?.courier || null;

  return (
    <div className="fulfill-layout">
      {/* ── List ── */}
      <aside className="fq-pane">
        <div className="search-row" style={{ padding: '8px' }}>
          <input
            type="text"
            inputMode="search"
            placeholder="Search name, SKU, or courier…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {orders.length === 0 && <div className="hint fq-empty">{searching ? 'Searching…' : 'No shipped orders.'}</div>}
        <ul className="fq-list">
          {orders.map((o) => (
            <li key={o.key}>
              <button className={`fq-row ${selKey === o.key ? 'active' : ''}`} onClick={() => setSelKey(o.key)}>
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
      </aside>

      {/* ── Detail (read-only) ── */}
      <main className="fd-pane">
        {!sel && <div className="fd-empty">Pick an order to see what shipped.</div>}
        {sel && (
          <>
            <div className="fd-head">
              <div className="fd-title fd-title-plain">{sel.customer || '—'}</div>
              <div className="fd-sub">shipped {fmtDate(sel.ship_date)}</div>
            </div>

            {sel.address && (
              <section className="fd-section">
                <div className="fd-section-head">Shipped to</div>
                <pre className="ob-addr-block">{sel.address}</pre>
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
                <div className="fd-section-head">Notes</div>
                <pre className="ob-addr-block">{sel.note}</pre>
              </section>
            )}

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
                    return (
                      <li key={i} className="box-sum">
                        <span className="box-idx" aria-label={`Box ${i + 1}`}>{i + 1}</span>
                        <div className="box-sum-main">
                          <span className="box-sum-l1">{boxType(b)} · {dims}</span>
                          <span className="box-sum-l2">real: {b.real_weight != null ? `${b.real_weight} g` : '—'}</span>
                        </div>
                        <span className="ff-qty">{b.chargeable_weight != null ? `${b.chargeable_weight} g` : '—'}</span>
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
                    <span className="ff-qty">{sel.chargeable_g != null ? `${sel.chargeable_g} g` : '—'}</span>
                  </li>
                )}
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

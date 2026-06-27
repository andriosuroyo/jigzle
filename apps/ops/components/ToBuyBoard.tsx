'use client';

// Purchasing → To buy tab. Three lists: Planned (manual), Preorder (from Sales), Sold out. Step 1 is
// read-only and ships the Preorder list (derived from Sales — unfulfilled lines for ≤0-available SKUs);
// Planned and Sold out are placeholders until the migration that adds their PO states lands.

import { useMemo } from 'react';
import type { PreorderRow } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');

export default function ToBuyBoard({ preorders }: { preorders: PreorderRow[] }) {
  const imgCodes = useMemo(
    () => preorders.map((p) => p.item_code).filter((c): c is string => !!c),
    [preorders]
  );
  const imgMap = useSkuImages(imgCodes);

  return (
    <div className="purch-tobuy">
      {/* Planned — manual adds (needs the migration: PO status 'Planned' + product link) */}
      <section className="fd-section">
        <div className="fd-section-head">Planned</div>
        <div className="hint">Manual buy-list. The “+ add item” flow (search + qty + product link, with live forwarder / shipped / available figures) lands with the next update.</div>
      </section>

      {/* Preorder — derived from Sales (live) */}
      <section className="fd-section">
        <div className="fd-section-head">Preorder · from Sales ({preorders.length})</div>
        {preorders.length === 0 && <div className="hint">No preorders — every ordered SKU is in stock.</div>}
        <ul className="ff-lines">
          {preorders.map((p) => (
            <li key={p.line_id} className="ff-line pend-line">
              <SkuImage status={imgMap[p.item_code ?? '']?.status} displayUrl={imgMap[p.item_code ?? '']?.displayUrl} name={p.name} size={SKU_IMG.sm} />
              <div className="pend-line-main">
                <span className="ff-code">{p.item_code || '—'}</span>
                <span className="ff-name">{p.name}</span>
                <span className="hint">{p.sales_id} · {p.customer_name || 'no customer'} · {fmtDate(p.order_date)}</span>
              </div>
              <span className="ff-qty">×{p.qty}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Sold out — needs the migration: PO state 'Sold out' + sold_out_date */}
      <section className="fd-section">
        <div className="fd-section-head">Sold out</div>
        <div className="hint">Items that can’t be purchased right now. Marking sold-out (auto-dated, with an optional reason) lands with the next update.</div>
      </section>
    </div>
  );
}

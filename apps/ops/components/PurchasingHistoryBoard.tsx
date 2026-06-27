'use client';

// Purchasing → History tab. Two sub-lists so shipment-level data isn't duplicated across item rows:
//  • Per shipment — one row per completed shipment (receive date, tracking, SKU count).
//  • Per item — one row per Received PO line (keeps per-item cost / shipID / supplier).
// Read-only; each sub-list owns its search.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getReceivedItems, getShipmentHistory } from '@/app/purchasing/actions';
import type { ReceivedItemRow, ShipmentHistoryRow } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');

export default function PurchasingHistoryBoard({
  initialItems,
  initialShipments,
}: {
  initialItems: ReceivedItemRow[];
  initialShipments: ShipmentHistoryRow[];
}) {
  const [sub, setSub] = useState<'shipment' | 'item'>('shipment');
  const [items, setItems] = useState<ReceivedItemRow[]>(initialItems);
  const [ships, setShips] = useState<ShipmentHistoryRow[]>(initialShipments);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const reqRef = useRef(0);

  const imgCodes = useMemo(
    () => (sub === 'item' ? items.map((i) => i.item_code).filter((c): c is string => !!c) : []),
    [sub, items]
  );
  const imgMap = useSkuImages(imgCodes);

  async function runSearch() {
    setSearching(true);
    const myReq = ++reqRef.current;
    try {
      if (sub === 'item') {
        const r = await getReceivedItems(query.trim());
        if (reqRef.current === myReq) setItems(r);
      } else {
        const r = await getShipmentHistory(query.trim());
        if (reqRef.current === myReq) setShips(r);
      }
    } catch {
      /* keep current on transient error */
    } finally {
      if (reqRef.current === myReq) setSearching(false);
    }
  }

  // clear the field when flipping sub-lists (their result sets are independent)
  useEffect(() => { setQuery(''); }, [sub]);

  return (
    <div className="purch-history">
      <div className="purch-subtabs">
        <button className={`purch-subtab ${sub === 'shipment' ? 'active' : ''}`} onClick={() => setSub('shipment')}>Per shipment</button>
        <button className={`purch-subtab ${sub === 'item' ? 'active' : ''}`} onClick={() => setSub('item')}>Per item</button>
      </div>

      <div className="search-row" style={{ padding: '8px 0' }}>
        <input
          type="text"
          inputMode="search"
          placeholder={sub === 'item' ? 'Search SKU, name, or ship id…' : 'Search ship id…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
        />
        <button className="btn-secondary" onClick={runSearch} disabled={searching}>{searching ? '…' : 'Search'}</button>
      </div>

      {sub === 'shipment' ? (
        <ul className="ff-lines">
          {ships.length === 0 && <li className="hint fq-empty">{searching ? 'Searching…' : 'No completed shipments.'}</li>}
          {ships.map((s) => (
            <li key={s.ship_id} className="ff-line">
              <div className="fq-row-top">
                <span className="fq-id">{s.ship_id}</span>
                <span className="fq-id-sub">received {fmtDate(s.received_date)}</span>
              </div>
              <div className="fq-row-bot">
                <span className="ff-items-skus">
                  {s.item_count} {s.item_count === 1 ? 'SKU' : 'SKUs'}
                  {s.total_cost != null ? ` · cost ${s.total_cost}` : ''}
                  {s.suppliers.length ? ` · ${s.suppliers.join(', ')}` : ''}
                  {s.forwarder_prefix ? ` · ${s.forwarder_prefix}` : ''}
                  {s.tracking ? ` · ${s.tracking}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="ff-lines">
          {items.length === 0 && <li className="hint fq-empty">{searching ? 'Searching…' : 'No received items.'}</li>}
          {items.map((it) => (
            <li key={it.po_id} className="ff-line pend-line">
              <SkuImage status={imgMap[it.item_code ?? '']?.status} displayUrl={imgMap[it.item_code ?? '']?.displayUrl} name={it.name} size={SKU_IMG.sm} />
              <div className="pend-line-main">
                <span className="ff-code">{it.item_code || '—'}</span>
                <span className="ff-name">{it.name}</span>
                <span className="hint">
                  {it.ship_id ? `ship ${it.ship_id}` : 'no ship id'}
                  {it.item_cost != null ? ` · cost ${it.item_cost}` : ''}
                  {it.supplier_name ? ` · ${it.supplier_name}` : ''}
                  {it.receive_date ? ` · ${fmtDate(it.receive_date)}` : ''}
                  {it.product_link ? <> · <a href={it.product_link} target="_blank" rel="noreferrer" className="btn-link">link ↗</a></> : null}
                </span>
              </div>
              <span className="ff-qty">×{it.qty}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

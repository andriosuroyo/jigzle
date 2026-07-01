'use client';

// Purchasing → History tab. Two sub-lists (Sales-Pending style tabs with counts):
//  • Per shipment — one quickview card per completed shipment; tap to see all its SKUs.
//  • Per item — one row per Received PO line (per-item cost / shipID).
// "Received" (and the date) comes from the inbound ledger, not just shipments.received_date, so a
// shipment booked into inbound reads as received with its real date even if the ledger row was blank.
// Read-only; each sub-list owns its search.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getReceivedItems, getShipmentHistory, getShipmentItems } from '@/app/purchasing/actions';
import type { ReceivedItemRow, ShipmentHistoryRow, ShipmentItemRow } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');
// shipped until the ship_id is received in inbound (received_date set) → then received
const shipDateLabel = (s: { received_date: string | null; ship_date: string | null }): string =>
  s.received_date ? `received ${fmtDate(s.received_date)}` : `shipped ${fmtDate(s.ship_date)}`;

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
  const firstRun = useRef(true); // skip the debounced refetch on mount (initial data already loaded)

  // shipment detail (per-shipment tab): the selected shipment + its SKU lines
  const [openShip, setOpenShip] = useState<ShipmentHistoryRow | null>(null);
  const [shipItems, setShipItems] = useState<ShipmentItemRow[]>([]);
  const [shipItemsLoading, setShipItemsLoading] = useState(false);

  const imgCodes = useMemo(() => {
    if (openShip) return shipItems.map((i) => i.item_code).filter((c): c is string => !!c);
    return sub === 'item' ? items.map((i) => i.item_code).filter((c): c is string => !!c) : [];
  }, [sub, items, openShip, shipItems]);
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

  // clear the field + any open detail when flipping sub-lists (their result sets are independent)
  useEffect(() => { setQuery(''); setOpenShip(null); }, [sub]);
  // live search: re-query as you type, debounced. Skip the mount run — initial data already loaded.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => { runSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sub]);

  async function selectShip(s: ShipmentHistoryRow) {
    setOpenShip(s);
    setShipItems([]);
    setShipItemsLoading(true);
    try {
      setShipItems(await getShipmentItems(s.ship_id));
    } catch {
      setShipItems([]);
    } finally {
      setShipItemsLoading(false);
    }
  }

  const TABS: { key: 'shipment' | 'item'; label: string; count: number }[] = [
    { key: 'shipment', label: 'Per shipment', count: ships.length },
    { key: 'item', label: 'Per item', count: items.length },
  ];

  // ── shipment detail: back + header + every SKU in the shipment ──
  if (openShip) {
    return (
      <div className="purch-history">
        <button className="btn-link" onClick={() => setOpenShip(null)}>← back to shipments</button>
        <div className="fd-head">
          <div className="fd-title">{openShip.ship_id}</div>
          <div className="fd-sub">
            {shipDateLabel(openShip)} · {openShip.item_count} {openShip.item_count === 1 ? 'SKU' : 'SKUs'}
            {openShip.total_cost != null ? ` · cost ${openShip.total_cost}` : ''}
          </div>
        </div>
        {shipItemsLoading && <div className="hint">Loading items…</div>}
        {!shipItemsLoading && shipItems.length === 0 && <div className="hint">No item lines on this shipment.</div>}
        <ul className="po-cards po-cards-compact">
          {shipItems.map((it) => (
            <li key={it.po_id}>
              <div className="po-card">
                <SkuImage status={imgMap[it.item_code ?? '']?.status} displayUrl={imgMap[it.item_code ?? '']?.displayUrl} name={it.name} size={SKU_IMG.sm} />
                <div className="po-card-main">
                  <div className="po-card-l1">
                    <span className="ff-code">{it.item_code || '—'}</span>
                    {it.item_cost != null && <span className="po-card-poid">cost {it.item_cost}</span>}
                  </div>
                  <div className="po-card-l2"><span className="ff-name">{it.name}</span><span className="po-card-qty">×{it.qty}</span></div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="purch-history">
      {/* Sales-Pending style tabs with live counts */}
      <div className="fq-filters" role="tablist" aria-label="History">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={sub === t.key}
            className={`fq-filter ${sub === t.key ? 'active' : ''}`}
            onClick={() => setSub(t.key)}
          >
            {t.label}<span className="fq-filter-count">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="search-row" style={{ padding: '8px 0' }}>
        <input
          type="text"
          inputMode="search"
          placeholder={sub === 'item' ? 'Search SKU, name, or ship id…' : 'Search ship id…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {sub === 'shipment' ? (
        <ul className="po-cards po-cards-compact">
          {ships.length === 0 && <li className="hint fq-empty">{searching ? 'Searching…' : 'No completed shipments.'}</li>}
          {ships.map((s) => (
            <li key={s.ship_id}>
              <button className="po-card po-card-btn" style={{ width: '100%' }} onClick={() => selectShip(s)}>
                <div className="po-card-main">
                  <div className="po-card-l1">
                    <span className="ff-code">{s.ship_id}</span>
                    <span className="po-card-poid">{shipDateLabel(s)}</span>
                  </div>
                  <div className="po-card-l2 hint">
                    {s.item_count} {s.item_count === 1 ? 'SKU' : 'SKUs'}
                    {s.total_cost != null ? ` · cost ${s.total_cost}` : ''}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="po-cards po-cards-compact">
          {items.length === 0 && <li className="hint fq-empty">{searching ? 'Searching…' : 'No received items.'}</li>}
          {items.map((it) => (
            <li key={it.po_id}>
              <div className="po-card">
                <SkuImage status={imgMap[it.item_code ?? '']?.status} displayUrl={imgMap[it.item_code ?? '']?.displayUrl} name={it.name} size={SKU_IMG.sm} />
                <div className="po-card-main">
                  <div className="po-card-l1">
                    <span className="ff-code">{it.item_code || '—'}</span>
                    <span className="po-card-poid">{fmtDate(it.receive_date || it.ship_date)}</span>
                  </div>
                  <div className="po-card-l2"><span className="ff-name">{it.name}</span><span className="po-card-qty">×{it.qty}</span></div>
                  <div className="po-card-l2 hint">
                    {it.ship_id ? `ship ${it.ship_id}` : 'no ship id'}
                    {it.item_cost != null ? ` · cost ${it.item_cost}` : ''}
                    {it.product_link ? <> · <a href={it.product_link} target="_blank" rel="noreferrer" className="btn-link">link ↗</a></> : null}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

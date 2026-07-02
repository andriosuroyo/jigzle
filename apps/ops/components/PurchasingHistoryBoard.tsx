'use client';

// Purchasing → History tab. Two sub-lists (Sales-Pending style tabs with counts):
//  • Active    — ship_ids not yet received (open shipments, e.g. SUB 189/191/192). Date = shipped date.
//  • Completed — received ship_ids (completed shipments). Date = received date. Uncapped (shows all).
// One quickview card per shipment; tap to see its items. The search bar matches ship_id OR any SKU in
// the shipment, so searching a SKU surfaces which ship_ids contain it. Read-only.

import { useEffect, useMemo, useState } from 'react';
import { getShipmentItems } from '@/app/purchasing/actions';
import type { ShipmentHistoryRow, ShipmentItemRow } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');
// Active = shipped date; Completed = received date.
const dateLabel = (s: ShipmentHistoryRow): string =>
  s.completed ? `received ${fmtDate(s.received_date || s.ship_date)}` : `shipped ${fmtDate(s.ship_date)}`;
const fmtCost = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const costLabel = (s: { total_cost: number | null; currency_symbol: string | null }): string | null =>
  s.total_cost == null ? null : `Total Cost: ${s.currency_symbol ?? ''}${fmtCost(s.total_cost)}`;

export default function PurchasingHistoryBoard({
  initialShipments,
}: {
  initialShipments: ShipmentHistoryRow[];
}) {
  const [sub, setSub] = useState<'active' | 'completed'>('active');
  const [ships] = useState<ShipmentHistoryRow[]>(initialShipments);
  const [query, setQuery] = useState('');

  // shipment detail: the selected shipment + its item lines
  const [openShip, setOpenShip] = useState<ShipmentHistoryRow | null>(null);
  const [shipItems, setShipItems] = useState<ShipmentItemRow[]>([]);
  const [shipItemsLoading, setShipItemsLoading] = useState(false);

  const imgCodes = useMemo(
    () => (openShip ? shipItems.map((i) => i.item_code).filter((c): c is string => !!c) : []),
    [openShip, shipItems]
  );
  const imgMap = useSkuImages(imgCodes);

  // client-side filter over the loaded set: match ship_id OR any SKU in the shipment (so a SKU search
  // shows which ship_ids contain it). Then split into the active/completed tab.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ships.filter((s) => {
      if (s.completed !== (sub === 'completed')) return false;
      if (!q) return true;
      return s.ship_id.toLowerCase().includes(q) || s.sku_codes.some((c) => c.toLowerCase().includes(q));
    });
  }, [ships, sub, query]);

  const counts = useMemo(() => ({
    active: ships.filter((s) => !s.completed).length,
    completed: ships.filter((s) => s.completed).length,
  }), [ships]);

  // clear any open detail when flipping sub-lists
  useEffect(() => { setOpenShip(null); }, [sub]);

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

  const TABS: { key: 'active' | 'completed'; label: string; count: number }[] = [
    { key: 'active', label: 'Active', count: counts.active },
    { key: 'completed', label: 'Completed', count: counts.completed },
  ];

  // ── shipment detail: back + header + every item in the shipment ──
  if (openShip) {
    const cost = costLabel(openShip);
    return (
      <div className="purch-history">
        <button className="btn-link" onClick={() => setOpenShip(null)}>← back to shipments</button>
        <div className="fd-head">
          <div className="fd-title">{openShip.ship_id}</div>
          <div className="fd-sub">
            {dateLabel(openShip)} · {openShip.item_count} {openShip.item_count === 1 ? 'item' : 'items'}
            {cost ? ` · ${cost}` : ''}
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
          placeholder="Search ship id or SKU…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <ul className="po-cards po-cards-compact">
        {visible.length === 0 && (
          <li className="hint fq-empty">{sub === 'active' ? 'No active shipments.' : 'No completed shipments.'}</li>
        )}
        {visible.map((s) => {
          const cost = costLabel(s);
          return (
            <li key={s.ship_id}>
              <button className="po-card po-card-btn" style={{ width: '100%' }} onClick={() => selectShip(s)}>
                <div className="po-card-main">
                  <div className="po-card-l1">
                    <span className="ff-code">{s.ship_id}</span>
                    <span className="po-card-poid">{dateLabel(s)}</span>
                  </div>
                  <div className="po-card-l2 hint">
                    {s.item_count} {s.item_count === 1 ? 'item' : 'items'}
                    {cost ? ` · ${cost}` : ''}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

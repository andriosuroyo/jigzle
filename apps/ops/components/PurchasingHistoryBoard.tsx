'use client';

// Purchasing → History tab. Two sub-lists (Sales-Pending style tabs with counts):
//  • Active    — ship_ids not yet received (open shipments, e.g. SUB 189/191/192). Date = shipped date.
//  • Completed — received ship_ids (completed shipments). Date = received date. Uncapped (shows all).
// One quickview card per shipment; tap to see its items. The search bar matches ship_id OR any SKU in
// the shipment, so searching a SKU surfaces which ship_ids contain it. Read-only.

import { useEffect, useMemo, useState } from 'react';
import { getShipmentItems, setShipmentNote } from '@/app/purchasing/actions';
import type { ShipmentHistoryRow, ShipmentItemRow } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');
// Active = shipped date; Completed = received date.
const dateLabel = (s: ShipmentHistoryRow): string =>
  s.completed ? `received ${fmtDate(s.received_date || s.ship_date)}` : `shipped ${fmtDate(s.ship_date)}`;
const fmtCost = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const costLabel = (s: { total_cost: number | null; currency: string | null }): string | null =>
  s.total_cost == null ? null : `Total Cost: ${fmtCost(s.total_cost)}${s.currency ? ` ${s.currency}` : ''}`;

export default function PurchasingHistoryBoard({
  initialShipments,
}: {
  initialShipments: ShipmentHistoryRow[];
}) {
  const [sub, setSub] = useState<'active' | 'completed'>('active');
  const [ships, setShips] = useState<ShipmentHistoryRow[]>(initialShipments);
  const [query, setQuery] = useState('');

  // shipment detail: the selected shipment + its item lines
  const [openShip, setOpenShip] = useState<ShipmentHistoryRow | null>(null);
  const [shipItems, setShipItems] = useState<ShipmentItemRow[]>([]);
  const [shipItemsLoading, setShipItemsLoading] = useState(false);
  // shipment-note editor (detail view)
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);

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
    setEditingNote(false);
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

  // save the per-Ship-ID note from the detail view (works even when starting empty).
  async function saveNote() {
    if (!openShip) return;
    setSavingNote(true);
    try {
      await setShipmentNote(openShip.ship_id, noteDraft);
      const v = noteDraft.trim() || null;
      setShips((prev) => prev.map((s) => (s.ship_id === openShip.ship_id ? { ...s, note: v } : s)));
      setOpenShip((prev) => (prev ? { ...prev, note: v } : prev));
      setEditingNote(false);
    } catch {
      /* keep the editor open on a transient error */
    } finally {
      setSavingNote(false);
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
        <button className="btn-link" onClick={() => setOpenShip(null)}>← back</button>
        <div className="fd-head">
          <div className="fd-title">{openShip.ship_id}</div>
          <div className="fd-sub">
            {dateLabel(openShip)} · {openShip.item_count} {openShip.item_count === 1 ? 'item' : 'items'}
            {cost ? ` · ${cost}` : ''}
          </div>
        </div>

        {/* Items */}
        <section className="fd-section">
          <div className="fd-section-head">Items</div>
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
                      {it.item_cost != null && <span className="po-card-poid">each {it.item_cost}{it.currency ? ` ${it.currency}` : ''}</span>}
                    </div>
                    <div className="po-card-l2"><span className="ff-name">{it.name}</span><span className="po-card-qty">×{it.qty}</span></div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Shipment notes — under the items list; editable here (add or change), also shown on Inbound. */}
        <section className="fd-section">
          <div className="fd-section-head fd-section-head-row">
            <span>Shipment notes</span>
            {!editingNote && (
              <button className="btn-link" onClick={() => { setNoteDraft(openShip.note ?? ''); setEditingNote(true); }}>Edit note</button>
            )}
          </div>
          {editingNote ? (
            <div className="ship-note-edit">
              <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Note for this Ship ID — shown on Inbound receiving" rows={3} disabled={savingNote} autoFocus />
              <div className="subform-actions">
                <button className="btn-link" onClick={() => setEditingNote(false)} disabled={savingNote}>Cancel</button>
                <button className="btn-secondary" onClick={saveNote} disabled={savingNote}>{savingNote ? 'Saving…' : 'Save note'}</button>
              </div>
            </div>
          ) : (
            <div className={openShip.note ? 'ship-note-text' : 'hint'}>{openShip.note || 'No note yet.'}</div>
          )}
        </section>
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

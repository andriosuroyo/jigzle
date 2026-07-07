'use client';

// Purchasing → History tab. Two sub-lists (Sales-Pending style tabs with counts):
//  • Active    — ship_ids not yet received (open shipments, e.g. SUB 189/191/192). Date = shipped date.
//  • Completed — received ship_ids (completed shipments). Date = received date. Uncapped (shows all).
// One quickview card per shipment; tap to see its items. The search bar matches ship_id OR any SKU in
// the shipment, so searching a SKU surfaces which ship_ids contain it. Read-only.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getShipmentHistory, getShipmentItems, setShipmentNote, setShipmentCourier, getShipmentBoxes, setShipmentBoxes } from '@/app/purchasing/actions';
import type { ShipmentHistoryRow, ShipmentItemRow, ShipmentBox } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import SearchInput from '@/components/SearchInput';

// PR206: box editor draft rows (string inputs) ⇄ ShipmentBox (numbers/null).
type BoxDraft = { p: string; l: string; t: string; w: string; tracking: string };
const emptyBoxDraft = (): BoxDraft => ({ p: '', l: '', t: '', w: '', tracking: '' });
const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));
const boxToDraft = (b: ShipmentBox): BoxDraft => ({ p: b.dim_p?.toString() ?? '', l: b.dim_l?.toString() ?? '', t: b.dim_t?.toString() ?? '', w: b.real_weight?.toString() ?? '', tracking: b.tracking ?? '' });
const draftToBox = (d: BoxDraft): ShipmentBox => ({ dim_p: numOrNull(d.p), dim_l: numOrNull(d.l), dim_t: numOrNull(d.t), real_weight: numOrNull(d.w), tracking: d.tracking.trim() || null });

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');
// Active = shipped date; Completed = received date.
const dateLabel = (s: ShipmentHistoryRow): string =>
  s.completed ? `received ${fmtDate(s.received_date || s.ship_date)}` : `shipped ${fmtDate(s.ship_date)}`;
const fmtCost = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const costLabel = (s: { total_cost: number | null; currency: string | null }): string | null =>
  s.total_cost == null ? null : `Total Cost: ${fmtCost(s.total_cost)}${s.currency ? ` ${s.currency}` : ''}`;

export default function PurchasingHistoryBoard({
  initialShipments,
  shipmentCouriers = [],
  active = true,
  onDetailOpenChange,
}: {
  initialShipments: ShipmentHistoryRow[];
  // 0056 — the Settings-managed international courier pick-list (DHL, FedEx, MTE…)
  shipmentCouriers?: string[];
  // PR181: whether the History tab is on screen. The shell no longer preloads the shipment history (a
  // paged PO scan + subqueries); we fetch it once the first time this turns true, so Purchasing opens
  // fast on To forwarder.
  active?: boolean;
  // PR153: the shell hides the pipeline tabs while a shipment detail is open (breadcrumb stays)
  onDetailOpenChange?: (open: boolean) => void;
}) {
  const [sub, setSub] = useState<'active' | 'completed'>('active');
  const [ships, setShips] = useState<ShipmentHistoryRow[]>(initialShipments);
  const [query, setQuery] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const loadedRef = useRef(initialShipments.length > 0); // PR181: false until the deferred first load lands

  // shipment detail: the selected shipment + its item lines
  const [openShip, setOpenShip] = useState<ShipmentHistoryRow | null>(null);
  const [shipItems, setShipItems] = useState<ShipmentItemRow[]>([]);
  const [shipItemsLoading, setShipItemsLoading] = useState(false);
  // shipment-note editor (detail view)
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  // PR153: shipment courier + tracking drafts (auto-save; shared quickview shows "DHL 012456789")
  const [courierDraft, setCourierDraft] = useState('');
  const [trackingDraft, setTrackingDraft] = useState('');
  const [courierErr, setCourierErr] = useState<string | null>(null);
  // PR206 (0069): per-box dims/weight/tracking drafts (saved as a set; pre-fill the CN Packing List)
  const [boxDraft, setBoxDraft] = useState<BoxDraft[]>([]);
  const [savingBoxes, setSavingBoxes] = useState(false);
  const [boxErr, setBoxErr] = useState<string | null>(null);
  const [boxSaved, setBoxSaved] = useState(false);

  // PR153: tell the shell when a detail is open (it hides the pipeline tabs, keeps the breadcrumb)
  useEffect(() => { onDetailOpenChange?.(!!openShip); }, [openShip, onDetailOpenChange]);

  const imgCodes = useMemo(
    () => (openShip ? shipItems.map((i) => i.item_code).filter((c): c is string => !!c) : []),
    [openShip, shipItems]
  );
  const imgMap = useSkuImages(imgCodes);

  // client-side filter over the loaded set: match ship_id, any SKU code, OR any item name in the
  // shipment (PR153). Then split into the active/completed tab.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ships.filter((s) => {
      if (s.completed !== (sub === 'completed')) return false;
      if (!q) return true;
      return (
        s.ship_id.toLowerCase().includes(q) ||
        s.sku_codes.some((c) => c.toLowerCase().includes(q)) ||
        s.sku_names.some((n) => n.toLowerCase().includes(q))
      );
    });
  }, [ships, sub, query]);

  const counts = useMemo(() => ({
    active: ships.filter((s) => !s.completed).length,
    completed: ships.filter((s) => s.completed).length,
  }), [ships]);

  // clear any open detail when flipping sub-lists
  useEffect(() => { setOpenShip(null); }, [sub]);

  // PR181: deferred first load — fetch the full shipment history the first time the History tab is
  // shown (search + active/completed split stay client-side over this loaded set, as before).
  async function loadHistory() {
    setLoadingHistory(true);
    loadedRef.current = true;
    try {
      const rows = await getShipmentHistory('');
      setShips(rows);
    } catch {
      /* keep current on transient error */
    } finally {
      setLoadingHistory(false);
    }
  }
  useEffect(() => {
    if (active && !loadedRef.current) loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function selectShip(s: ShipmentHistoryRow) {
    setOpenShip(s);
    setEditingNote(false);
    setCourierDraft(s.courier ?? '');
    setTrackingDraft(s.tracking ?? '');
    setCourierErr(null);
    setBoxErr(null);
    setBoxSaved(false);
    setBoxDraft([]);
    setShipItems([]);
    setShipItemsLoading(true);
    getShipmentBoxes(s.ship_id).then((rows) => setBoxDraft(rows.length ? rows.map(boxToDraft) : [emptyBoxDraft()])).catch(() => setBoxDraft([emptyBoxDraft()]));
    try {
      setShipItems(await getShipmentItems(s.ship_id));
    } catch {
      setShipItems([]);
    } finally {
      setShipItemsLoading(false);
    }
  }

  // PR206: save the whole box set for the open shipment (replaces existing rows).
  async function saveBoxes() {
    if (!openShip) return;
    setSavingBoxes(true); setBoxErr(null); setBoxSaved(false);
    const { error } = await setShipmentBoxes(openShip.ship_id, boxDraft.map(draftToBox));
    setSavingBoxes(false);
    if (error) { setBoxErr(error); return; }
    setBoxSaved(true);
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

  // PR153: persist courier + tracking together (select saves on change, tracking on blur).
  async function saveCourier(courier: string, tracking: string) {
    if (!openShip) return;
    setCourierErr(null);
    const { error } = await setShipmentCourier(openShip.ship_id, courier, tracking);
    if (error) { setCourierErr(error); return; }
    const c = courier.trim() || null;
    const t = tracking.trim() || null;
    setShips((prev) => prev.map((s) => (s.ship_id === openShip.ship_id ? { ...s, courier: c, tracking: t } : s)));
    setOpenShip((prev) => (prev ? { ...prev, courier: c, tracking: t } : prev));
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

        {/* Shipment courier & tracking (PR153) — the international carrier, one line, above Items.
            The pick-list is Settings → Purchasing → Shipment couriers; quickview shows "DHL 0124…". */}
        <section className="fd-section">
          <div className="fd-section-head">Shipment courier &amp; tracking <em className="panel-opt">(optional)</em></div>
          {courierErr && <div className="validation err">{courierErr}</div>}
          <div className="po-inline2">
            <select
              value={courierDraft}
              onChange={(e) => { setCourierDraft(e.target.value); void saveCourier(e.target.value, trackingDraft); }}
            >
              <option value="">— courier —</option>
              {shipmentCouriers.map((c) => <option key={c} value={c}>{c}</option>)}
              {courierDraft && !shipmentCouriers.includes(courierDraft) && <option value={courierDraft}>{courierDraft}</option>}
            </select>
            <input
              type="text"
              placeholder="tracking number"
              value={trackingDraft}
              onChange={(e) => setTrackingDraft(e.target.value)}
              onBlur={(e) => void saveCourier(courierDraft, e.target.value)}
            />
          </div>
        </section>

        {/* PR206: box dimensions / weight / China tracking — pre-fills the Doc Generator CN Packing
            List for this ship_id. Optional; degrades to a no-op until migration 0069 is applied. */}
        <section className="fd-section">
          <div className="fd-section-head">Boxes — dimensions &amp; tracking <em className="panel-opt">(optional)</em></div>
          {boxErr && <div className="validation err">{boxErr}</div>}
          <div className="sb-grid sb-grid-head">
            <span>L (cm)</span><span>W (cm)</span><span>H (cm)</span><span>Real wt (kg)</span><span>Box tracking</span><span />
          </div>
          {boxDraft.map((b, i) => (
            <div className="sb-grid" key={i}>
              <input type="text" inputMode="decimal" value={b.p} onChange={(e) => setBoxDraft((prev) => prev.map((r, j) => (j === i ? { ...r, p: e.target.value } : r)))} />
              <input type="text" inputMode="decimal" value={b.l} onChange={(e) => setBoxDraft((prev) => prev.map((r, j) => (j === i ? { ...r, l: e.target.value } : r)))} />
              <input type="text" inputMode="decimal" value={b.t} onChange={(e) => setBoxDraft((prev) => prev.map((r, j) => (j === i ? { ...r, t: e.target.value } : r)))} />
              <input type="text" inputMode="decimal" value={b.w} onChange={(e) => setBoxDraft((prev) => prev.map((r, j) => (j === i ? { ...r, w: e.target.value } : r)))} />
              <input type="text" value={b.tracking} placeholder="ZTO …" onChange={(e) => setBoxDraft((prev) => prev.map((r, j) => (j === i ? { ...r, tracking: e.target.value } : r)))} />
              <button className="set-del" aria-label="Remove box" onClick={() => setBoxDraft((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))}>✕</button>
            </div>
          ))}
          <div className="po-inline2" style={{ marginTop: 6, gap: 8 }}>
            <button className="btn-link" onClick={() => setBoxDraft((prev) => [...prev, emptyBoxDraft()])}>+ Add box</button>
            <button className="btn-secondary" onClick={saveBoxes} disabled={savingBoxes}>{savingBoxes ? 'Saving…' : 'Save boxes'}</button>
            {boxSaved && <span className="hint" style={{ alignSelf: 'center' }}>Saved.</span>}
          </div>
        </section>

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
        <SearchInput value={query} onChange={setQuery} placeholder="Search by SKU or item name" />
      </div>

      <ul className="po-cards po-cards-compact">
        {visible.length === 0 && (
          <li className="hint fq-empty">{loadingHistory ? 'Loading history…' : sub === 'active' ? 'No active shipments.' : 'No completed shipments.'}</li>
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
                  {/* PR153: courier + tracking combined ("DHL 012456789") on the right, under the date */}
                  <div className="po-card-l1 po-card-mid">
                    <span className="ff-name hint">
                      {s.item_count} {s.item_count === 1 ? 'item' : 'items'}
                      {cost ? ` · ${cost}` : ''}
                    </span>
                    {(s.courier || s.tracking) && (
                      <span className="po-card-cust">{[s.courier, s.tracking].filter(Boolean).join(' ')}</span>
                    )}
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

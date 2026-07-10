'use client';

// Purchasing → History tab. Two sub-lists (Sales-Pending style tabs with counts):
//  • Active    — ship_ids not yet received (open shipments, e.g. SUB 189/191/192). Date = shipped date.
//  • Completed — received ship_ids (completed shipments). Date = received date. Uncapped (shows all).
// One quickview card per shipment; tap to see its items. The search bar matches ship_id OR any SKU in
// the shipment, so searching a SKU surfaces which ship_ids contain it. Read-only.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getShipmentHistory, getShipmentItems, setShipmentNote, setShipmentCourier, getShipmentBoxes, setShipmentBoxes, deleteShipment, updateShipmentPO, sendPoBackToShip } from '@/app/purchasing/actions';
import type { ShipmentHistoryRow, ShipmentItemRow, ShipmentBox } from '@/app/purchasing/types';
import type { Supplier } from '@jigzle/db/types';
import SkuImage from '@/components/SkuImage';
import { isRealName } from '@/components/skuName';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import SearchInput from '@/components/SearchInput';

// PR206/PR261: box editor draft rows (string inputs) ⇄ ShipmentBox (numbers/null). real_weight is kg
// (the CN Packing List reads kg). PR261 adds a per-box local courier alongside the tracking number.
type BoxDraft = { p: string; l: string; t: string; w: string; courier: string; tracking: string };
const emptyBoxDraft = (): BoxDraft => ({ p: '', l: '', t: '', w: '', courier: '', tracking: '' });
const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));
const boxToDraft = (b: ShipmentBox): BoxDraft => ({ p: b.dim_p?.toString() ?? '', l: b.dim_l?.toString() ?? '', t: b.dim_t?.toString() ?? '', w: b.real_weight?.toString() ?? '', courier: b.courier ?? '', tracking: b.tracking ?? '' });
const draftToBox = (d: BoxDraft): ShipmentBox => ({ dim_p: numOrNull(d.p), dim_l: numOrNull(d.l), dim_t: numOrNull(d.t), real_weight: numOrNull(d.w), courier: d.courier.trim() || null, tracking: d.tracking.trim() || null });

// action-button icons (edit / delete), matching the To-buy detail style.
const _ic = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, width: 16, height: 16, 'aria-hidden': true };
const PencilIcon = () => (<svg {..._ic}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);
const TrashIcon = () => (<svg {..._ic}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>);
// PR267 — "send back" return arrow (arrow-uturn-left) for the Send-back-to-Ship action.
const BackIcon = () => (<svg {..._ic}><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></svg>);

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');
// one saved box rendered read-only (view mode): "40 × 30 × 25 cm · 12.5 kg · ZTO ZTO123"
const boxSummary = (b: ShipmentBox): string => {
  const dims = [b.dim_p, b.dim_l, b.dim_t];
  const parts: string[] = [];
  if (dims.some((d) => d != null)) parts.push(`${dims.map((d) => (d ?? '–')).join(' × ')} cm`);
  if (b.real_weight != null) parts.push(`${b.real_weight} kg`);
  const ct = [b.courier, b.tracking].filter(Boolean).join(' ');
  if (ct) parts.push(ct);
  return parts.join(' · ') || '—';
};
// PR261 — compact currency: the yuan symbol 元 for "yuan", else the currency word (space-prefixed).
const ccyTag = (ccy: string | null | undefined): string => (ccy ? (ccy.trim().toLowerCase() === 'yuan' ? '元' : ` ${ccy}`) : '');
// PR266 — currency SYMBOL for the cost-input prefix (front, like $10 / ¥100). Yuan → 元; else the word.
const ccySymbol = (ccy: string | null | undefined): string => (ccy ? (ccy.trim().toLowerCase() === 'yuan' ? '元' : ccy) : '');
// PR267 — supplier-country → currency symbol, so the cost prefix follows the picked Supplier (CN 元,
// JP ¥, US $, …). Falls back to the line's stored currency symbol when the country is unknown.
const CCY_BY_COUNTRY: Record<string, string> = {
  china: '元', japan: '¥', taiwan: 'NT$', 'hong kong': 'HK$', korea: '₩', 'south korea': '₩',
  singapore: 'S$', thailand: '฿', malaysia: 'RM', indonesia: 'Rp', 'united states': '$', usa: '$', 'united kingdom': '£', uk: '£',
};
const symbolForCountry = (country: string | null | undefined): string => (country ? (CCY_BY_COUNTRY[country.trim().toLowerCase()] ?? '') : '');
// Active = shipped date; Completed = received date.
const dateLabel = (s: ShipmentHistoryRow): string =>
  s.completed ? `received ${fmtDate(s.received_date || s.ship_date)}` : `shipped ${fmtDate(s.ship_date)}`;
const fmtCost = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
// quickview card cost label (list view) — kept as "Total Cost" is only used in the list, not the detail.
const costLabel = (s: { total_cost: number | null; currency: string | null }): string | null =>
  s.total_cost == null ? null : `Total Cost: ${fmtCost(s.total_cost)}${ccyTag(s.currency)}`;
const costText = (total: number | null, ccy: string | null): string | null =>
  total == null ? null : `${fmtCost(total)}${ccyTag(ccy)}`;

export default function PurchasingHistoryBoard({
  initialShipments,
  shipmentCouriers = [],
  suppliers = [],
  localCouriers = [],
  active = true,
  onDetailOpenChange,
}: {
  initialShipments: ShipmentHistoryRow[];
  // 0056 — the Settings-managed international courier pick-list (DHL, FedEx, MTE…)
  shipmentCouriers?: string[];
  // PR255 — suppliers + local-courier suggestions, for the per-item detail overlay's editable fields.
  suppliers?: Supplier[];
  localCouriers?: string[];
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
  // PR254 — the detail is display-only until "Edit shipment" is pressed; then courier/boxes/note edit.
  const [editingShip, setEditingShip] = useState(false);
  // delete-shipment confirm (active shipments only)
  const [confirmDelShip, setConfirmDelShip] = useState(false);
  const [deletingShip, setDeletingShip] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  // shipment-note editor (detail view)
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  // PR153: shipment courier + tracking drafts (auto-save; shared quickview shows "DHL 012456789")
  const [courierDraft, setCourierDraft] = useState('');
  const [trackingDraft, setTrackingDraft] = useState('');
  const [courierErr, setCourierErr] = useState<string | null>(null);
  // PR206 (0069): per-box dims/weight/tracking drafts (saved as a set; pre-fill the CN Packing List)
  const [boxDraft, setBoxDraft] = useState<BoxDraft[]>([]);
  const [boxErr, setBoxErr] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false); // PR261 — Done saves boxes + note together

  // PR255 — per-item detail overlay: the tapped item + editable drafts for its captured To-forwarder data.
  const [selItem, setSelItem] = useState<ShipmentItemRow | null>(null);
  const [itSupplier, setItSupplier] = useState<string>('');   // supplier_id as string ('' = none)
  const [itCost, setItCost] = useState('');
  const [itMethod, setItMethod] = useState('');
  const [itTracking, setItTracking] = useState('');
  const [itMarket, setItMarket] = useState('');
  const [itLink, setItLink] = useState('');
  const [itNote, setItNote] = useState('');
  const [itSaving, setItSaving] = useState(false);
  const [itErr, setItErr] = useState<string | null>(null);
  // PR267 — "Send back to Ship": detach some/all of a not-yet-received line from this shipment.
  const [sbQty, setSbQty] = useState(1);
  const [sbBusy, setSbBusy] = useState(false);

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
    setEditingShip(false);
    setConfirmDelShip(false);
    setDelErr(null);
    setSelItem(null);
    setCourierDraft(s.courier ?? '');
    setTrackingDraft(s.tracking ?? '');
    setCourierErr(null);
    setBoxErr(null);
    setBoxDraft([]);
    setShipItems([]);
    setShipItemsLoading(true);
    getShipmentBoxes(s.ship_id).then((rows) => setBoxDraft([rows.length ? boxToDraft(rows[0]) : emptyBoxDraft()])).catch(() => setBoxDraft([emptyBoxDraft()]));
    try {
      setShipItems(await getShipmentItems(s.ship_id));
    } catch {
      setShipItems([]);
    } finally {
      setShipItemsLoading(false);
    }
  }

  // PR206: save the whole box set for the open shipment (replaces existing rows). Returns success.
  async function saveBoxes(): Promise<boolean> {
    if (!openShip) return true;
    setBoxErr(null);
    const { error } = await setShipmentBoxes(openShip.ship_id, boxDraft.map(draftToBox));
    if (error) { setBoxErr(error); return false; }
    return true;
  }

  // save the per-Ship-ID note from the detail view (works even when starting empty). Returns success.
  async function saveNote(): Promise<boolean> {
    if (!openShip) return true;
    setSavingNote(true);
    try {
      await setShipmentNote(openShip.ship_id, noteDraft);
      const v = noteDraft.trim() || null;
      setShips((prev) => prev.map((s) => (s.ship_id === openShip.ship_id ? { ...s, note: v } : s)));
      setOpenShip((prev) => (prev ? { ...prev, note: v } : prev));
      return true;
    } catch {
      return false; // keep the editor open on a transient error
    } finally {
      setSavingNote(false);
    }
  }

  // PR261 — the Done button persists boxes + note together (their per-control Save buttons are gone),
  // then closes. The shipment courier/tracking already auto-saves on change/blur, so it needs no step.
  async function saveAndCloseEdit() {
    setSavingEdit(true);
    const okBoxes = await saveBoxes();
    const okNote = await saveNote();
    setSavingEdit(false);
    if (okBoxes && okNote) setEditingShip(false);
  }

  // PR254 — enter edit mode (seed the note draft from the current value); other drafts seeded on select.
  function enterEdit() {
    if (!openShip) return;
    setNoteDraft(openShip.note ?? '');
    setBoxErr(null); setCourierErr(null);
    setEditingShip(true);
  }

  // PR254 — delete an active shipment: ungroups it back to To forwarder (server), then drops it locally.
  async function doDeleteShipment() {
    if (!openShip) return;
    setDeletingShip(true); setDelErr(null);
    const { error } = await deleteShipment(openShip.ship_id);
    if (error) { setDelErr(error); setDeletingShip(false); return; }
    const id = openShip.ship_id;
    setShips((prev) => prev.filter((s) => s.ship_id !== id));
    setDeletingShip(false); setConfirmDelShip(false); setOpenShip(null);
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

  // PR255 — open the per-item detail overlay, seeding the editable drafts from the tapped line.
  function openItem(it: ShipmentItemRow) {
    setSelItem(it);
    setItSupplier(it.supplier_id != null ? String(it.supplier_id) : '');
    setItCost(it.item_cost != null ? String(it.item_cost) : '');
    setItMethod(it.method ?? '');
    setItTracking(it.tracking_to_forwarder ?? '');
    setItMarket(it.marketplace_order_id ?? '');
    setItLink(it.product_link ?? '');
    setItNote(it.item_note ?? '');
    setItErr(null);
    setSbQty(Math.max(1, it.qty)); // default: send the whole line back
  }

  // PR267 — send `sbQty` of the open line back to Ship (unassigned from this shipment). A partial send
  // splits the line server-side; reflect the result in the loaded list + header, then close the overlay.
  async function sendBack() {
    if (!selItem || !openShip) return;
    const qty = Math.max(1, Math.min(selItem.qty, Math.floor(sbQty) || 1));
    setSbBusy(true); setItErr(null);
    const { error } = await sendPoBackToShip(selItem.po_id, qty);
    if (error) { setItErr(error); setSbBusy(false); return; }
    // update the loaded lines: drop the line if fully sent back, else reduce its qty.
    const nextItems = qty >= selItem.qty
      ? shipItems.filter((r) => r.po_id !== selItem.po_id)
      : shipItems.map((r) => (r.po_id === selItem.po_id ? { ...r, qty: r.qty - qty } : r));
    setShipItems(nextItems);
    // keep the header's item count in sync (the total recomputes from the loaded lines). Full reload authoritative.
    const distinct = new Set(nextItems.map((i) => i.item_code ?? `raw:${i.po_id}`)).size;
    setOpenShip((prev) => (prev ? { ...prev, item_count: distinct } : prev));
    setSbBusy(false); setSelItem(null);
  }

  // PR255 — save the per-item detail (descriptive metadata only), reflected in the loaded list.
  async function saveItem() {
    if (!selItem) return;
    const cost = itCost.trim() === '' ? null : Number(itCost);
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) { setItErr('Unit cost must be a number ≥ 0.'); return; }
    const supplier_id = itSupplier === '' ? null : Number(itSupplier);
    setItSaving(true); setItErr(null);
    const { error } = await updateShipmentPO(selItem.po_id, {
      supplier_id,
      item_cost: cost,
      method: itMethod,
      tracking_to_forwarder: itTracking,
      marketplace_order_id: itMarket,
      product_link: itLink,
      item_note: itNote,
    });
    if (error) { setItErr(error); setItSaving(false); return; }
    const sup = suppliers.find((s) => s.supplier_id === supplier_id);
    setShipItems((prev) => prev.map((r) => (r.po_id === selItem.po_id ? {
      ...r,
      supplier_id,
      supplier_name: supplier_id == null ? null : sup?.name ?? r.supplier_name,
      item_cost: cost,
      method: itMethod.trim() || null,
      tracking_to_forwarder: itTracking.trim() || null,
      marketplace_order_id: itMarket.trim() || null,
      product_link: itLink.trim() || null,
      item_note: itNote.trim() || null,
    } : r)));
    setItSaving(false); setSelItem(null);
  }

  const TABS: { key: 'active' | 'completed'; label: string; count: number }[] = [
    { key: 'active', label: 'Active', count: counts.active },
    { key: 'completed', label: 'Completed', count: counts.completed },
  ];

  // ── shipment detail (PR255): a white detail card (Sales-style .bv-detail), DISPLAY-ONLY. Editing the
  // shipment's courier / boxes / note happens in the "Edit shipment" overlay; tapping an item opens its
  // per-PO detail overlay (the To-forwarder data — courier, tracking, marketplace id, cost, note). ──
  if (openShip) {
    const courierLine = [openShip.courier, openShip.tracking].filter(Boolean).join(' ');
    const savedBoxes = boxDraft.map(draftToBox).filter((b) => b.dim_p != null || b.dim_l != null || b.dim_t != null || b.real_weight != null || b.tracking);
    // header item-cost, recomputed live from the loaded lines (Σ cost×qty) so an item edit reflects at once.
    const loadedCost = shipItems.some((it) => it.item_cost != null) ? shipItems.reduce((n, it) => n + (it.item_cost ?? 0) * it.qty, 0) : null;
    const itemsCost = costText(shipItems.length ? loadedCost : openShip.total_cost, shipItems.find((it) => it.currency)?.currency ?? openShip.currency);
    // PR267 — the item overlay's cost prefix follows the picked Supplier's country (else the line's stored currency).
    const selSup = selItem ? suppliers.find((s) => String(s.supplier_id) === itSupplier) : null;
    const costSym = selItem ? (symbolForCountry(selSup?.country) || ccySymbol(selItem.currency)) : '';
    return (
      <div className="purch-history">
        <button className="btn-link bv-back" onClick={() => { setEditingShip(false); setSelItem(null); setOpenShip(null); }}>← back</button>
        <div className="bv-detail">
          {/* header: ship id (left) + received/shipped date (right, same line) */}
          <div className="fd-head">
            <div className="fd-head-row">
              <div className="fd-title">{openShip.ship_id}</div>
              <span className="fd-date">{dateLabel(openShip)}</span>
            </div>
          </div>

          {/* Shipment courier & tracking — display only */}
          <section className="fd-section">
            <div className="fd-section-head">Shipment courier &amp; tracking</div>
            <div className={courierLine ? 'ship-ro' : 'hint'}>{courierLine || 'No courier / tracking set.'}</div>
          </section>

          {/* Box — display only (one box per shipment) */}
          <section className="fd-section">
            <div className="fd-section-head">Box dimensions &amp; tracking</div>
            {savedBoxes.length === 0
              ? <div className="hint">No box recorded.</div>
              : <ul className="ship-box-ro">{savedBoxes.map((b, i) => <li key={i}>{boxSummary(b)}</li>)}</ul>}
          </section>

          {/* Items — count + total item cost in the header; tap a card for its captured detail */}
          <section className="fd-section">
            <div className="fd-section-head fd-section-head-row">
              <span>Items ({openShip.item_count})</span>
              {itemsCost && <span className="fd-items-cost">Total item cost {itemsCost}</span>}
            </div>
            {shipItemsLoading && <div className="hint">Loading items…</div>}
            {!shipItemsLoading && shipItems.length === 0 && <div className="hint">No item lines on this shipment.</div>}
            <ul className="po-cards po-cards-compact">
              {shipItems.map((it) => (
                <li key={it.po_id}>
                  {/* PR255 — tap a card to see / edit the PO detail captured at To forwarder. */}
                  <button className="po-card po-card-btn po-card-mini" onClick={() => openItem(it)}>
                    <SkuImage status={imgMap[it.item_code ?? '']?.status} displayUrl={imgMap[it.item_code ?? '']?.displayUrl} name={it.name} size={SKU_IMG.sm} />
                    <div className="po-card-main">
                      <span className="ff-code">{it.item_code || '—'}</span>
                      {isRealName(it.name, it.item_code) && <span className="ff-name po-card-name">{it.name}</span>}
                    </div>
                    <div className="po-card-side">
                      <span className="po-card-qty po-card-qty-lg">×{it.qty}</span>
                      {it.item_cost != null && (
                        <div className="po-card-meta">
                          <span className="po-card-date">{it.item_cost}{ccyTag(it.currency)} each</span>
                        </div>
                      )}
                    </div>
                    <span className="po-chev" aria-hidden>›</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {/* Shipment notes — display only */}
          <section className="fd-section">
            <div className="fd-section-head">Shipment notes</div>
            <div className={openShip.note ? 'ship-note-text' : 'hint'}>{openShip.note || 'No note yet.'}</div>
          </section>

          {/* Actions */}
          {delErr && <div className="validation err" style={{ marginTop: 12 }}>{delErr}</div>}
          <div className="fd-actions">
            <button className="btn-brown btn-ico" onClick={enterEdit}><PencilIcon />Edit shipment</button>
            {!openShip.completed && (
              <button className="btn-danger btn-ico" onClick={() => { setDelErr(null); setConfirmDelShip(true); }}><TrashIcon />Delete shipment</button>
            )}
          </div>
        </div>

        {/* Edit shipment overlay — courier / boxes / note (each saves on its own control; Done closes) */}
        {editingShip && (
          <div className="sc-modal-backdrop" onClick={() => setEditingShip(false)}>
            <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Edit shipment" onClick={(e) => e.stopPropagation()}>
              <div className="sc-modal-head sc-modal-head-row">
                <span className="sc-modal-title">Edit {openShip.ship_id}</span>
                <button className="sc-modal-x" onClick={() => setEditingShip(false)} aria-label="Close">×</button>
              </div>
              <div className="sc-modal-body">
                <div className="po-field">
                  {/* PR261 — subheaders styled like the detail view (uppercase .fd-section-head) */}
                  <div className="fd-section-head">Shipment courier &amp; tracking <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></div>
                  {courierErr && <div className="validation err" style={{ marginBottom: 8 }}>{courierErr}</div>}
                  <div className="po-inline2">
                    <select value={courierDraft} onChange={(e) => { setCourierDraft(e.target.value); void saveCourier(e.target.value, trackingDraft); }}>
                      <option value="">— courier —</option>
                      {shipmentCouriers.map((c) => <option key={c} value={c}>{c}</option>)}
                      {courierDraft && !shipmentCouriers.includes(courierDraft) && <option value={courierDraft}>{courierDraft}</option>}
                    </select>
                    <input type="text" placeholder="tracking number" value={trackingDraft} onChange={(e) => setTrackingDraft(e.target.value)} onBlur={(e) => void saveCourier(courierDraft, e.target.value)} />
                  </div>
                </div>
                <div className="po-field">
                  <div className="fd-section-head">Box dimensions &amp; tracking <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></div>
                  {boxErr && <div className="validation err">{boxErr}</div>}
                  {/* PR265 — one box per shipment: a single card (L/W/H + real weight; then local courier
                      + tracking + a compact clear). No add/remove — a shipment always has one box. */}
                  {(() => {
                    const b = boxDraft[0] ?? emptyBoxDraft();
                    const upd = (patch: Partial<BoxDraft>) => setBoxDraft((prev) => [{ ...(prev[0] ?? emptyBoxDraft()), ...patch }]);
                    return (
                      <div className="sb-card">
                        <div className="sb-card-r1">
                          <label className="sb-f"><span>L (cm)</span><input type="text" inputMode="decimal" value={b.p} onChange={(e) => upd({ p: e.target.value })} /></label>
                          <label className="sb-f"><span>W (cm)</span><input type="text" inputMode="decimal" value={b.l} onChange={(e) => upd({ l: e.target.value })} /></label>
                          <label className="sb-f"><span>H (cm)</span><input type="text" inputMode="decimal" value={b.t} onChange={(e) => upd({ t: e.target.value })} /></label>
                          <label className="sb-f"><span>Real wt (kg)</span><input type="text" inputMode="decimal" value={b.w} onChange={(e) => upd({ w: e.target.value })} /></label>
                        </div>
                        <div className="sb-card-r2">
                          <input type="text" list="sb-box-couriers" placeholder="local courier" value={b.courier} onChange={(e) => upd({ courier: e.target.value })} />
                          <input type="text" placeholder="tracking number" value={b.tracking} onChange={(e) => upd({ tracking: e.target.value })} />
                          <button className="set-del" aria-label="Clear box" onClick={() => setBoxDraft([emptyBoxDraft()])}><TrashIcon /></button>
                        </div>
                      </div>
                    );
                  })()}
                  <datalist id="sb-box-couriers">{localCouriers.map((c) => <option key={c} value={c} />)}</datalist>
                </div>
                <div className="po-field">
                  <div className="fd-section-head">Shipment notes <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></div>
                  <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Notes for this shipment ID" rows={3} disabled={savingNote} />
                </div>
              </div>
              <div className="sc-modal-foot">
                <button className="btn-primary" onClick={saveAndCloseEdit} disabled={savingEdit}>{savingEdit ? 'Saving…' : 'Done'}</button>
              </div>
            </div>
          </div>
        )}

        {/* per-item detail overlay — the PO data captured at To forwarder (editable) */}
        {selItem && (
          <div className="sc-modal-backdrop" onClick={() => { if (!itSaving) setSelItem(null); }}>
            <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Item detail" onClick={(e) => e.stopPropagation()}>
              <div className="sc-modal-head sc-modal-head-row">
                <div>
                  <span className="sc-modal-title">{selItem.item_code || '—'}</span>
                  {isRealName(selItem.name, selItem.item_code) && <div className="sc-modal-sub">{selItem.name} · ×{selItem.qty}</div>}
                </div>
                <button className="sc-modal-x" onClick={() => { if (!itSaving) setSelItem(null); }} aria-label="Close">×</button>
              </div>
              <div className="sc-modal-body">
                {itErr && <div className="validation err" style={{ marginBottom: 10 }}>{itErr}</div>}
                <div className="po-field">
                  <label>Supplier</label>
                  <select value={itSupplier} onChange={(e) => setItSupplier(e.target.value)} disabled={itSaving}>
                    <option value="">— none —</option>
                    {suppliers.map((s) => <option key={s.supplier_id} value={s.supplier_id}>{s.flag ? `${s.flag} ` : ''}{s.name}</option>)}
                  </select>
                </div>
                <div className="po-field">
                  <label>Unit cost <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
                  {/* PR266 — currency symbol in FRONT of the input (like ¥100 / $10); "each" trails it. */}
                  <div className="po-cost-row">
                    {costSym && <span className="po-cost-ccy">{costSym}</span>}
                    <input type="number" inputMode="decimal" min={0} step="any" placeholder="0" value={itCost} onChange={(e) => setItCost(e.target.value)} disabled={itSaving} />
                    <span className="po-cost-ccy">each</span>
                  </div>
                </div>
                <div className="po-field">
                  <label>Local courier &amp; tracking <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
                  <div className="po-inline2">
                    <input type="text" list="hist-methods" placeholder="courier" value={itMethod} onChange={(e) => setItMethod(e.target.value)} disabled={itSaving} />
                    <input type="text" placeholder="tracking number" value={itTracking} onChange={(e) => setItTracking(e.target.value)} disabled={itSaving} />
                  </div>
                  <datalist id="hist-methods">{localCouriers.map((m) => <option key={m} value={m} />)}</datalist>
                </div>
                <div className="po-field">
                  <label>Marketplace ID <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
                  <input type="text" placeholder="marketplace order id" value={itMarket} onChange={(e) => setItMarket(e.target.value)} disabled={itSaving} />
                </div>
                <div className="po-field">
                  <label>Item link <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
                  <input type="text" placeholder="https://…" value={itLink} onChange={(e) => setItLink(e.target.value)} disabled={itSaving} />
                </div>
                <div className="po-field">
                  <label>Notes <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
                  <textarea value={itNote} onChange={(e) => setItNote(e.target.value)} disabled={itSaving} rows={2} />
                </div>

                {/* PR267 — Send back to Ship (Active shipments only): unassign some/all of this line
                    from the shipment so it returns to the Ship queue to be re-grouped / investigated. */}
                {!openShip.completed && (
                  <div className="po-field sb-field">
                    <label>Send back to Ship</label>
                    <div className="sb-row">
                      {selItem.qty > 1 && (
                        <span className="qty-step">
                          <button type="button" aria-label="one fewer" onClick={() => setSbQty((q) => Math.max(1, q - 1))} disabled={sbBusy || sbQty <= 1}>−</button>
                          <input type="number" inputMode="numeric" min={1} max={selItem.qty} value={sbQty} onChange={(e) => setSbQty(Math.max(1, Math.min(selItem.qty, parseInt(e.target.value, 10) || 1)))} />
                          <button type="button" aria-label="one more" onClick={() => setSbQty((q) => Math.min(selItem.qty, q + 1))} disabled={sbBusy || sbQty >= selItem.qty}>+</button>
                        </span>
                      )}
                      <button className="btn-brown btn-ico" onClick={sendBack} disabled={sbBusy || itSaving}><BackIcon />{sbBusy ? 'Sending…' : 'Send back to Ship'}</button>
                    </div>
                    <div className="hint" style={{ marginTop: 6 }}>
                      Unassigns {selItem.qty > 1 ? `${sbQty} of ×${selItem.qty}` : 'this line'} from {openShip.ship_id} back to Ship — to re-group or investigate a short.
                    </div>
                  </div>
                )}
              </div>
              <div className="sc-modal-foot">
                <button className="btn-secondary" onClick={() => setSelItem(null)} disabled={itSaving || sbBusy}>Cancel</button>
                <button className="btn-primary" onClick={saveItem} disabled={itSaving || sbBusy}>{itSaving ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
          </div>
        )}

        {/* delete confirm — ungroups the shipment back to To forwarder */}
        {confirmDelShip && (
          <div className="sc-modal-backdrop" onClick={() => { if (!deletingShip) setConfirmDelShip(false); }}>
            <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Delete shipment" onClick={(e) => e.stopPropagation()}>
              <div className="sc-modal-body">
                <div className="confirm-q">Delete shipment {openShip.ship_id}?</div>
                <div className="hint" style={{ marginBottom: 12 }}>Its {openShip.item_count} {openShip.item_count === 1 ? 'item' : 'items'} go back to Forward to be re-grouped. This can’t be undone.</div>
                {delErr && <div className="validation err" style={{ marginBottom: 10 }}>{delErr}</div>}
                <div className="confirm-actions">
                  <button className="btn-secondary" onClick={() => setConfirmDelShip(false)} disabled={deletingShip}>No</button>
                  <button className="btn-primary danger" onClick={doDeleteShipment} disabled={deletingShip}>{deletingShip ? 'Deleting…' : 'Yes, delete'}</button>
                </div>
              </div>
            </div>
          </div>
        )}
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

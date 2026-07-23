'use client';

// Purchasing → History tab. Two sub-lists (Sales-Pending style tabs with counts):
//  • Active    — ship_ids not yet received (open shipments, e.g. SUB 189/191/192). Date = shipped date.
//  • Completed — received ship_ids (completed shipments). Date = received date. Uncapped (shows all).
// One quickview card per shipment; tap to see its items. The search bar matches ship_id OR any SKU in
// the shipment, so searching a SKU surfaces which ship_ids contain it. Read-only.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getShipmentHistory, getShipmentItems, setShipmentNote, setShipmentCourier, setConsolidator, getShipmentBoxes, setShipmentBoxes, deleteShipment, markShipmentReceived } from '@/app/purchasing/actions';
import type { ShipmentHistoryRow, ShipmentItemRow, ShipmentBox } from '@/app/purchasing/types';
import type { Supplier } from '@jigzle/db/types';
import SkuImage from '@/components/SkuImage';
import { isRealName } from '@/components/skuName';
import { useEscToClose, useOverlayClose } from '@/components/useOverlayClose';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import SearchInput from '@/components/SearchInput';
import DropSearch from '@/components/DropSearch';
import { fmtNiceDate } from '@jigzle/lib';
import { openViaTaobaoApp } from '@/lib/deepLink';

// PR322 — courier dropsearch options: the shared list + the current value if it's not in it (kept so an
// existing courier still shows even after it's removed from Settings), each as a {value,label} pair.
const courierDsOpts = (list: string[], cur: string) => [...list, ...(cur && !list.includes(cur) ? [cur] : [])].map((c) => ({ value: c, label: c }));

// PR206/PR261: box editor draft rows (string inputs) ⇄ ShipmentBox (numbers/null). real_weight is kg
// (the CN Packing List reads kg). PR261 adds a per-box local courier alongside the tracking number.
// PR — a per-box `desc` (品名 / DESCRIPTION), one row per box like the CN Packing List (0120).
type BoxDraft = { desc: string; p: string; l: string; t: string; w: string; courier: string; tracking: string };
const emptyBoxDraft = (): BoxDraft => ({ desc: '', p: '', l: '', t: '', w: '', courier: '', tracking: '' });
const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));
const boxToDraft = (b: ShipmentBox): BoxDraft => ({ desc: b.description ?? '', p: b.dim_p?.toString() ?? '', l: b.dim_l?.toString() ?? '', t: b.dim_t?.toString() ?? '', w: b.real_weight?.toString() ?? '', courier: b.courier ?? '', tracking: b.tracking ?? '' });
const draftToBox = (d: BoxDraft): ShipmentBox => ({ dim_p: numOrNull(d.p), dim_l: numOrNull(d.l), dim_t: numOrNull(d.t), real_weight: numOrNull(d.w), description: d.desc.trim() || null, courier: d.courier.trim() || null, tracking: d.tracking.trim() || null });

// action-button icons (edit / delete), matching the To-buy detail style.
const _ic = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, width: 16, height: 16, 'aria-hidden': true };
const PencilIcon = () => (<svg {..._ic}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);
const TrashIcon = () => (<svg {..._ic}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>);
const CheckIcon = () => (<svg {..._ic}><polyline points="20 6 9 17 4 12" /></svg>);
// today's date as an ISO yyyy-mm-dd value, for the "Mark as received" date field default.
const todayISO = (): string => new Date().toISOString().slice(0, 10);

const fmtDate = (s: string | null): string => fmtNiceDate(s) || '—';
// one saved box rendered read-only (view mode): "Jigsaw puzzle · 40 × 30 × 25 cm · 12.5 kg"
// (PR — leads with the per-box description when set; dims only otherwise).
const boxSummary = (b: ShipmentBox): string => {
  const dims = [b.dim_p, b.dim_l, b.dim_t];
  const parts: string[] = [];
  if (b.description?.trim()) parts.push(b.description.trim());
  if (dims.some((d) => d != null)) parts.push(`${dims.map((d) => (d ?? '–')).join(' × ')} cm`);
  if (b.real_weight != null) parts.push(`${b.real_weight} kg`);
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
  // PR316 — "Mark as received" confirm (active shipments only): a header-only close for goods already
  // received out of band in Inbound. Captures an editable received date (default today).
  const [confirmMarkRcv, setConfirmMarkRcv] = useState(false);
  const [markRcvDate, setMarkRcvDate] = useState('');
  const [markingRcv, setMarkingRcv] = useState(false);
  const [markErr, setMarkErr] = useState<string | null>(null);
  // shipment-note editor (detail view)
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  // PR153: shipment courier + tracking drafts (auto-save; shared quickview shows "DHL 012456789")
  const [courierDraft, setCourierDraft] = useState('');
  const [trackingDraft, setTrackingDraft] = useState('');
  const [courierErr, setCourierErr] = useState<string | null>(null);
  // PR272/PR274: consolidator courier + tracking drafts (auto-save on blur/change, like the shipper leg)
  const [consolCourierDraft, setConsolCourierDraft] = useState('');
  const [consolTrackDraft, setConsolTrackDraft] = useState('');
  // PR206 (0069): per-box dims/weight/tracking drafts (saved as a set; pre-fill the CN Packing List)
  const [boxDraft, setBoxDraft] = useState<BoxDraft[]>([]);
  const [boxErr, setBoxErr] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false); // PR261 — Done saves boxes + note together
  const [editDirty, setEditDirty] = useState(false); // PR307 — box/note edits are unsaved until "Done"

  // PR293 — per-item detail overlay is now READ-ONLY: History items are finalised, so the overlay
  // shows the captured To-forwarder data locked (no edit, no Send back to Ship — a short line is
  // returned to Ship automatically at Inbound receiving). Just the tapped line.
  const [selItem, setSelItem] = useState<ShipmentItemRow | null>(null);

  // PR153: tell the shell when a detail is open (it hides the pipeline tabs, keeps the breadcrumb)
  useEffect(() => { onDetailOpenChange?.(!!openShip); }, [openShip, onDetailOpenChange]);

  const imgCodes = useMemo(
    () => (openShip ? shipItems.map((i) => i.item_code).filter((c): c is string => !!c) : []),
    [openShip, shipItems]
  );
  const imgMap = useSkuImages(imgCodes);

  // client-side filter over the loaded set: match ship_id, any SKU code, any item name (PR153), OR any
  // of the three tracking numbers (PR272 — local / consolidator / shipment). Then split by tab.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ships.filter((s) => {
      if (s.completed !== (sub === 'completed')) return false;
      if (!q) return true;
      return (
        s.ship_id.toLowerCase().includes(q) ||
        s.sku_codes.some((c) => c.toLowerCase().includes(q)) ||
        s.sku_names.some((n) => n.toLowerCase().includes(q)) ||
        (s.tracking?.toLowerCase().includes(q) ?? false) ||
        (s.consolidator_tracking?.toLowerCase().includes(q) ?? false) ||
        s.local_trackings.some((t) => t.toLowerCase().includes(q))
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
    setConsolCourierDraft(s.consolidator_courier ?? '');
    setConsolTrackDraft(s.consolidator_tracking ?? '');
    setCourierErr(null);
    setBoxErr(null);
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
    if (okBoxes && okNote) { setEditDirty(false); setEditingShip(false); }
  }

  // PR254 — enter edit mode (seed the note draft from the current value); other drafts seeded on select.
  function enterEdit() {
    if (!openShip) return;
    setNoteDraft(openShip.note ?? '');
    setBoxErr(null); setCourierErr(null);
    setEditDirty(false);
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

  // PR316 — open the "Mark as received" confirm, seeding the date to today (editable).
  function openMarkReceived() {
    setMarkErr(null);
    setMarkRcvDate(todayISO());
    setConfirmMarkRcv(true);
  }

  // PR316 — header-only close: flips this shipment to Completed with the chosen received date. The goods
  // were already received in Inbound, so this does NOT re-run receiving / add stock (see the action).
  async function doMarkReceived() {
    if (!openShip) return;
    setMarkingRcv(true); setMarkErr(null);
    const { error } = await markShipmentReceived(openShip.ship_id, markRcvDate);
    if (error) { setMarkErr(error); setMarkingRcv(false); return; }
    const id = openShip.ship_id;
    setShips((prev) => prev.map((s) => (s.ship_id === id ? { ...s, completed: true, received_date: markRcvDate } : s)));
    setOpenShip((prev) => (prev ? { ...prev, completed: true, received_date: markRcvDate } : prev));
    setMarkingRcv(false); setConfirmMarkRcv(false);
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

  // PR272/PR274: persist the consolidator courier + tracking (Consolidator → Shipper leg), auto-save.
  async function saveConsolidator(courier: string, tracking: string) {
    if (!openShip) return;
    setCourierErr(null);
    const { error } = await setConsolidator(openShip.ship_id, courier, tracking);
    if (error) { setCourierErr(error); return; }
    const cc = courier.trim() || null;
    const t = tracking.trim() || null;
    setShips((prev) => prev.map((s) => (s.ship_id === openShip.ship_id ? { ...s, consolidator_courier: cc, consolidator_tracking: t } : s)));
    setOpenShip((prev) => (prev ? { ...prev, consolidator_courier: cc, consolidator_tracking: t } : prev));
  }

  // PR293 — open the read-only per-item detail overlay for the tapped line.
  function openItem(it: ShipmentItemRow) {
    setSelItem(it);
  }

  const TABS: { key: 'active' | 'completed'; label: string; count: number }[] = [
    { key: 'active', label: 'Active', count: counts.active },
    { key: 'completed', label: 'Completed', count: counts.completed },
  ];

  // ── shipment detail (PR255): a white detail card (Sales-style .bv-detail), DISPLAY-ONLY. Editing the
  // shipment's courier / boxes / note happens in the "Edit shipment" overlay; tapping an item opens its
  // per-PO detail overlay (the To-forwarder data — courier, tracking, marketplace id, cost, note). ──
  // PR307 — Esc / backdrop / × close. The edit-shipment overlay guards box + note (unsaved until Done);
  // the read-only item detail and the delete confirm just close.
  const editShipClose = useOverlayClose({ open: editingShip, onClose: () => setEditingShip(false), dirty: editDirty });
  useEscToClose(!!selItem, () => setSelItem(null));
  useEscToClose(confirmDelShip, () => { if (!deletingShip) setConfirmDelShip(false); });
  useEscToClose(confirmMarkRcv, () => { if (!markingRcv) setConfirmMarkRcv(false); });

  if (openShip) {
    const courierLine = [openShip.courier, openShip.tracking].filter(Boolean).join(' ');
    // PR274 — consolidator leg: courier + tracking (mirrors the shipper leg's "courier tracking").
    const consolLine = [openShip.consolidator_courier, openShip.consolidator_tracking].filter(Boolean).join(' ');
    const savedBoxes = boxDraft.map(draftToBox).filter((b) => b.dim_p != null || b.dim_l != null || b.dim_t != null || b.real_weight != null);
    // header item-cost, recomputed live from the loaded lines (Σ cost×qty) so an item edit reflects at once.
    const loadedCost = shipItems.some((it) => it.item_cost != null) ? shipItems.reduce((n, it) => n + (it.item_cost ?? 0) * it.qty, 0) : null;
    const itemsCost = costText(shipItems.length ? loadedCost : openShip.total_cost, shipItems.find((it) => it.currency)?.currency ?? openShip.currency);
    // PR267/PR293 — the item overlay's cost symbol follows the line's Source country (else stored currency).
    const selSup = selItem ? suppliers.find((s) => s.supplier_id === selItem.supplier_id) : null;
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

          {/* PR273 — display-only detail mirrors the Edit overlay's flow: Items, then Consolidator,
              Shipment, Box, Notes (same section order as Edit, with Items on top). */}

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

          {/* Consolidator courier & tracking — display only (Consolidator → Shipper leg) */}
          <section className="fd-section">
            <div className="fd-section-head">Consolidator courier &amp; tracking</div>
            <div className={consolLine ? 'ship-ro' : 'hint'}>{consolLine || 'No courier / tracking set.'}</div>
          </section>

          {/* Shipment courier & tracking — display only (Shipper → Jigzle leg) */}
          <section className="fd-section">
            <div className="fd-section-head">Shipment courier &amp; tracking</div>
            <div className={courierLine ? 'ship-ro' : 'hint'}>{courierLine || 'No courier / tracking set.'}</div>
          </section>

          {/* Box — display only (one box per shipment, dimensions only) */}
          <section className="fd-section">
            <div className="fd-section-head">Box dimensions</div>
            {savedBoxes.length === 0
              ? <div className="hint">No box recorded.</div>
              : <ul className="ship-box-ro">{savedBoxes.map((b, i) => <li key={i}>{boxSummary(b)}</li>)}</ul>}
          </section>

          {/* Shipment notes — display only */}
          <section className="fd-section">
            <div className="fd-section-head">Shipment notes</div>
            <div className={openShip.note ? 'ship-note-text' : 'hint'}>{openShip.note || 'No note yet.'}</div>
          </section>

          {/* Actions */}
          {delErr && <div className="validation err" style={{ marginTop: 12 }}>{delErr}</div>}
          <div className="fd-actions">
            {/* PR316 — an active shipment can be marked received manually (goods already received in Inbound
                out of band, so the header never closed). Header-only; hidden once completed. */}
            {!openShip.completed && (
              <button className="btn-brown btn-ico" onClick={openMarkReceived}><CheckIcon />Mark as received</button>
            )}
            <button className="btn-brown btn-ico" onClick={enterEdit}><PencilIcon />Edit shipment</button>
            {!openShip.completed && (
              <button className="btn-danger btn-ico" onClick={() => { setDelErr(null); setConfirmDelShip(true); }}><TrashIcon />Delete shipment</button>
            )}
          </div>
        </div>

        {/* Edit shipment overlay — courier / boxes / note (each saves on its own control; Done closes) */}
        {editingShip && (
          <div className="sc-modal-backdrop" onClick={editShipClose.requestClose}>
            {editShipClose.confirm}
            <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Edit shipment" onClick={(e) => e.stopPropagation()}>
              <div className="sc-modal-head sc-modal-head-row">
                <span className="sc-modal-title">Edit {openShip.ship_id}</span>
                <button className="sc-modal-x" onClick={editShipClose.requestClose} aria-label="Close">×</button>
              </div>
              <div className="sc-modal-body">
                <div className="po-field">
                  {/* PR274 — consolidator courier + tracking (Consolidator → Shipper leg), before the
                      shipper leg. Courier uses the shared LOCAL + CONSOLIDATOR list (localCouriers). */}
                  <div className="fd-section-head">Consolidator courier &amp; tracking</div>
                  <div className="po-inline2 po-inline-courier">
                    {/* PR308 — consolidator courier is a dropdown (shared LOCAL + CONSOLIDATOR list), like the shipment courier. */}
                    <DropSearch
                      value={consolCourierDraft || null}
                      onChange={(v) => { setConsolCourierDraft(v); void saveConsolidator(v, consolTrackDraft); }}
                      options={courierDsOpts(localCouriers, consolCourierDraft)}
                      placeholder="— Pick courier —"
                      clearable
                      ariaLabel="Consolidator courier"
                    />
                    <input type="text" placeholder="Tracking number" value={consolTrackDraft} onChange={(e) => setConsolTrackDraft(e.target.value)} onBlur={(e) => void saveConsolidator(consolCourierDraft, e.target.value)} />
                  </div>
                </div>
                <div className="po-field">
                  {/* PR261 — subheaders styled like the detail view (uppercase .fd-section-head) */}
                  <div className="fd-section-head">Shipment courier &amp; tracking</div>
                  {courierErr && <div className="validation err" style={{ marginBottom: 8 }}>{courierErr}</div>}
                  <div className="po-inline2 po-inline-courier">
                    <DropSearch
                      value={courierDraft || null}
                      onChange={(v) => { setCourierDraft(v); void saveCourier(v, trackingDraft); }}
                      options={courierDsOpts(shipmentCouriers, courierDraft)}
                      placeholder="— Pick courier —"
                      clearable
                      ariaLabel="Shipment courier"
                    />
                    <input type="text" placeholder="Tracking number" value={trackingDraft} onChange={(e) => setTrackingDraft(e.target.value)} onBlur={(e) => void saveCourier(courierDraft, e.target.value)} />
                  </div>
                </div>
                <div className="po-field">
                  {/* PR — box dimensions as one row per box, mirroring the CN Packing List packages
                      table (Description + L/W/H/real-wt). A shipment can carry more than one box; the
                      last box can't be removed, and "+ Add box" appends another. Local courier/tracking
                      lives in the Consolidator/Shipment sections, not per box. */}
                  <div className="fd-section-head">Box dimensions</div>
                  {boxErr && <div className="validation err">{boxErr}</div>}
                  {(() => {
                    const rowsView = boxDraft.length ? boxDraft : [emptyBoxDraft()];
                    return (
                      <>
                        <div className="sb-grid-head">
                          <div>Box</div><div>Description</div><div>L (cm)</div><div>W (cm)</div><div>H (cm)</div><div>Real wt (kg)</div><div />
                        </div>
                        {rowsView.map((b, i) => {
                          const upd = (patch: Partial<BoxDraft>) => { setEditDirty(true); setBoxDraft(rowsView.map((row, j) => (j === i ? { ...row, ...patch } : row))); };
                          const removeBox = () => { setEditDirty(true); setBoxDraft(rowsView.filter((_, j) => j !== i)); };
                          return (
                            <div className="sb-grid-row" key={i}>
                              <div className="sb-grid-n">{i + 1}</div>
                              <input type="text" value={b.desc} onChange={(e) => upd({ desc: e.target.value })} placeholder="Jigsaw puzzle" aria-label={`Box ${i + 1} description`} />
                              <input type="text" inputMode="decimal" value={b.p} onChange={(e) => upd({ p: e.target.value })} aria-label={`Box ${i + 1} length`} />
                              <input type="text" inputMode="decimal" value={b.l} onChange={(e) => upd({ l: e.target.value })} aria-label={`Box ${i + 1} width`} />
                              <input type="text" inputMode="decimal" value={b.t} onChange={(e) => upd({ t: e.target.value })} aria-label={`Box ${i + 1} height`} />
                              <input type="text" inputMode="decimal" value={b.w} onChange={(e) => upd({ w: e.target.value })} aria-label={`Box ${i + 1} real weight`} />
                              <button type="button" className="sb-grid-del" onClick={removeBox} disabled={rowsView.length <= 1} aria-label={`Remove box ${i + 1}`}>×</button>
                            </div>
                          );
                        })}
                      </>
                    );
                  })()}
                  <button type="button" className="btn-brown sb-box-add" onClick={() => { setEditDirty(true); setBoxDraft((prev) => [...(prev.length ? prev : [emptyBoxDraft()]), emptyBoxDraft()]); }}>+ Add box</button>
                </div>
                <div className="po-field">
                  <div className="fd-section-head">Shipment notes</div>
                  <textarea value={noteDraft} onChange={(e) => { setEditDirty(true); setNoteDraft(e.target.value); }} placeholder="Notes for this shipment ID" rows={3} disabled={savingNote} />
                </div>
              </div>
              <div className="sc-modal-foot">
                <button className="btn-primary" onClick={saveAndCloseEdit} disabled={savingEdit}>{savingEdit ? 'Saving…' : 'Save changes'}</button>
              </div>
            </div>
          </div>
        )}

        {/* per-item detail overlay — the PO data captured at To forwarder (read-only; PR293) */}
        {selItem && (
          <div className="sc-modal-backdrop" onClick={() => setSelItem(null)}>
            <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Item detail" onClick={(e) => e.stopPropagation()}>
              <div className="sc-modal-head sc-modal-head-row">
                <div>
                  {/* PR315 — qty sits beside the SKU in the header (was trailing the subheader name). */}
                  <div className="sc-modal-title-line">
                    <span className="sc-modal-title">{selItem.item_code || '—'}</span>
                    <span className="po-card-qty">×{selItem.qty}</span>
                  </div>
                  {isRealName(selItem.name, selItem.item_code) && <div className="sc-modal-sub">{selItem.name}</div>}
                </div>
                <button className="sc-modal-x" onClick={() => setSelItem(null)} aria-label="Close">×</button>
              </div>
              {/* PR293 — READ-ONLY: History lines are finalised. Same field order as the Ship detail,
                  values locked (no edit, no Send back to Ship). */}
              <div className="sc-modal-body">
                <div className="po-field">
                  <label>Source</label>
                  <div className="po-ro-locked">{selSup ? `${selSup.flag ? selSup.flag + ' ' : ''}${selSup.name}` : (selItem.supplier_name || '—')}</div>
                </div>
                {/* PR319 — Unit cost (narrow, left) + Item link (grow, right) share one line, mirroring the
                    Ship detail. Top-aligned since the locked link can wrap (clamped) to two lines. */}
                <div className="po-field-row po-field-row-top">
                  <div className="po-field po-field-cost">
                    <label>Unit cost</label>
                    {/* PR269 read-only currency rule: symbol AFTER the number ("108元 each"). */}
                    <div className="po-ro-locked">{selItem.item_cost != null ? `${selItem.item_cost}${costSym} each` : '—'}</div>
                  </div>
                  <div className="po-field grow">
                    <label>Item link</label>
                    <div className="po-ro-locked po-ro-locked-row">
                      <span className="po-rov-link">{selItem.product_link ? <a href={selItem.product_link} target="_blank" rel="noreferrer" onClick={(e) => openViaTaobaoApp(e, selItem.product_link!)}>{selItem.product_link}</a> : '—'}</span>
                    </div>
                  </div>
                </div>
                <div className="po-field">
                  <label>Local courier &amp; tracking</label>
                  <div className="po-ro-locked">{[selItem.method || null, selItem.tracking_to_forwarder ? `#${selItem.tracking_to_forwarder}` : null].filter(Boolean).join(' · ') || '—'}</div>
                </div>
                <div className="po-field">
                  <label>Marketplace ID</label>
                  <div className="po-ro-locked">{selItem.marketplace_order_id || '—'}</div>
                </div>
                <div className="po-field">
                  <label>Notes</label>
                  <div className="po-ro-locked">{selItem.item_note || '—'}</div>
                </div>
              </div>
              <div className="sc-modal-foot">
                <button className="btn-secondary" onClick={() => setSelItem(null)}>Close</button>
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

        {/* PR316 — mark-as-received confirm: header-only close with an editable received date (default today).
            For the out-of-band case (goods already received in Inbound); does NOT add stock. */}
        {confirmMarkRcv && (
          <div className="sc-modal-backdrop" onClick={() => { if (!markingRcv) setConfirmMarkRcv(false); }}>
            <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Mark shipment received" onClick={(e) => e.stopPropagation()}>
              <div className="sc-modal-body">
                <div className="confirm-q">Mark {openShip.ship_id} as received?</div>
                <div className="hint" style={{ marginBottom: 12 }}>Moves it to Completed. Use only when the goods were already received in Inbound — this records the date below and does not add stock.</div>
                <div className="po-field">
                  <label>Received date<span className="req" aria-hidden="true">*</span></label>
                  <input type="date" value={markRcvDate} onChange={(e) => setMarkRcvDate(e.target.value)} disabled={markingRcv} />
                </div>
                {markErr && <div className="validation err" style={{ margin: '4px 0 10px' }}>{markErr}</div>}
                <div className="confirm-actions">
                  <button className="btn-secondary" onClick={() => setConfirmMarkRcv(false)} disabled={markingRcv}>Cancel</button>
                  <button className="btn-primary" onClick={doMarkReceived} disabled={markingRcv || !markRcvDate}>{markingRcv ? 'Saving…' : 'Mark as received'}</button>
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
        <SearchInput value={query} onChange={setQuery} placeholder="Search by SKU, item name, or tracking" />
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
                <span className="po-chev" aria-hidden>›</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

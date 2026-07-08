'use client';

// Purchasing → History tab. Two sub-lists (Sales-Pending style tabs with counts):
//  • Active    — ship_ids not yet received (open shipments, e.g. SUB 189/191/192). Date = shipped date.
//  • Completed — received ship_ids (completed shipments). Date = received date. Uncapped (shows all).
// One quickview card per shipment; tap to see its items. The search bar matches ship_id OR any SKU in
// the shipment, so searching a SKU surfaces which ship_ids contain it. Read-only.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getShipmentHistory, getShipmentItems, setShipmentNote, setShipmentCourier, getShipmentBoxes, setShipmentBoxes, deleteShipment } from '@/app/purchasing/actions';
import type { ShipmentHistoryRow, ShipmentItemRow, ShipmentBox } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { isRealName } from '@/components/skuName';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import SearchInput from '@/components/SearchInput';

// PR206: box editor draft rows (string inputs) ⇄ ShipmentBox (numbers/null).
type BoxDraft = { p: string; l: string; t: string; w: string; tracking: string };
const emptyBoxDraft = (): BoxDraft => ({ p: '', l: '', t: '', w: '', tracking: '' });
const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));
const boxToDraft = (b: ShipmentBox): BoxDraft => ({ p: b.dim_p?.toString() ?? '', l: b.dim_l?.toString() ?? '', t: b.dim_t?.toString() ?? '', w: b.real_weight?.toString() ?? '', tracking: b.tracking ?? '' });
const draftToBox = (d: BoxDraft): ShipmentBox => ({ dim_p: numOrNull(d.p), dim_l: numOrNull(d.l), dim_t: numOrNull(d.t), real_weight: numOrNull(d.w), tracking: d.tracking.trim() || null });

// action-button icons (edit / delete), matching the To-buy detail style.
const _ic = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, width: 16, height: 16, 'aria-hidden': true };
const PencilIcon = () => (<svg {..._ic}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);
const TrashIcon = () => (<svg {..._ic}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>);

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');
// one saved box rendered read-only (view mode): "40 × 30 × 25 cm · 12.5 kg · ZTO123"
const boxSummary = (b: ShipmentBox): string => {
  const dims = [b.dim_p, b.dim_l, b.dim_t];
  const parts: string[] = [];
  if (dims.some((d) => d != null)) parts.push(`${dims.map((d) => (d ?? '–')).join(' × ')} cm`);
  if (b.real_weight != null) parts.push(`${b.real_weight} kg`);
  if (b.tracking) parts.push(b.tracking);
  return parts.join(' · ') || '—';
};
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
    setEditingShip(false);
    setConfirmDelShip(false);
    setDelErr(null);
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
    } catch {
      /* keep the editor open on a transient error */
    } finally {
      setSavingNote(false);
    }
  }

  // PR254 — enter edit mode (seed the note draft from the current value); other drafts seeded on select.
  function enterEdit() {
    if (!openShip) return;
    setNoteDraft(openShip.note ?? '');
    setBoxErr(null); setBoxSaved(false); setCourierErr(null);
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

  const TABS: { key: 'active' | 'completed'; label: string; count: number }[] = [
    { key: 'active', label: 'Active', count: counts.active },
    { key: 'completed', label: 'Completed', count: counts.completed },
  ];

  // ── shipment detail (PR254): a white detail card (Sales-style .bv-detail), display-only by default.
  // "Edit shipment" flips courier / boxes / note into edit controls; "Delete shipment" (active only)
  // ungroups it back to To forwarder. Items are always read-only. ──
  if (openShip) {
    const cost = costLabel(openShip);
    const courierLine = [openShip.courier, openShip.tracking].filter(Boolean).join(' ');
    const savedBoxes = boxDraft.map(draftToBox).filter((b) => b.dim_p != null || b.dim_l != null || b.dim_t != null || b.real_weight != null || b.tracking);
    return (
      <div className="purch-history">
        <button className="btn-link bv-back" onClick={() => { setEditingShip(false); setOpenShip(null); }}>← back</button>
        <div className="bv-detail">
          <div className="fd-head">
            <div className="fd-title">{openShip.ship_id}</div>
            <div className="fd-sub">
              {dateLabel(openShip)} · {openShip.item_count} {openShip.item_count === 1 ? 'item' : 'items'}
              {cost ? ` · ${cost}` : ''}
            </div>
          </div>

          {/* Shipment courier & tracking — the international carrier, one line. */}
          <section className="fd-section">
            <div className="fd-section-head">Shipment courier &amp; tracking{editingShip && <em className="panel-opt"> (optional)</em>}</div>
            {editingShip ? (
              <>
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
              </>
            ) : (
              <div className={courierLine ? 'ship-ro' : 'hint'}>{courierLine || 'No courier / tracking set.'}</div>
            )}
          </section>

          {/* Boxes — dimensions / weight / China tracking (pre-fills the Doc Generator CN Packing List). */}
          <section className="fd-section">
            <div className="fd-section-head">Boxes — dimensions &amp; tracking{editingShip && <em className="panel-opt"> (optional)</em>}</div>
            {editingShip ? (
              <>
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
              </>
            ) : (
              savedBoxes.length === 0
                ? <div className="hint">No boxes recorded.</div>
                : <ul className="ship-box-ro">{savedBoxes.map((b, i) => <li key={i}>{boxSummary(b)}</li>)}</ul>
            )}
          </section>

          {/* Items — always read-only */}
          <section className="fd-section">
            <div className="fd-section-head">Items</div>
            {shipItemsLoading && <div className="hint">Loading items…</div>}
            {!shipItemsLoading && shipItems.length === 0 && <div className="hint">No item lines on this shipment.</div>}
            <ul className="po-cards po-cards-compact">
              {shipItems.map((it) => (
                <li key={it.po_id}>
                  {/* PR254 — same card standard as To buy / To forwarder: qty above the cost, SKU centred. */}
                  <div className="po-card po-card-mini po-card-static">
                    <SkuImage status={imgMap[it.item_code ?? '']?.status} displayUrl={imgMap[it.item_code ?? '']?.displayUrl} name={it.name} size={SKU_IMG.sm} />
                    <div className="po-card-main">
                      <span className="ff-code">{it.item_code || '—'}</span>
                      {isRealName(it.name, it.item_code) && <span className="ff-name po-card-name">{it.name}</span>}
                    </div>
                    <div className="po-card-side">
                      <span className="po-card-qty po-card-qty-lg">×{it.qty}</span>
                      {it.item_cost != null && (
                        <div className="po-card-meta">
                          <span className="po-card-date">each {it.item_cost}{it.currency ? ` ${it.currency}` : ''}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* Shipment notes — shown on Inbound receiving. */}
          <section className="fd-section">
            <div className="fd-section-head">Shipment notes</div>
            {editingShip ? (
              <div className="ship-note-edit">
                <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Note for this Ship ID — shown on Inbound receiving" rows={3} disabled={savingNote} />
                <div className="subform-actions">
                  <button className="btn-secondary" onClick={saveNote} disabled={savingNote}>{savingNote ? 'Saving…' : 'Save note'}</button>
                </div>
              </div>
            ) : (
              <div className={openShip.note ? 'ship-note-text' : 'hint'}>{openShip.note || 'No note yet.'}</div>
            )}
          </section>

          {/* Actions — display-only by default: Edit shipment (+ Delete shipment for active). */}
          {delErr && <div className="validation err" style={{ marginTop: 12 }}>{delErr}</div>}
          <div className="fd-actions">
            {editingShip ? (
              <button className="btn-primary" onClick={() => setEditingShip(false)}>Done</button>
            ) : (
              <>
                <button className="btn-brown btn-ico" onClick={enterEdit}><PencilIcon />Edit shipment</button>
                {!openShip.completed && (
                  <button className="btn-danger btn-ico" onClick={() => { setDelErr(null); setConfirmDelShip(true); }}><TrashIcon />Delete shipment</button>
                )}
              </>
            )}
          </div>
        </div>

        {/* delete confirm — ungroups the shipment back to To forwarder */}
        {confirmDelShip && (
          <div className="sc-modal-backdrop" onClick={() => { if (!deletingShip) setConfirmDelShip(false); }}>
            <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Delete shipment" onClick={(e) => e.stopPropagation()}>
              <div className="sc-modal-body">
                <div className="confirm-q">Delete shipment {openShip.ship_id}?</div>
                <div className="hint" style={{ marginBottom: 12 }}>Its {openShip.item_count} {openShip.item_count === 1 ? 'item' : 'items'} go back to To forwarder to be re-grouped. This can’t be undone.</div>
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

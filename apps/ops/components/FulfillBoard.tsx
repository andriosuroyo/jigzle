'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { getToSendQueue, getOrderForFulfill, sendToOutbound, sendBackToPending } from '@/app/fulfill/actions';
import { setLineNote } from '@/app/pending/actions';
import SearchInput from '@/components/SearchInput';
import StatusCircles, { payTone } from '@/components/StatusCircles';
import { fmtNiceDate } from '@jigzle/lib';
import type { FulfillDetail, ToSendQueueRow } from '@/app/fulfill/types';
import type { CourierService, CommonNote, ExportCourier } from '@/app/settings/types';
import IconSelect from '@/components/IconSelect';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import { addressLine } from '@/components/addressLine';
import { useOverlayClose } from '@/components/useOverlayClose';

// PR227 — a note-only editor per item (square pencil, like Pending but note-only: no SKU/qty/delete).
type FulfillLine = FulfillDetail['lines'][number];
const PencilIcon = () => (
  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);
// PR237 — order-id copy chip icons, matching the Pending/History detail header.
const CopyIcon = () => (<svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>);
const CheckIcon = () => (<svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>);
// PR238 — the send actions carry symmetric arrows (→ forward to Outbound, ← back to Pending), matching
// the icon convention used by Pending's "Send ready items" (→) and To-buy's "Done buying".
const arrow = { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const ArrowRightIcon = () => (<svg {...arrow}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>);
const ArrowLeftIcon = () => (<svg {...arrow}><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>);

export default function FulfillBoard({
  initialQueue,
  courierServices,
  exportCouriers = [],
  commonNotes = [],
  initialOrderId,
  userEmail,
  embedded = false,
  onCountChange,
  onAdvance,
  reloadKey = 0,
}: {
  initialQueue: ToSendQueueRow[];
  courierServices: CourierService[];
  exportCouriers?: ExportCourier[]; // PR192 — active export couriers, shown when the ship-to is intl
  commonNotes?: CommonNote[];
  initialOrderId?: string | null;
  userEmail: string;
  // JZ-001: Orders pipeline window — see PendingBoard for the embedded/onCountChange/onAdvance contract.
  embedded?: boolean;
  onCountChange?: (n: number) => void;
  onAdvance?: (salesId: string, toStage: string) => void;
  reloadKey?: number;
}) {
  const [queue, setQueue] = useState<ToSendQueueRow[]>(initialQueue);
  const [search, setSearch] = useState('');

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FulfillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [addressId, setAddressId] = useState<number | null>(null);
  const [courierId, setCourierId] = useState<number | null>(courierServices[0]?.id ?? null);
  const [exportCourierId, setExportCourierId] = useState<number | null>(null); // PR192
  const [tracking, setTracking] = useState('');

  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null); // FT-7: top-level, survives detail clearing
  // PR227 — note-only per-item editor overlay
  const [noteEdit, setNoteEdit] = useState<FulfillLine | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteErr, setNoteErr] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false); // PR237 — order-id copy feedback
  const reqIdRef = useRef(0);

  // FT-1: filter the queue by customer name OR SKU code (client-side over the loaded worklist)
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return queue;
    return queue.filter(
      (r) =>
        (r.customer_name ?? '').toLowerCase().includes(q) ||
        r.sku_codes.some((c) => c.toLowerCase().includes(q))
    );
  }, [queue, search]);

  const imgCodes = useMemo(() => (detail?.lines ?? []).map((l) => l.item_code).filter((c): c is string => !!c), [detail]);
  const imgMap = useSkuImages(imgCodes);

  // PR192: the chosen ship-to is international when its country is set and not Indonesia. Only then does
  // Fulfill require an Export courier (Repack, DHL, …); Outbound later attaches that courier's
  // intermediary address alongside the customer's. Legacy/blank negara counts as domestic.
  const selectedAddress = useMemo(() => detail?.addresses.find((a) => a.address_id === addressId) ?? null, [detail, addressId]);
  const isIntl = useMemo(() => {
    const n = (selectedAddress?.negara ?? '').trim().toLowerCase();
    return n !== '' && n !== 'indonesia';
  }, [selectedAddress]);

  function applyDetail(d: FulfillDetail | null) {
    setDetail(d);
    if (d) {
      setAddressId(d.default_address_id ?? d.addresses[0]?.address_id ?? null);
      setCourierId(courierServices[0]?.id ?? null);
      // PR192: re-prefill the export courier carried back from a Return to Fulfill (match by label),
      // else default to the first active one. Only actually used when the ship-to is international.
      const prev = d.export_courier ? exportCouriers.find((c) => c.label === d.export_courier) : null;
      setExportCourierId(prev?.id ?? exportCouriers[0]?.id ?? null);
      setTracking(d.courier_tracking ?? ''); // re-prefill tracking returned from Outbound
    }
  }

  async function openOrder(salesId: string) {
    const myReq = ++reqIdRef.current;
    setSelected(salesId);
    setDetail(null);
    setError(null);
    setNoteEdit(null);
    setLoadingDetail(true);
    try {
      const d = await getOrderForFulfill(salesId);
      if (reqIdRef.current !== myReq) return; // superseded by a newer selection
      applyDetail(d);
    } catch (e) {
      if (reqIdRef.current !== myReq) return;
      setError(e instanceof Error ? e.message : 'Failed to load order.');
    } finally {
      if (reqIdRef.current === myReq) setLoadingDetail(false);
    }
  }

  // optional ?order= preselect (deep-link). Runs once.
  const didPreselect = useRef(false);
  useEffect(() => {
    if (initialOrderId && !didPreselect.current) {
      didPreselect.current = true;
      openOrder(initialOrderId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOrderId]);

  async function refreshQueue() {
    try { setQueue(await getToSendQueue()); } catch { /* keep current on transient error */ }
  }

  // JZ-001: live count badge + external reload (see PendingBoard).
  useEffect(() => { onCountChange?.(queue.length); }, [queue, onCountChange]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) refreshQueue(); }, [reloadKey]);

  // FT-6: Send to Outbound — set address + courier on the whole cut set (set_fulfillment). The order
  // leaves the To-send queue and appears in Outbound.
  async function sendOut() {
    if (!detail || addressId == null || courierId == null) return;
    const svc = courierServices.find((c) => c.id === courierId) ?? null;
    if (!svc) { setError('Pick a courier.'); return; }
    // PR145: courier rows added via Settings carry only a label (courier column '') — derive the
    // structured pair from the label (first word = base courier, rest = speed) so they still ship.
    // New/edited rows get the same derivation persisted by Settings; this covers pre-fix rows.
    const labelTokens = svc.label.trim().split(/\s+/).filter(Boolean);
    const courierName = (svc.courier || '').trim() || labelTokens[0] || '';
    const courierSpeed = svc.speed ?? ((svc.courier || '').trim() ? null : labelTokens.slice(1).join(' ') || null);
    if (!courierName) { setError('This courier has no name — edit its label in Settings → Shipping → Couriers.'); return; }
    // PR192: an international ship-to must carry an export courier (the field only appears when isIntl).
    const exc = isIntl ? (exportCouriers.find((c) => c.id === exportCourierId) ?? null) : null;
    if (isIntl && !exc) { setError('Pick an export courier for this international shipment.'); return; }
    const myReq = ++reqIdRef.current;
    setCommitting(true);
    setError(null);
    try {
      const { error: sendErr } = await sendToOutbound({
        sales_id: detail.sales_id,
        line_ids: detail.lines.map((l) => l.line_id),
        address_id: addressId,
        courier: courierName,
        courier_speed: courierSpeed,
        courier_label: svc.label,
        tracking: tracking.trim() || null,
        export_courier: exc?.label ?? null, // null for a domestic address
      });
      if (reqIdRef.current !== myReq) return; // superseded — don't clobber a newer selection
      if (sendErr) { setError(sendErr); return; }
      setSuccess(`${detail.sales_id} sent to Outbound (${svc.label}${exc ? ` · export via ${exc.label}` : ''}).`);
      onAdvance?.(detail.sales_id, 'Outbound'); // JZ-001: pipeline toast
      setDetail(null);
      setSelected(null);
      await refreshQueue();
    } catch (e) {
      if (reqIdRef.current === myReq) setError(e instanceof Error ? e.message : 'Send to Outbound failed.');
    } finally {
      setCommitting(false);
    }
  }

  // FT-4: Send back to pending — clear the cut (unfulfill_order); stock restored, order returns uncut.
  async function sendBack() {
    if (!detail) return;
    if (!window.confirm(`Send ${detail.sales_id} back to Pending? The cut is cleared and stock is restored.`)) return;
    const myReq = ++reqIdRef.current;
    setCommitting(true);
    setError(null);
    try {
      const { error: backErr } = await sendBackToPending(detail.sales_id);
      if (reqIdRef.current !== myReq) return;
      if (backErr) { setError(backErr); return; }
      setSuccess(`${detail.sales_id} sent back to Pending.`);
      onAdvance?.(detail.sales_id, 'Pending'); // JZ-001: pipeline toast (moves back a stage)
      setDetail(null);
      setSelected(null);
      await refreshQueue();
    } catch (e) {
      if (reqIdRef.current === myReq) setError(e instanceof Error ? e.message : 'Send back to pending failed.');
    } finally {
      setCommitting(false);
    }
  }

  // PR237 — one-tap copy of the order id (header chip), matching Pending/History.
  async function copyOrderId() {
    if (!detail) return;
    try { await navigator.clipboard.writeText(detail.sales_id); setCopiedId(true); setTimeout(() => setCopiedId(false), 1400); } catch { /* clipboard unavailable */ }
  }

  // PR227 — note-only per-item editor. Opens from the square pencil; saves the line note and reflects it
  // back into the loaded detail (no full refetch). SKU / qty / delete are intentionally not offered here.
  function openNote(l: FulfillLine) { setNoteEdit(l); setNoteDraft(l.line_note ?? ''); setNoteErr(null); }
  function closeNote() { setNoteEdit(null); setNoteErr(null); }
  async function saveNote() {
    if (!noteEdit) return;
    const note = noteDraft.trim() || null;
    setNoteBusy(true); setNoteErr(null);
    try {
      await setLineNote(noteEdit.line_id, note);
      setDetail((d) => (d ? { ...d, lines: d.lines.map((x) => (x.line_id === noteEdit.line_id ? { ...x, line_note: note } : x)) } : d));
      setNoteEdit(null);
    } catch {
      setNoteErr("Couldn't save the note.");
    } finally {
      setNoteBusy(false);
    }
  }

  // PR307 — shared overlay-close for the note editor (unsaved note edits route through a discard confirm).
  const noteClose = useOverlayClose({
    open: !!noteEdit,
    onClose: closeNote,
    dirty: noteDraft.trim() !== (noteEdit?.line_note ?? ''),
  });

  const canSend = !!detail && detail.lines.length > 0 && addressId != null && courierId != null && (!isIntl || exportCourierId != null) && !committing;

  // PR147 — bodyview: the body shows EITHER the full-width To-send queue OR the tapped order's detail
  // with a ← back button (the Purchasing-History pattern); breadcrumb + pipeline tabs stay put above.
  const body = (
    <div className="bodyview">
      {/* FT-7 / FT-8: success + errors render independent of the detail block */}
      {success && <div className="validation ok">{success}</div>}
      {error && <div className="validation err">{error}</div>}

      {/* ── Queue ── */}
      {!selected && (
        <>
          {/* No queue-count header — the Fulfill tab badge above already shows the count. */}
          <div className="search-row" style={{ padding: '0 0 8px' }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search by customer ID or SKU…" />
          </div>
          {shown.length === 0 && <div className="hint fq-empty">{queue.length === 0 ? 'Nothing waiting to send.' : 'No match.'}</div>}
          <ul className="fq-list">
            {shown.map((q) => (
              <li key={q.sales_id}>
                <button className="fq-row" onClick={() => openOrder(q.sales_id)}>
                  {/* PR144 row: customer id + date on top (no sales id); items/SKUs + circles below. */}
                  <div className="fq-row-top">
                    <span className="fq-headline">{q.customer_name || '—'}</span>
                    <span className="ord-date">{fmtNiceDate(q.order_date) || '—'}</span>
                  </div>
                  <div className="fq-row-bot">
                    {/* SKU codes folded into the item count so a SKU search hit is obvious at a glance. */}
                    <span className="ff-items-skus">
                      {q.item_count} {q.item_count === 1 ? 'item' : 'items'}{q.sku_codes.length ? ` (${q.sku_codes.join(', ')})` : ''}
                    </span>
                    {/* PR146: in Fulfill the cut items are ready by definition → box circle is green. */}
                    <StatusCircles box="green" pay={payTone(q.payment_status)} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── Detail ── */}
      {selected && (
        <>
          <button className="btn-link bv-back" onClick={() => { setSelected(null); setDetail(null); setError(null); setNoteEdit(null); }}>← back</button>
          <div className="bv-detail">
          {loadingDetail && <div className="fd-empty">Loading…</div>}
          {!loadingDetail && !detail && <div className="fd-empty">Order not found or already sent.</div>}

          {detail && (
            <>
              {/* PR237 header: customer left, date right; the order id sits just below as a copyable chip
                  — the same style as the Pending / History detail. */}
              <div className="fd-head">
                <div className="fd-head-row">
                  <div className="fd-title fd-title-plain">{detail.customer_name || '—'}</div>
                  {detail.order_date && <span className="fd-date">{fmtNiceDate(detail.order_date)}</span>}
                </div>
                <button className="fd-orderid-chip" onClick={copyOrderId} aria-label={copiedId ? 'Order ID copied' : 'Copy order ID'} title="Copy order ID">
                  <span className="fd-orderid-code">{detail.sales_id}</span>
                  {copiedId ? <CheckIcon /> : <CopyIcon />}
                </button>
              </div>

              {/* Address (FT-6: radio + needs-address flag) */}
              <section className="fd-section">
                <div className="fd-section-head">Ship to<span className="req" aria-hidden="true">*</span></div>
                {detail.addresses.length === 0 && <div className="hint">No saved address for this customer — add one in Sales.</div>}
                <ul className="addr-list">
                  {detail.addresses.map((a) => (
                    <li key={a.address_id}>
                      <label className={`addr-opt ${addressId === a.address_id ? 'active' : ''}`}>
                        <input type="radio" name="ffaddr" checked={addressId === a.address_id} onChange={() => setAddressId(a.address_id)} />
                        <span className="addr-text">{addressLine(a)}{a.raw_address ? <em>{a.raw_address}</em> : null}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Items — SKU/qty are fixed here (decided upstream); the square pencil edits ONLY the note
                  (PR227). Larger image with three lines to its right: code, name, and the note (if any). */}
              <section className="fd-section">
                <div className="fd-section-head">Items</div>
                <ul className="ff-lines">
                  {detail.lines.map((l) => (
                    <li key={l.line_id} className="ff-line pend-line-card">
                      <div className="pend-line">
                        <SkuImage status={imgMap[l.item_code ?? '']?.status} displayUrl={imgMap[l.item_code ?? '']?.displayUrl} name={l.name} size={SKU_IMG.sm} />
                        <div className="pend-line-main">
                          <span className="ff-code">{l.item_code || '—'}</span>
                          <span className="ff-name">{l.name}</span>
                          {l.line_note && <span className="pend-line-note">✎ {l.line_note}</span>}
                        </div>
                        <span className="ff-qty">×{l.qty}</span>
                        <button className="btn-edit" onClick={() => openNote(l)} aria-label="Edit note" title="Edit note"><PencilIcon /></button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Courier (from SETTINGS) + optional tracking */}
              <section className="fd-section fd-courier">
                <div>
                  <label className="fd-label">Courier<span className="req" aria-hidden="true">*</span></label>
                  {courierServices.length === 0 ? (
                    <div className="hint">No couriers configured — add them in Settings.</div>
                  ) : (
                    <IconSelect
                      ariaLabel="Courier"
                      value={courierId}
                      options={courierServices.map((c) => ({ value: c.id, label: c.label, icon: c.icon }))}
                      onChange={setCourierId}
                    />
                  )}
                </div>
                <div>
                  <label className="fd-label">Tracking</label>
                  <input type="text" placeholder="tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} />
                </div>
              </section>

              {/* PR192: Export courier — only for an international ship-to (negara ≠ Indonesia). Repack &
                  co. receive the parcel first at their own address (attached in Outbound); DHL/FedEx
                  pick up locally. Required before sending an international order to Outbound. */}
              {isIntl && (
                <section className="fd-section fd-export">
                  <div className="fd-section-head">Export courier<span className="req" aria-hidden="true">*</span></div>
                  <div className="hint" style={{ marginBottom: 6 }}>Ship-to is outside Indonesia ({selectedAddress?.negara}). Pick the export courier that carries this parcel abroad.</div>
                  {exportCouriers.length === 0 ? (
                    <div className="validation warn">No export couriers configured — add them in Settings → Shipping → Export couriers.</div>
                  ) : (
                    <IconSelect
                      ariaLabel="Export courier"
                      value={exportCourierId}
                      options={exportCouriers.map((c) => ({ value: c.id, label: c.label, icon: c.icon }))}
                      onChange={setExportCourierId}
                    />
                  )}
                </section>
              )}

              {/* Commit bar — Send back (left) · Send to Outbound. No Delete here: an order in Fulfill is
                  already cut/ready; deletion belongs to Pending (PR224). Disabled until address + courier set. */}
              <div className="fd-commit fd-commit-row">
                <button className="btn-brown btn-ico" onClick={sendBack} disabled={committing}><ArrowLeftIcon />Send back to pending</button>
                <button className="btn-primary btn-ico" onClick={sendOut} disabled={!canSend}>
                  <ArrowRightIcon />{committing ? 'Sending…' : 'Send to Outbound'}
                </button>
                {!canSend && !committing && (
                  <span className="warn-text">{addressId == null ? 'pick an address' : courierId == null ? 'pick a courier' : isIntl && exportCourierId == null ? 'pick an export courier' : ''}</span>
                )}
              </div>


              {/* PR227 — note-only per-item editor (no SKU / qty / delete on a cut order). */}
              {noteEdit && (
                <div className="sc-modal-backdrop" onClick={noteBusy ? undefined : noteClose.requestClose}>
                  <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Edit note" onClick={(e) => e.stopPropagation()}>
                    <div className="sc-modal-head sc-modal-head-row">
                      <span className="sc-modal-title">Item note</span>
                      <button className="sc-modal-x" onClick={noteClose.requestClose} aria-label="Close" disabled={noteBusy}>×</button>
                    </div>
                    <div className="sc-modal-body">
                      {noteErr && <div className="validation err" style={{ marginBottom: 10 }}>{noteErr}</div>}
                      <div className="le-sku">
                        <SkuImage status={imgMap[noteEdit.item_code ?? '']?.status} displayUrl={imgMap[noteEdit.item_code ?? '']?.displayUrl} name={noteEdit.name} size={SKU_IMG.sm} />
                        <div className="le-sku-main">
                          <span className="ff-code">{noteEdit.item_code || '—'}</span>
                          <span className="ff-name">{noteEdit.name}</span>
                        </div>
                      </div>
                      <div className="le-field le-note">
                        <label>Note</label>
                        <input type="text" list="ff-notes" placeholder="Add a note…" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} disabled={noteBusy} autoComplete="off" />
                        <datalist id="ff-notes">{commonNotes.map((n) => <option key={n.id} value={n.label} />)}</datalist>
                      </div>
                    </div>
                    <div className="sc-modal-foot le-foot">
                      <button className="btn-primary" onClick={saveNote} disabled={noteBusy}>{noteBusy ? 'Saving…' : 'Save'}</button>
                    </div>
                  </div>
                  {noteClose.confirm}
                </div>
              )}
            </>
          )}
          </div>
        </>
      )}
    </div>
  );

  if (embedded) return body;
  return (
    <div className="ops">
      <AppHeader active="orders" userEmail={userEmail} />
      {body}
    </div>
  );
}

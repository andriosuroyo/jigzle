'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { getToSendQueue, getOrderForFulfill, sendToOutbound, sendBackToPending } from '@/app/fulfill/actions';
import { deletePendingOrder } from '@/app/pending/actions';
import SearchInput from '@/components/SearchInput';
import type { FulfillDetail, ToSendQueueRow } from '@/app/fulfill/types';
import type { CourierService, CommonNote } from '@/app/settings/types';
import NoteEditor from '@/components/NoteEditor';
import IconSelect from '@/components/IconSelect';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import { addressLine } from '@/components/addressLine';

export default function FulfillBoard({
  initialQueue,
  courierServices,
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
  const [tracking, setTracking] = useState('');

  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null); // FT-7: top-level, survives detail clearing
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

  function applyDetail(d: FulfillDetail | null) {
    setDetail(d);
    if (d) {
      setAddressId(d.default_address_id ?? d.addresses[0]?.address_id ?? null);
      setCourierId(courierServices[0]?.id ?? null);
      setTracking(d.courier_tracking ?? ''); // re-prefill tracking returned from Outbound
    }
  }

  async function openOrder(salesId: string) {
    const myReq = ++reqIdRef.current;
    setSelected(salesId);
    setDetail(null);
    setError(null);
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
    const myReq = ++reqIdRef.current;
    setCommitting(true);
    setError(null);
    try {
      await sendToOutbound({
        sales_id: detail.sales_id,
        line_ids: detail.lines.map((l) => l.line_id),
        address_id: addressId,
        courier: svc.courier,
        courier_speed: svc.speed,
        courier_label: svc.label,
        tracking: tracking.trim() || null,
      });
      if (reqIdRef.current !== myReq) return; // superseded — don't clobber a newer selection
      setSuccess(`${detail.sales_id} sent to Outbound (${svc.label}).`);
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
      await sendBackToPending(detail.sales_id);
      if (reqIdRef.current !== myReq) return;
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

  // PR144: delete from Fulfill — clear the cut first (unfulfill_order restores stock), then hard-delete
  // via the same guarded RPC Pending uses. If the delete step fails (e.g. the order has already-shipped
  // lines), the order is back in Pending uncut — recoverable, and the error says so.
  async function doDelete() {
    if (!detail) return;
    const warn = `Delete ${detail.sales_id}? Its cut is cleared (stock restored) and the order + its payments are permanently removed. Continue?`;
    if (!window.confirm(warn)) return;
    const myReq = ++reqIdRef.current;
    setCommitting(true);
    setError(null);
    try {
      await sendBackToPending(detail.sales_id);
      try {
        await deletePendingOrder(detail.sales_id);
      } catch (e) {
        throw new Error(
          `${e instanceof Error ? e.message : 'Delete failed.'} — ${detail.sales_id} was returned to Pending, not deleted.`
        );
      }
      if (reqIdRef.current !== myReq) return;
      setSuccess(`${detail.sales_id} deleted.`);
      setDetail(null);
      setSelected(null);
      await refreshQueue();
    } catch (e) {
      if (reqIdRef.current === myReq) setError(e instanceof Error ? e.message : 'Delete failed.');
      await refreshQueue();
    } finally {
      setCommitting(false);
    }
  }

  const canSend = !!detail && detail.lines.length > 0 && addressId != null && courierId != null && !committing;

  const body = (
    <>
      <div className="fulfill-layout">
        {/* ── Queue ── */}
        <aside className="fq-pane">
          {/* No queue-count header — the Fulfill tab badge above already shows the count. */}
          <div className="search-row" style={{ padding: '8px' }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search customer or SKU…" />
          </div>
          {shown.length === 0 && <div className="hint fq-empty">{queue.length === 0 ? 'Nothing waiting to send.' : 'No match.'}</div>}
          <ul className="fq-list">
            {shown.map((q) => (
              <li key={q.sales_id}>
                <button className={`fq-row ${selected === q.sales_id ? 'active' : ''}`} onClick={() => openOrder(q.sales_id)}>
                  {/* PR144 row: customer id + date on top (no sales id); items/SKUs + pay pill below. */}
                  <div className="fq-row-top">
                    <span className="fq-headline">{q.customer_name || '—'}</span>
                    <span className="ord-date">{q.order_date ? q.order_date.slice(0, 10) : '—'}</span>
                  </div>
                  <div className="fq-row-bot">
                    {/* SKU codes folded into the item count so a SKU search hit is obvious at a glance. */}
                    <span className="ff-items-skus">
                      {q.item_count} {q.item_count === 1 ? 'item' : 'items'}{q.sku_codes.length ? ` (${q.sku_codes.join(', ')})` : ''}
                    </span>
                    {q.payment_status && <span className={`pay pay-${q.payment_status.toLowerCase()}`}>{q.payment_status}</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* ── Detail ── */}
        <main className="fd-pane">
          {/* FT-7 / FT-8: success + errors render independent of the detail block */}
          {success && <div className="validation ok">{success}</div>}
          {error && <div className="validation err">{error}</div>}

          {!selected && !success && <div className="fd-empty">Select an order to confirm its address + courier.</div>}
          {selected && loadingDetail && <div className="fd-empty">Loading…</div>}
          {selected && !loadingDetail && !detail && <div className="fd-empty">Order not found or already sent.</div>}

          {detail && (
            <>
              {/* PR144 header: customer id left, order date right; the sales id moved to the bottom. */}
              <div className="fd-head">
                <div className="fd-head-row">
                  <div className="fd-title fd-title-plain">{detail.customer_name || '—'}</div>
                  {detail.order_date && <span className="fd-date">{detail.order_date.slice(0, 10)}</span>}
                </div>
              </div>

              {/* Address (FT-6: radio + needs-address flag) */}
              <section className="fd-section">
                <div className="fd-section-head">Ship to</div>
                {detail.needs_address && (
                  <div className="validation warn">Needs address — pick one before sending to Outbound.</div>
                )}
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

              {/* Items — read-only (the whole cut set ships; partial was decided upstream). Same compact
                  row as the Pending detail. */}
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
                        </div>
                        <span className="ff-qty">×{l.qty}</span>
                      </div>
                      <NoteEditor
                        lineId={l.line_id}
                        value={l.line_note}
                        commonNotes={commonNotes}
                        onSaved={(note) =>
                          setDetail((d) =>
                            d ? { ...d, lines: d.lines.map((x) => (x.line_id === l.line_id ? { ...x, line_note: note } : x)) } : d
                          )
                        }
                      />
                    </li>
                  ))}
                </ul>
              </section>

              {/* Courier (from SETTINGS) + optional tracking */}
              <section className="fd-section fd-courier">
                <div>
                  <label className="fd-label">Courier</label>
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
                  <label className="fd-label">Tracking <em>(optional)</em></label>
                  <input type="text" placeholder="tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} />
                </div>
              </section>

              {/* Commit bar — disabled until address + courier set (the Outbound gate) */}
              <div className="fd-commit">
                {!canSend && !committing && (
                  <span className="warn-text">{addressId == null ? 'pick an address' : courierId == null ? 'pick a courier' : ''}</span>
                )}
                <button className="btn-primary" onClick={sendOut} disabled={!canSend}>
                  {committing ? 'Sending…' : 'Send to Outbound'}
                </button>
              </div>

              {/* Send back to pending + delete — bottom, left-aligned (like Pending's delete row). */}
              <div className="ob-return">
                <button className="btn-link" onClick={sendBack} disabled={committing}>↩ Send back to pending</button>
                <button className="btn-link pend-delete" onClick={doDelete} disabled={committing}>Delete order</button>
              </div>

              <div className="fd-orderid">{detail.sales_id}</div>
            </>
          )}
        </main>
      </div>
    </>
  );

  if (embedded) return body;
  return (
    <div className="ops">
      <AppHeader active="orders" userEmail={userEmail} />
      {body}
    </div>
  );
}

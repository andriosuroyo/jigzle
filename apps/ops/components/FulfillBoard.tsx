'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import type { FulfillQueueRow } from '@jigzle/db/types';
import { getFulfillQueue, getOrderForFulfill, fulfillOrder } from '@/app/fulfill/actions';
import type { FulfillDetail, FulfillResult } from '@/app/fulfill/types';
import type { CourierService } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

export default function FulfillBoard({
  initialQueue,
  courierServices,
  initialOrderId,
  userEmail,
}: {
  initialQueue: FulfillQueueRow[];
  courierServices: CourierService[];
  initialOrderId?: string | null;
  userEmail: string;
}) {
  const [queue, setQueue] = useState<FulfillQueueRow[]>(initialQueue);
  const [readyOnly, setReadyOnly] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FulfillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [checkedLines, setCheckedLines] = useState<Set<string>>(new Set());
  const [addressId, setAddressId] = useState<number | null>(null);
  const [courierId, setCourierId] = useState<number | null>(courierServices[0]?.id ?? null);
  const [tracking, setTracking] = useState('');

  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(FulfillResult & { units: number }) | null>(null);

  // Latest-wins guard: every detail load/reload bumps this; an awaited response only applies if it
  // is still the most recent request, so a slow fetch can't overwrite a newer selection.
  const reqIdRef = useRef(0);

  const shown = readyOnly ? queue.filter((q) => q.ready) : queue;

  // Which active holds will actually auto-release: only those on CHECKED lines, and only up to the
  // fulfilled qty per item_code (oldest-first) — mirrors the RPC's per-item budget cap.
  const willReleaseHoldIds = useMemo(() => {
    const ids = new Set<number>();
    if (!detail) return ids;
    const budget = new Map<string, number>();
    for (const l of detail.lines) {
      if (l.item_code && checkedLines.has(l.line_id)) budget.set(l.item_code, (budget.get(l.item_code) ?? 0) + l.qty);
    }
    const byCode = new Map<string, FulfillDetail['holds']>();
    for (const h of detail.holds) {
      if (!h.item_code) continue;
      const arr = byCode.get(h.item_code);
      if (arr) arr.push(h);
      else byCode.set(h.item_code, [h]);
    }
    for (const [code, holds] of byCode) {
      let b = budget.get(code) ?? 0;
      const ordered = [...holds].sort((a, z) =>
        a.created_at < z.created_at ? -1 : a.created_at > z.created_at ? 1 : a.hold_id - z.hold_id
      );
      for (const h of ordered) {
        if (h.qty <= b) { ids.add(h.hold_id); b -= h.qty; }
      }
    }
    return ids;
  }, [detail, checkedLines]);

  // SKU images for the pick-list lines — high value: the picker grabs the right box off the shelf.
  const imgCodes = useMemo(() => (detail?.lines ?? []).map((l) => l.item_code).filter(Boolean) as string[], [detail]);
  const imgMap = useSkuImages(imgCodes);

  async function refreshQueue() {
    try {
      setQueue(await getFulfillQueue(false));
    } catch {
      /* keep current queue on transient error */
    }
  }

  function applyDetail(d: FulfillDetail | null) {
    setDetail(d);
    if (d) {
      // default-check lines that are in stock; default address to the order's address
      setCheckedLines(new Set(d.lines.filter((l) => l.available >= l.qty).map((l) => l.line_id)));
      setAddressId(d.default_address_id ?? d.addresses[0]?.address_id ?? null);
      setCourierId(courierServices[0]?.id ?? null);
      setTracking('');
    }
  }

  async function openOrder(salesId: string) {
    const myReq = ++reqIdRef.current;
    setSelected(salesId);
    setDetail(null);
    setResult(null);
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

  // PR27: preselect an order when arriving from /orders (?order=…). Runs once.
  const didPreselect = useRef(false);
  useEffect(() => {
    if (initialOrderId && !didPreselect.current) {
      didPreselect.current = true;
      openOrder(initialOrderId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOrderId]);

  function toggleLine(lineId: string) {
    setCheckedLines((prev) => {
      const next = new Set(prev);
      next.has(lineId) ? next.delete(lineId) : next.add(lineId);
      return next;
    });
  }

  const selectedLines = detail?.lines.filter((l) => checkedLines.has(l.line_id)) ?? [];
  const unitsCommitting = selectedLines.reduce((s, l) => s + l.qty, 0);
  const goNegativeCount = selectedLines.filter((l) => l.available - l.qty < 0).length;

  // F5 per-line status: in stock → available {n}; short but incoming covers it → on the way ×{n};
  // else → short {n}.
  function lineStatus(l: FulfillDetail['lines'][number]): { text: string; cls: string } {
    if (l.available >= l.qty) return { text: `available ${l.available}`, cls: 'ok' };
    if (l.available + l.on_the_way >= l.qty) return { text: `on the way ×${l.on_the_way}`, cls: 'otw' };
    return { text: `short ${l.qty - l.available}`, cls: 'short' };
  }

  async function commit() {
    if (!detail || selectedLines.length === 0 || addressId == null) return;
    setCommitting(true);
    setError(null);
    try {
      const svc = courierServices.find((c) => c.id === courierId) ?? null;
      const res = await fulfillOrder({
        sales_id: detail.sales_id,
        line_ids: selectedLines.map((l) => l.line_id),
        address_id: addressId,
        courier: svc?.courier ?? null,
        courier_speed: svc?.speed ?? null,
        courier_label: svc?.label ?? null,
        tracking: tracking.trim() || null,
      });
      setResult({ ...res, units: unitsCommitting });
      // reload the detail — remaining (short) lines stay; if none left, drop the order. Guard with
      // the request token so a mid-flight switch to another order isn't clobbered.
      const myReq = ++reqIdRef.current;
      const d = await getOrderForFulfill(detail.sales_id);
      if (reqIdRef.current === myReq) {
        if (!d || d.lines.length === 0) {
          setDetail(null);
          setSelected(null);
        } else {
          applyDetail(d);
        }
      }
      await refreshQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fulfill failed.');
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="ops">
      <AppHeader active="fulfill" userEmail={userEmail} />

      <div className="fulfill-layout">
        {/* ── Queue ── */}
        <aside className="fq-pane">
          <div className="fq-head">
            {/* F3: full group total — every order, ready and short (not the readyOnly-filtered count) */}
            <span>Fulfill queue: {queue.length}</span>
            <label className="fq-filter">
              <input type="checkbox" checked={readyOnly} onChange={(e) => setReadyOnly(e.target.checked)} />
              ready only
            </label>
          </div>
          {shown.length === 0 && <div className="hint fq-empty">Nothing waiting to fulfill.</div>}
          <ul className="fq-list">
            {shown.map((q) => (
              <li key={q.sales_id}>
                <button
                  className={`fq-row ${selected === q.sales_id ? 'active' : ''}`}
                  onClick={() => openOrder(q.sales_id)}
                >
                  <div className="fq-row-top">
                    <span className="fq-id">{q.sales_id}</span>
                    <span className="fq-cust">{q.customer_name || '—'}</span>
                  </div>
                  <div className="fq-row-bot">
                    <span>{q.line_count} {q.line_count === 1 ? 'item' : 'items'}</span>
                    <span className={`pay pay-${(q.payment_status || '').toLowerCase()}`}>{q.payment_status || '—'}</span>
                    {q.ready ? (
                      <span className="badge ready">✅ ready</span>
                    ) : (
                      <span className="badge short">⚠ {q.short_count} short</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* ── Detail ── */}
        <main className="fd-pane">
          {!selected && <div className="fd-empty">Select an order from the queue to fulfill.</div>}
          {selected && loadingDetail && <div className="fd-empty">Loading…</div>}
          {selected && !loadingDetail && !detail && <div className="fd-empty">Order not found or fully fulfilled.</div>}

          {detail && (
            <>
              <div className="fd-head">
                <div className="fd-title">{detail.sales_id}</div>
                <div className="fd-sub">
                  {detail.customer_name || '—'} · {detail.customer_phone || '—'}
                  {detail.payment_status && (
                    <span className={`pay pay-${detail.payment_status.toLowerCase()}`}>{detail.payment_status}</span>
                  )}
                </div>
                {detail.payment_status && detail.payment_status !== 'Paid' && (
                  <div className="validation warn">Payment is {detail.payment_status} — fulfilling anyway (override).</div>
                )}
              </div>

              {error && <div className="validation err">{error}</div>}
              {result && (
                <div className="validation ok">
                  Committed {result.units} unit{result.units === 1 ? '' : 's'}.{' '}
                  {result.stock.map((s) => `${s.item_code}: avail ${s.available}, reserved ${s.reserved}`).join(' · ')}
                </div>
              )}

              {/* Address */}
              <section className="fd-section">
                <div className="fd-section-head">Ship to</div>
                {detail.addresses.length === 0 && <div className="hint">No saved address for this customer.</div>}
                <ul className="addr-list">
                  {detail.addresses.map((a) => (
                    <li key={a.address_id}>
                      <label className={`addr-opt ${addressId === a.address_id ? 'active' : ''}`}>
                        <input type="radio" name="ffaddr" checked={addressId === a.address_id} onChange={() => setAddressId(a.address_id)} />
                        <span className="addr-text">
                          {a.recipient_name || a.address_label || `Address #${a.address_id}`}
                          {a.raw_address ? <em>{a.raw_address}</em> : null}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Items (F2: "items" not "lines") */}
              <section className="fd-section">
                <div className="fd-section-head">Items</div>
                <ul className="ff-lines">
                  {detail.lines.map((l) => {
                    const st = lineStatus(l);
                    const short = l.available < l.qty;
                    const lineHolds = detail.holds.filter((h) => h.item_code === l.item_code);
                    return (
                      <li key={l.line_id} className="ff-line">
                        {/* F5: checkbox · big image · 3 stacked rows (code / name / qty — status) */}
                        <label className="ff-line-main ff-card">
                          <input type="checkbox" checked={checkedLines.has(l.line_id)} onChange={() => toggleLine(l.line_id)} />
                          <SkuImage status={imgMap[l.item_code ?? '']?.status} displayUrl={imgMap[l.item_code ?? '']?.displayUrl} name={l.name} size={SKU_IMG.md} />
                          <div className="ff-card-info">
                            <div className="ff-card-code">{l.item_code || '—'}</div>
                            <div className="ff-card-name">{l.name}</div>
                            <div className="ff-card-status">
                              ×{l.qty} — <span className={`ff-status ${st.cls}`}>{st.text}</span>
                            </div>
                          </div>
                        </label>
                        {short && st.cls === 'short' && (
                          <div className="low-warn">Fulfilling will take available to {l.available - l.qty} (allowed)</div>
                        )}
                        {lineHolds.map((h) => {
                          const willRelease = willReleaseHoldIds.has(h.hold_id);
                          return (
                            <div key={h.hold_id} className={`hold-note ${willRelease ? '' : 'hold-note-muted'}`}>
                              ⚠ hold #{h.hold_id} (×{h.qty}{h.note ? `, ${h.note}` : ''}) →{' '}
                              {willRelease
                                ? 'will auto-release on fulfill'
                                : 'will NOT release (line unchecked or exceeds fulfilled qty)'}
                            </div>
                          );
                        })}
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Courier (from SETTINGS) + tracking */}
              <section className="fd-section fd-courier">
                <div>
                  <label className="fd-label">Courier</label>
                  {courierServices.length === 0 ? (
                    <div className="hint">No couriers configured — add them in Settings.</div>
                  ) : (
                    <select value={courierId ?? ''} onChange={(e) => setCourierId(e.target.value ? Number(e.target.value) : null)}>
                      {courierServices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                  )}
                </div>
                <div>
                  <label className="fd-label">Tracking <em>(optional)</em></label>
                  <input type="text" placeholder="tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} />
                </div>
              </section>

              {/* Commit bar (F6: button = "Fulfill N units"; compact go-negative warning only when > 0) */}
              <div className="fd-commit">
                {goNegativeCount > 0 && (
                  <span className="warn-text">⚠ {goNegativeCount} item{goNegativeCount === 1 ? '' : 's'} go negative</span>
                )}
                <button
                  className="btn-primary"
                  onClick={commit}
                  disabled={committing || selectedLines.length === 0 || addressId == null}
                >
                  {committing ? 'Fulfilling…' : `Fulfill ${unitsCommitting} unit${unitsCommitting === 1 ? '' : 's'}`}
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

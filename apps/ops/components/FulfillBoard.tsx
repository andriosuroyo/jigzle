'use client';

import { useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import type { FulfillQueueRow } from '@jigzle/db/types';
import { getFulfillQueue, getOrderForFulfill, fulfillOrder } from '@/app/fulfill/actions';
import type { FulfillDetail, FulfillResult } from '@/app/fulfill/types';

const COURIERS = ['JNE', 'J&T', 'SiCepat', 'AnterAja', 'Ninja Xpress', 'POS Indonesia', 'TIKI', 'GoSend', 'GrabExpress', 'Lion Parcel', 'ID Express', 'Other'];

export default function FulfillBoard({
  initialQueue,
  userEmail,
}: {
  initialQueue: FulfillQueueRow[];
  userEmail: string;
}) {
  const [queue, setQueue] = useState<FulfillQueueRow[]>(initialQueue);
  const [readyOnly, setReadyOnly] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FulfillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [checkedLines, setCheckedLines] = useState<Set<string>>(new Set());
  const [addressId, setAddressId] = useState<number | null>(null);
  const [courier, setCourier] = useState(COURIERS[0]);
  const [tracking, setTracking] = useState('');

  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(FulfillResult & { units: number }) | null>(null);

  // Latest-wins guard: every detail load/reload bumps this; an awaited response only applies
  // if it is still the most recent request, so a slow fetch can't overwrite a newer selection.
  const reqIdRef = useRef(0);

  const shown = readyOnly ? queue.filter((q) => q.ready) : queue;

  // Which active holds will actually auto-release: only those on CHECKED lines, and only up to
  // the fulfilled qty per item_code (oldest-first) — mirrors the RPC's per-item budget cap so
  // the UI never over-promises a release the RPC won't perform.
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
      setCourier(COURIERS[0]);
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

  async function commit() {
    if (!detail || selectedLines.length === 0 || addressId == null) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await fulfillOrder({
        sales_id: detail.sales_id,
        line_ids: selectedLines.map((l) => l.line_id),
        address_id: addressId,
        courier,
        tracking: tracking.trim() || null,
      });
      setResult({ ...res, units: unitsCommitting });
      // reload the detail — remaining (short) lines stay; if none left, drop the order.
      // Guard with the request token so a mid-flight switch to another order isn't clobbered.
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
            <span>Fulfill queue</span>
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
                    <span>{q.line_count} {q.line_count === 1 ? 'line' : 'lines'}</span>
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

              {/* Lines */}
              <section className="fd-section">
                <div className="fd-section-head">Lines</div>
                <ul className="ff-lines">
                  {detail.lines.map((l) => {
                    const short = l.available < l.qty;
                    const lineHolds = detail.holds.filter((h) => h.item_code === l.item_code);
                    return (
                      <li key={l.line_id} className="ff-line">
                        <label className="ff-line-main">
                          <input type="checkbox" checked={checkedLines.has(l.line_id)} onChange={() => toggleLine(l.line_id)} />
                          <span className="ff-code">{l.item_code || '—'}</span>
                          <span className="ff-name">{l.name}</span>
                          <span className="ff-qty">×{l.qty}</span>
                          <span className={`ff-avail ${short ? 'low' : ''}`}>avail {l.available}</span>
                        </label>
                        {short && <div className="low-warn">Short {l.qty - l.available} — fulfilling will take available to {l.available - l.qty} (allowed)</div>}
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

              {/* Courier */}
              <section className="fd-section fd-courier">
                <div>
                  <label className="fd-label">Courier</label>
                  <select value={courier} onChange={(e) => setCourier(e.target.value)}>
                    {COURIERS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="fd-label">Tracking <em>(optional)</em></label>
                  <input type="text" placeholder="tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} />
                </div>
              </section>

              {/* Commit bar */}
              <div className="fd-commit">
                <div className="fd-commit-info">
                  Σ committing <b>{unitsCommitting}</b> unit{unitsCommitting === 1 ? '' : 's'} ·{' '}
                  {goNegativeCount === 0 ? (
                    <span className="ok-text">available after: ok</span>
                  ) : (
                    <span className="warn-text">⚠ {goNegativeCount} line{goNegativeCount === 1 ? '' : 's'} go negative</span>
                  )}
                </div>
                <button
                  className="btn-primary"
                  onClick={commit}
                  disabled={committing || selectedLines.length === 0 || addressId == null}
                >
                  {committing ? 'Fulfilling…' : `Fulfill selected line${selectedLines.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

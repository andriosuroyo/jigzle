'use client';

import { useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { volWeight, chargeable } from '@jigzle/lib';
import type { ShipQueueRow } from '@jigzle/db/types';
import { getShipQueue, getOrderForShip, recordShipment } from '@/app/outbound/actions';
import type { ShipDetail, ShipResult } from '@/app/outbound/types';

const COURIERS = ['JNE', 'J&T', 'SiCepat', 'AnterAja', 'Ninja Xpress', 'POS Indonesia', 'TIKI', 'GoSend', 'GrabExpress', 'Lion Parcel', 'ID Express', 'Other'];

type BoxDraft = { key: number; real: string; p: string; l: string; t: string; vol: boolean };

let boxKeySeq = 1;
const newBox = (): BoxDraft => ({ key: boxKeySeq++, real: '', p: '', l: '', t: '', vol: false });
const numOrNull = (s: string): number | null => {
  const n = parseFloat(s);
  return s.trim() && isFinite(n) ? n : null;
};

export default function OutboundBoard({
  initialQueue,
  userEmail,
}: {
  initialQueue: ShipQueueRow[];
  userEmail: string;
}) {
  const [queue, setQueue] = useState<ShipQueueRow[]>(initialQueue);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShipDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const reqIdRef = useRef(0);

  const [checkedLines, setCheckedLines] = useState<Set<string>>(new Set());
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [courier, setCourier] = useState(COURIERS[0]);
  const [tracking, setTracking] = useState('');
  const [boxes, setBoxes] = useState<BoxDraft[]>([newBox()]);

  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(ShipResult & { units: number; completed: boolean }) | null>(null);

  // barcode → item_code, for optional scan resolution
  const barcodeMap = useMemo(() => {
    const m = new Map<string, string>();
    detail?.barcodes.forEach((b) => m.set(b.barcode, b.item_code));
    return m;
  }, [detail]);

  function applyDetail(d: ShipDetail | null) {
    setDetail(d);
    if (d) {
      setCheckedLines(new Set(d.lines.map((l) => l.line_id))); // default: ship all
      setCourier(d.planned_courier && COURIERS.includes(d.planned_courier) ? d.planned_courier : COURIERS[0]);
      setTracking('');
      setBoxes([newBox()]);
      setScan('');
      setScanMsg(null);
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
      const d = await getOrderForShip(salesId);
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

  function doScan() {
    const code = scan.trim();
    if (!code || !detail) return;
    const item = barcodeMap.get(code);
    const hits = item ? detail.lines.filter((l) => l.item_code === item) : [];
    if (hits.length) {
      setCheckedLines((prev) => {
        const next = new Set(prev);
        hits.forEach((l) => next.add(l.line_id));
        return next;
      });
      setScanMsg(`✓ ${item} checked`);
    } else {
      setScanMsg(`no line for barcode ${code}`);
    }
    setScan('');
  }

  const selectedLines = detail?.lines.filter((l) => checkedLines.has(l.line_id)) ?? [];
  const unitsShipping = selectedLines.reduce((s, l) => s + l.qty, 0);
  // the order reaches Complete iff every fulfilled-unshipped line is going AND nothing is still
  // awaiting fulfill (mirrors the RPC's "no unshipped non-cancelled line remains").
  const willComplete =
    !!detail &&
    detail.lines.length > 0 &&
    selectedLines.length === detail.lines.length &&
    detail.pending_fulfill_count === 0;

  function setBox(key: number, patch: Partial<BoxDraft>) {
    setBoxes((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }
  function boxPreview(b: BoxDraft): { vol: number | null; charge: number | null } {
    const real = numOrNull(b.real);
    const p = numOrNull(b.p), l = numOrNull(b.l), t = numOrNull(b.t);
    const vol = p != null && l != null && t != null ? volWeight(p, l, t) : null;
    const charge = vol != null ? chargeable(real ?? 0, vol) : real;
    return { vol, charge };
  }

  async function commit() {
    if (!detail || selectedLines.length === 0) return;
    setCommitting(true);
    setError(null);
    try {
      const willCompleteNow = willComplete;
      const res = await recordShipment({
        sales_id: detail.sales_id,
        line_ids: selectedLines.map((l) => l.line_id),
        courier,
        tracking: tracking.trim() || null,
        boxes: boxes
          .filter((b) => b.real.trim() || b.p.trim() || b.l.trim() || b.t.trim())
          .map((b) => ({
            real_weight: numOrNull(b.real),
            dim_p: numOrNull(b.p),
            dim_l: numOrNull(b.l),
            dim_t: numOrNull(b.t),
            bill_by_volume: b.vol,
          })),
      });
      // The RPC ships only still-eligible lines (returns the affected item_codes). If nothing
      // shipped (e.g. already shipped in another tab), don't show a false "shipped/Complete".
      if (res.affected.length === 0) {
        setError('Those lines were already shipped — nothing to do.');
      } else {
        setResult({ ...res, units: unitsShipping, completed: willCompleteNow });
      }
      // reload — remaining fulfilled-unshipped lines stay; if none, drop the order from the queue
      const myReq = ++reqIdRef.current;
      const d = await getOrderForShip(detail.sales_id);
      if (reqIdRef.current === myReq) {
        if (!d || d.lines.length === 0) {
          setDetail(null);
          setSelected(null);
        } else {
          applyDetail(d);
        }
      }
      try {
        setQueue(await getShipQueue());
      } catch {
        /* keep current queue on transient error */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ship failed.');
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="ops">
      <AppHeader active="outbound" userEmail={userEmail} />

      <div className="fulfill-layout">
        {/* ── Queue ── */}
        <aside className="fq-pane">
          <div className="fq-head"><span>Ready to ship</span></div>
          {queue.length === 0 && <div className="hint fq-empty">Nothing fulfilled and waiting to ship.</div>}
          <ul className="fq-list">
            {queue.map((q) => (
              <li key={q.sales_id}>
                <button className={`fq-row ${selected === q.sales_id ? 'active' : ''}`} onClick={() => openOrder(q.sales_id)}>
                  <div className="fq-row-top">
                    <span className="fq-id">{q.sales_id}</span>
                    <span className="fq-cust">{q.customer_name || '—'}</span>
                  </div>
                  <div className="fq-row-bot">
                    <span>{q.ready_count} {q.ready_count === 1 ? 'line' : 'lines'}</span>
                    <span className="badge ready" style={{ marginLeft: 'auto' }}>{q.planned_courier || '—'}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* ── Detail ── */}
        <main className="fd-pane">
          {!selected && <div className="fd-empty">Select an order from the queue to ship.</div>}
          {selected && loadingDetail && <div className="fd-empty">Loading…</div>}
          {selected && !loadingDetail && !detail && <div className="fd-empty">Order not found or nothing left to ship.</div>}

          {detail && (
            <>
              <div className="fd-head">
                <div className="fd-title">{detail.sales_id} → {detail.customer_name || '—'}</div>
                {detail.ship_address && <div className="fd-sub">{detail.ship_address}</div>}
              </div>

              {error && <div className="validation err">{error}</div>}
              {result && (
                <div className="validation ok">
                  Shipped {result.units} unit{result.units === 1 ? '' : 's'}.{' '}
                  {result.completed ? 'Order → Complete. ' : ''}
                  {result.stock.map((s) => `${s.item_code}: physical ${s.physical}, reserved ${s.reserved}`).join(' · ')}
                </div>
              )}

              {/* Items */}
              <section className="fd-section">
                <div className="fd-section-head">Items (fulfilled, not shipped)</div>
                <div className="scan-row">
                  <input
                    type="text"
                    placeholder="scan / type a barcode (optional)"
                    value={scan}
                    onChange={(e) => setScan(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doScan(); } }}
                  />
                  <button className="btn-secondary" onClick={doScan}>check</button>
                  {scanMsg && <span className="scan-msg">{scanMsg}</span>}
                </div>
                <ul className="ff-lines">
                  {detail.lines.map((l) => (
                    <li key={l.line_id} className="ff-line">
                      <label className="ff-line-main">
                        <input type="checkbox" checked={checkedLines.has(l.line_id)} onChange={() => toggleLine(l.line_id)} />
                        <span className="ff-code">{l.item_code || '—'}</span>
                        <span className="ff-name">{l.name}</span>
                        <span className="ff-qty">×{l.qty}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Boxes */}
              <section className="fd-section">
                <div className="fd-section-head">Boxes</div>
                <ul className="box-list">
                  {boxes.map((b, i) => {
                    const { vol, charge } = boxPreview(b);
                    return (
                      <li key={b.key} className="box-row">
                        <div className="box-line">
                          <span className="box-n">Box {i + 1}</span>
                          <input className="box-real" type="number" min={0} placeholder="real (g)" value={b.real} onChange={(e) => setBox(b.key, { real: e.target.value })} />
                          <input className="box-dim" type="number" min={0} placeholder="P" value={b.p} onChange={(e) => setBox(b.key, { p: e.target.value })} />
                          <input className="box-dim" type="number" min={0} placeholder="L" value={b.l} onChange={(e) => setBox(b.key, { l: e.target.value })} />
                          <input className="box-dim" type="number" min={0} placeholder="T" value={b.t} onChange={(e) => setBox(b.key, { t: e.target.value })} />
                          {boxes.length > 1 && <button className="li-remove" onClick={() => setBoxes((prev) => prev.filter((x) => x.key !== b.key))} aria-label="remove box">×</button>}
                        </div>
                        <div className="box-preview">
                          <label><input type="checkbox" checked={b.vol} onChange={(e) => setBox(b.key, { vol: e.target.checked })} /> bill by volume</label>
                          <span>vol {vol != null ? vol.toFixed(2) : '—'} · chargeable {charge != null ? charge.toFixed(2) : '—'}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <button className="btn-secondary" onClick={() => setBoxes((prev) => [...prev, newBox()])}>+ box</button>
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
                  <label className="fd-label">Tracking</label>
                  <input type="text" placeholder="tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} />
                </div>
              </section>

              {/* Commit bar */}
              <div className="fd-commit">
                <div className="fd-commit-info">
                  Σ shipping <b>{unitsShipping}</b> unit{unitsShipping === 1 ? '' : 's'} ·{' '}
                  {willComplete ? <span className="ok-text">order will → Complete</span> : <span className="warn-text">order stays open</span>}
                </div>
                <button className="btn-primary" onClick={commit} disabled={committing || selectedLines.length === 0}>
                  {committing ? 'Shipping…' : 'Mark shipped'}
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { volWeight, chargeable } from '@jigzle/lib';
import type { ShipQueueRow } from '@jigzle/db/types';
import { getShipQueue, getOrderForShip, recordShipment, returnToFulfill } from '@/app/outbound/actions';
import type { ShipDetail, ShipResult } from '@/app/outbound/types';
import type { BoxPreset } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

// preset = a box-preset code (dims from SETTINGS) or 'Custom' (manual P/L/T).
type BoxDraft = { key: number; preset: string; real: string; p: string; l: string; t: string };
const CUSTOM = 'Custom';

let boxKeySeq = 1;
const numOrNull = (s: string): number | null => {
  const n = parseFloat(s);
  return s.trim() && isFinite(n) ? n : null;
};
const fmtDim = (n: number | null): string => (n == null ? '—' : String(n));

export default function OutboundBoard({
  initialQueue,
  boxPresets,
  initialOrderId,
  userEmail,
  embedded = false,
  onCountChange,
  onAdvance,
  reloadKey = 0,
}: {
  initialQueue: ShipQueueRow[];
  boxPresets: BoxPreset[];
  initialOrderId?: string | null;
  userEmail: string;
  // JZ-001: Orders pipeline window — see PendingBoard for the embedded/onCountChange/onAdvance contract.
  embedded?: boolean;
  onCountChange?: (n: number) => void;
  onAdvance?: (salesId: string, toStage: string) => void;
  reloadKey?: number;
}) {
  const [queue, setQueue] = useState<ShipQueueRow[]>(initialQueue);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShipDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const reqIdRef = useRef(0);

  // filter the Ready-to-ship queue by customer name OR SKU code (client-side over the loaded worklist)
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return queue;
    return queue.filter(
      (r) =>
        (r.customer_name ?? '').toLowerCase().includes(q) ||
        r.sku_codes.some((c) => c.toLowerCase().includes(q))
    );
  }, [queue, search]);

  // verification state: presence in `verified` = the line is confirmed (manual tick or full scan);
  // scanCounts drives the {n}/{qty} counter. (O1/O2)
  const [verified, setVerified] = useState<Map<string, 'manual' | 'scan'>>(new Map());
  const [scanCounts, setScanCounts] = useState<Map<string, number>>(new Map());
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<BoxDraft[]>([]);
  const [copied, setCopied] = useState(false);

  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(ShipResult & { units: number; completed: boolean }) | null>(null);

  const defaultPreset = boxPresets[0]?.code ?? CUSTOM;
  const makeBox = (): BoxDraft => ({ key: boxKeySeq++, preset: defaultPreset, real: '', p: '', l: '', t: '' });

  // barcode → item_code, for scan verification
  const barcodeMap = useMemo(() => {
    const m = new Map<string, string>();
    detail?.barcodes.forEach((b) => m.set(b.barcode, b.item_code));
    return m;
  }, [detail]);

  const imgCodes = useMemo(
    () => (detail?.lines ?? []).map((l) => l.item_code).filter(Boolean) as string[],
    [detail]
  );
  const imgMap = useSkuImages(imgCodes);

  // O3 copyable address block — name/phone fall back to the customer; raw_address verbatim; a blank
  // line then the courier label + #tracking. The order-code title row is NOT part of the copy text.
  const addressBlock = useMemo(() => {
    if (!detail) return '';
    // The saved address is one combined field (name + full address + contact) — print it verbatim, no
    // rebuilding from columns (that double-printed the name + phone). Then a blank line + courier/tracking.
    const head = detail.raw_address || detail.ship_address || detail.customer_name || '';
    const tail: string[] = [];
    if (detail.courier_label) tail.push(detail.courier_label);
    if (detail.courier_tracking) tail.push('#' + detail.courier_tracking);
    return tail.length ? `${head}\n\n${tail.join('\n')}` : head;
  }, [detail]);

  function applyDetail(d: ShipDetail | null) {
    setDetail(d);
    if (d) {
      setVerified(new Map());      // O1: lines start UNCHECKED
      setScanCounts(new Map());
      setBoxes([makeBox()]);
      setScan('');
      setScanMsg(null);
      setCopied(false);
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

  // PR27: preselect an order when arriving from /orders (?order=…). Runs once.
  const didPreselect = useRef(false);
  useEffect(() => {
    if (initialOrderId && !didPreselect.current) {
      didPreselect.current = true;
      openOrder(initialOrderId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOrderId]);

  async function reloadQueue() {
    try { setQueue(await getShipQueue()); } catch { /* keep current on transient error */ }
  }

  // JZ-001: live count badge + external reload (see PendingBoard).
  useEffect(() => { onCountChange?.(queue.length); }, [queue, onCountChange]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) reloadQueue(); }, [reloadKey]);

  // PR-B §6: Return to Fulfill — clear the courier on the whole order (all-or-none). The cut + address
  // stay, so the order drops back into the Fulfill To-send queue (NOT to Pending). No stock movement.
  async function doReturnToFulfill() {
    if (!detail) return;
    if (!window.confirm(`Return ${detail.sales_id} to Fulfill? The courier is cleared and the order goes back to the To-send queue to re-pick courier/address.`)) return;
    const myReq = ++reqIdRef.current; // latest-wins: a mid-flight selection change must win
    setCommitting(true);
    setError(null);
    try {
      await returnToFulfill(detail.sales_id);
      if (reqIdRef.current !== myReq) return; // superseded by a newer selection — don't clobber it
      onAdvance?.(detail.sales_id, 'Fulfill'); // JZ-001: pipeline toast (moves back a stage)
      setResult(null);
      setDetail(null);
      setSelected(null);
      // a queue-refresh failure must not masquerade as an un-fulfill failure (detail is now null)
      try { setQueue(await getShipQueue()); } catch { /* keep current queue on transient error */ }
    } catch (e) {
      if (reqIdRef.current === myReq) setError(e instanceof Error ? e.message : 'Return to Fulfill failed.');
    } finally {
      setCommitting(false);
    }
  }

  // manual verification: tick = "Manually checked"; unticking also resets the scan counter to 0/X.
  function toggleLine(lineId: string) {
    const isVerified = verified.has(lineId);
    setVerified((prev) => {
      const next = new Map(prev);
      if (isVerified) next.delete(lineId);
      else next.set(lineId, 'manual');
      return next;
    });
    if (isVerified) setScanCounts((prev) => new Map(prev).set(lineId, 0));
  }

  // scan verification: +1 to the first not-yet-full matching line; full → "Barcode OK".
  function doScan() {
    const code = scan.trim();
    setScan('');
    if (!code || !detail) return;
    const item = barcodeMap.get(code);
    if (!item) { setScanMsg(`no SKU for barcode ${code}`); return; }
    const hitLines = detail.lines.filter((l) => l.item_code === item);
    if (!hitLines.length) { setScanMsg(`${item} not in this order`); return; }
    const target = hitLines.find((l) => (scanCounts.get(l.line_id) ?? 0) < l.qty);
    if (!target) { setScanMsg(`${item} already fully scanned`); return; }
    const n = Math.min((scanCounts.get(target.line_id) ?? 0) + 1, target.qty);
    setScanCounts((prev) => new Map(prev).set(target.line_id, n));
    if (n >= target.qty) {
      setVerified((prev) => new Map(prev).set(target.line_id, 'scan'));
      setScanMsg(`✓ ${item} complete`);
    } else {
      setScanMsg(`✓ ${item} ${n}/${target.qty}`);
    }
  }

  function setBox(key: number, patch: Partial<BoxDraft>) {
    setBoxes((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }
  // effective dims for a box: preset dims from SETTINGS, or the manual P/L/T for a Custom box.
  function boxDims(b: BoxDraft): { p: number | null; l: number | null; t: number | null } {
    if (b.preset === CUSTOM) return { p: numOrNull(b.p), l: numOrNull(b.l), t: numOrNull(b.t) };
    const preset = boxPresets.find((x) => x.code === b.preset);
    return { p: preset?.dim_p ?? null, l: preset?.dim_l ?? null, t: preset?.dim_t ?? null };
  }
  function boxPreview(b: BoxDraft): { vol: number | null; charge: number | null } {
    const real = numOrNull(b.real);
    const { p, l, t } = boxDims(b);
    const vol = p != null && l != null && t != null ? volWeight(p, l, t) : null;
    const charge = vol != null ? chargeable(real ?? 0, vol) : real;
    return { vol, charge };
  }

  // O5 gate: every line verified AND every Custom box has all three dims. unitsShipping = ALL lines
  // (no partial ship — the subset decision was made at Fulfill).
  const allVerified = !!detail && detail.lines.length > 0 && detail.lines.every((l) => verified.has(l.line_id));
  const customIncomplete = boxes.some(
    (b) => b.preset === CUSTOM && !(numOrNull(b.p) != null && numOrNull(b.l) != null && numOrNull(b.t) != null)
  );
  const unitsShipping = detail?.lines.reduce((s, l) => s + l.qty, 0) ?? 0;
  const willComplete = !!detail && detail.lines.length > 0 && detail.pending_fulfill_count === 0;

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(addressBlock);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copy failed — select the block and copy manually.');
    }
  }

  async function commit() {
    if (!detail || !allVerified || customIncomplete) return;
    setCommitting(true);
    setError(null);
    try {
      const willCompleteNow = willComplete;
      const res = await recordShipment({
        sales_id: detail.sales_id,
        line_ids: detail.lines.map((l) => l.line_id), // all-or-none: ship every fulfilled-unshipped line
        boxes: boxes
          .filter((b) => {
            const d = boxDims(b);
            return b.real.trim() || d.p != null || d.l != null || d.t != null;
          })
          .map((b) => {
            const d = boxDims(b);
            return { real_weight: numOrNull(b.real), dim_p: d.p, dim_l: d.l, dim_t: d.t };
          }),
      });
      if (res.affected.length === 0) {
        setError('Those lines were already shipped — nothing to do.');
      } else {
        setResult({ ...res, units: unitsShipping, completed: willCompleteNow });
        // JZ-001: a completed order leaves the pipeline into History; a partial ship stays in Outbound.
        if (willCompleteNow) onAdvance?.(detail.sales_id, 'History');
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

  const body = (
    <>
      <div className="fulfill-layout">
        {/* ── Queue ── */}
        <aside className="fq-pane">
          {/* No queue header — the tab badge shows the count. Search by customer or SKU. */}
          <div className="search-row" style={{ padding: '8px' }}>
            <input type="text" inputMode="search" placeholder="Search customer or SKU…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {shown.length === 0 && <div className="hint fq-empty">{queue.length === 0 ? 'Nothing fulfilled and waiting to ship.' : 'No match.'}</div>}
          <ul className="fq-list">
            {shown.map((q) => (
              <li key={q.sales_id}>
                <button className={`fq-row ${selected === q.sales_id ? 'active' : ''}`} onClick={() => openOrder(q.sales_id)}>
                  {/* Styled like Sales: customer name headline, sales id demoted. */}
                  <div className="fq-row-top">
                    <span className="fq-headline">{q.customer_name || '—'}</span>
                    <span className="fq-id-sub">{q.sales_id}</span>
                  </div>
                  <div className="fq-row-bot">
                    <span>{q.ready_count} {q.ready_count === 1 ? 'item' : 'items'}</span>
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
              {/* O3: overview title + copyable address block */}
              <div className="fd-head">
                <div className="ob-code">Outbound overview</div>
                <div className="ob-addr">
                  <button className="ob-copy" onClick={copyAddress} aria-label="Copy address block">
                    {copied ? '✓ Copied' : '⧉ Copy'}
                  </button>
                  <pre className="ob-addr-block">{addressBlock}</pre>
                  {!detail.courier_label && <div className="hint ob-addr-hint">Courier not set — set it in Fulfill.</div>}
                </div>
              </div>

              {error && <div className="validation err">{error}</div>}
              {result && (
                <div className="validation ok">
                  Shipped {result.units} unit{result.units === 1 ? '' : 's'}.{' '}
                  {result.completed ? 'Order → Complete. ' : ''}
                  {result.stock.map((s) => `${s.item_code}: physical ${s.physical}, reserved ${s.reserved}`).join(' · ')}
                </div>
              )}

              {/* Items — verify every one (manual check or scan), then ship the whole order */}
              <section className="fd-section">
                <div className="fd-section-head">Items</div>
                <div className="scan-row">
                  {/* Enter scans the barcode and auto-clears the field (no scan button). */}
                  <input
                    type="text"
                    placeholder="scan / type a barcode, then Enter"
                    value={scan}
                    onChange={(e) => setScan(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doScan(); } }}
                  />
                  {scanMsg && <span className="scan-msg">{scanMsg}</span>}
                </div>
                <ul className="ff-lines">
                  {detail.lines.map((l) => {
                    const mode = verified.get(l.line_id);
                    const n = scanCounts.get(l.line_id) ?? 0;
                    const countText = mode ? `${l.qty}/${l.qty}` : `${n}/${l.qty}`;
                    const countCls = mode === 'manual' ? 'manual' : mode === 'scan' ? 'scan' : 'zero';
                    return (
                      <li key={l.line_id} className="ff-line pend-line">
                        <SkuImage status={imgMap[l.item_code ?? '']?.status} displayUrl={imgMap[l.item_code ?? '']?.displayUrl} name={l.name} size={SKU_IMG.sm} />
                        <div className="pend-line-main">
                          <span className="ff-code">{l.item_code || '—'}</span>
                          <span className="ff-name">{l.name}</span>
                        </div>
                        <div className="ob-verify">
                          <span className={`ob-count ${countCls}`}>{countText}</span>
                          <button className="ob-manual-btn" onClick={() => toggleLine(l.line_id)}>
                            {mode === 'manual' ? '✓ checked' : mode === 'scan' ? '✓ scanned' : 'manual check'}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Boxes — editable, History-style rows (numbered icon + two lines + chargeable on the right). */}
              <section className="fd-section">
                <div className="fd-section-head">Boxes</div>
                <ul className="ff-lines">
                  {boxes.map((b, i) => {
                    const { vol, charge } = boxPreview(b);
                    const dims = boxDims(b);
                    return (
                      <li key={b.key} className="box-sum box-edit">
                        <span className="box-idx">{i + 1}</span>
                        <div className="box-sum-main">
                          <div className="box-edit-line">
                            <select className="box-preset" value={b.preset} onChange={(e) => setBox(b.key, { preset: e.target.value })}>
                              {boxPresets.map((p) => <option key={p.code} value={p.code}>{p.code}</option>)}
                              <option value={CUSTOM}>Custom</option>
                            </select>
                            {b.preset === CUSTOM ? (
                              <>
                                <input className="box-dim" type="number" inputMode="numeric" min={0} placeholder="P" value={b.p} onChange={(e) => setBox(b.key, { p: e.target.value })} />
                                <input className="box-dim" type="number" inputMode="numeric" min={0} placeholder="L" value={b.l} onChange={(e) => setBox(b.key, { l: e.target.value })} />
                                <input className="box-dim" type="number" inputMode="numeric" min={0} placeholder="T" value={b.t} onChange={(e) => setBox(b.key, { t: e.target.value })} />
                              </>
                            ) : (
                              <span className="box-dims-ro">{fmtDim(dims.p)} x {fmtDim(dims.l)} x {fmtDim(dims.t)} cm</span>
                            )}
                          </div>
                          <div className="box-edit-line">
                            <input className="box-real" type="number" inputMode="numeric" min={0} placeholder="real (g)" value={b.real} onChange={(e) => setBox(b.key, { real: e.target.value })} />
                            <span className="box-sum-l2">vol: {vol != null ? `${vol.toFixed(0)} g` : '—'}</span>
                          </div>
                        </div>
                        <span className="ff-qty">{charge != null ? `${charge.toFixed(0)} g` : '—'}</span>
                        {boxes.length > 1 && <button className="box-remove" onClick={() => setBoxes((prev) => prev.filter((x) => x.key !== b.key))} aria-label="remove box">×</button>}
                      </li>
                    );
                  })}
                </ul>
                <button className="btn-link box-add" onClick={() => setBoxes((prev) => [...prev, makeBox()])}>+ box</button>
              </section>

              {/* Commit bar (O5: all-or-none; enabled only when every line verified + custom dims filled) */}
              <div className="fd-commit">
                {detail.lines.length > 0 && !allVerified && (
                  <span className="warn-text">verify all {detail.lines.length} item{detail.lines.length === 1 ? '' : 's'} to ship</span>
                )}
                {allVerified && customIncomplete && (
                  <span className="warn-text">fill the custom box dimensions</span>
                )}
                <button className="btn-primary" onClick={commit} disabled={committing || !allVerified || customIncomplete}>
                  {committing ? 'Shipping…' : `Mark shipped${unitsShipping ? ` (${unitsShipping} unit${unitsShipping === 1 ? '' : 's'})` : ''}`}
                </button>
              </div>

              {/* Return to Fulfill (PR-B §6) — bottom, left-aligned text button (clears courier, keeps
                  tracking; order drops back to the Fulfill To-send queue). */}
              <div className="ob-return">
                <button className="btn-link" onClick={doReturnToFulfill} disabled={committing}>↩ Return to Fulfill</button>
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );

  if (embedded) return body;
  return (
    <div className="ops">
      <AppHeader active="outbound" userEmail={userEmail} />
      {body}
    </div>
  );
}

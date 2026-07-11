'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { volWeight, chargeable } from '@jigzle/lib';
import type { ShipQueueRow } from '@jigzle/db/types';
import { getShipQueue, getOrderForShip, recordShipment, recordConsolidatedShipment, returnToFulfill } from '@/app/outbound/actions';
import type { ShipDetail, ShipResult } from '@/app/outbound/types';
import type { ShipLine } from '@jigzle/db/types';
import type { BoxPreset } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import IconSelect from '@/components/IconSelect';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import { getActiveStaff } from '@/components/staffStore';
import StaffPicker from '@/components/StaffPicker';
import type { StaffMember } from '@/app/settings/types';

// preset = a box-preset code (dims from SETTINGS) or 'Custom' (manual P/L/T).
type BoxDraft = { key: number; preset: string; real: string; p: string; l: string; t: string };
const CUSTOM = 'Custom';

let boxKeySeq = 1;
const numOrNull = (s: string): number | null => {
  const n = parseFloat(s);
  return s.trim() && isFinite(n) ? n : null;
};

// PR321 — collapse EXACT-duplicate region fields (Ward/Subdistrict/City/Province) so a repeated value is
// printed once (e.g. Kuningan×3 → a single "Kuningan"). Match is case/space-normalized string equality, so
// partial names like "Kuningan" vs "Kuningan Barat" are kept as distinct. Order-preserving (first wins).
function dedupeRegion(parts: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const v = (p ?? '').trim();
    if (!v) continue;
    const norm = v.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(v);
  }
  return out;
}

// today's local date, 'YYYY-MM-DD' — the right side of the staff line (PR155)
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function OutboundBoard({
  initialQueue,
  boxPresets,
  initialOrderId,
  userEmail,
  embedded = false,
  staffOptions = [],
  onCountChange,
  onDetailOpenChange,
  onAdvance,
  reloadKey = 0,
}: {
  initialQueue: ShipQueueRow[];
  boxPresets: BoxPreset[];
  initialOrderId?: string | null;
  userEmail: string;
  // JZ-001: Orders pipeline window — see PendingBoard for the embedded/onCountChange/onAdvance contract.
  embedded?: boolean;
  // PR155: the staff picker is a line in THIS tab's body (Ready to ship only), not the shell header.
  staffOptions?: StaffMember[];
  onCountChange?: (n: number) => void;
  // PR155: the shell hides the tab bar while the ship detail bodyview is open (breadcrumb stays).
  onDetailOpenChange?: (open: boolean) => void;
  onAdvance?: (salesId: string, toStage: string) => void;
  reloadKey?: number;
}) {
  const [queue, setQueue] = useState<ShipQueueRow[]>(initialQueue);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShipDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const reqIdRef = useRef(0);

  // verification state: presence in `verified` = the line is confirmed (manual tick or full scan);
  // scanCounts drives the {n}/{qty} counter. (O1/O2)
  const [verified, setVerified] = useState<Map<string, 'manual' | 'scan'>>(new Map());
  const [scanCounts, setScanCounts] = useState<Map<string, number>>(new Map());
  // 0035: the barcode read for a scan-verified line (last one wins) — captured at ship for the report.
  const [scannedBarcodes, setScannedBarcodes] = useState<Map<string, string>>(new Map());
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<BoxDraft[]>([]);
  const [copied, setCopied] = useState(false);
  const [copiedExport, setCopiedExport] = useState(false); // PR193 — courier-address block copy state

  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(ShipResult & { units: number; completed: boolean }) | null>(null);
  // PR197: one-send consolidation — other ready orders to the SAME customer+address+courier can ship in
  // this parcel. `included` = their sales_ids; `sibDetails` caches each included order's ship detail (for
  // its lines + pending count). Verification/boxes are shared across the merged line set.
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [sibDetails, setSibDetails] = useState<Map<string, ShipDetail>>(new Map());
  const [sibBusy, setSibBusy] = useState<string | null>(null);

  const defaultPreset = boxPresets[0]?.code ?? CUSTOM;
  const makeBox = (): BoxDraft => ({ key: boxKeySeq++, preset: defaultPreset, real: '', p: '', l: '', t: '' });

  // barcode → item_code, for scan verification
  const barcodeMap = useMemo(() => {
    const m = new Map<string, string>();
    detail?.barcodes.forEach((b) => m.set(b.barcode, b.item_code));
    return m;
  }, [detail]);

  const imgCodes = useMemo(() => {
    // PR197: cover the primary AND any included siblings' lines
    const base = detail?.lines ?? [];
    const extra = [...included].flatMap((sid) => sibDetails.get(sid)?.lines ?? []);
    return [...base, ...extra].map((l) => l.item_code).filter(Boolean) as string[];
  }, [detail, included, sibDetails]);
  const imgMap = useSkuImages(imgCodes);

  // O3 copyable address block (PR119). Layout:
  //   <recipient>
  //   <address on ONE line>   — street, (notes), ward, subdistrict, city/district, province, country, postcode
  //   <phone>
  //   <blank>
  //   <courier>: <#tracking>  — courier + tracking on ONE line
  //   <delivery note>         — printed below the courier line
  // name/phone fall back to the customer; the one-line address falls back to the raw blob if unparsed.
  const addressBlock = useMemo(() => {
    if (!detail) return '';
    const recipient = detail.recipient_name || detail.customer_name;
    const phone = detail.contact_phone || detail.customer_phone;
    // PR321 — the four region fields (ward → subdistrict → city → province) collapse exact repeats so a
    // messy address like Kuningan/Kuningan/Kuningan prints "Kuningan" once; street/country/postcode stay.
    const addrLine = [
      detail.street,
      ...dedupeRegion([detail.kelurahan, detail.kecamatan, detail.kota, detail.provinsi]),
      detail.negara,
      detail.kode_pos,
    ].filter((x) => x && String(x).trim()).join(', ');
    const address = addrLine || detail.raw_address || detail.ship_address || '';
    const head = [recipient, address, phone].filter((x) => x && String(x).trim()).join('\n');
    // courier + tracking on one line. The list shows planned_courier while the detail historically read
    // courier_label only — fall back so an imported line with `courier` but no `courier_label` still shows.
    const courier = detail.courier_label || detail.planned_courier;
    const tracking = detail.courier_tracking ? '#' + detail.courier_tracking : null;
    const courierLine = [courier, tracking].filter(Boolean).join(': ');
    // PR321 — courier line, then the delivery note beneath it, prefixed with "Note: " so it reads clearly.
    const noteRaw = detail.delivery_note && String(detail.delivery_note).trim() ? String(detail.delivery_note).trim() : null;
    const footer = [courierLine, noteRaw ? `Note: ${noteRaw}` : null].filter((x) => x && String(x).trim()).join('\n');
    return footer ? `${head}\n\n${footer}` : head;
  }, [detail]);

  // PR193: for an EXPORT shipment whose courier has an intermediary address (Repack & co.), the parcel
  // physically ships to the COURIER first — this is that second copyable block. Shown only when the
  // export courier "needs address" and one is filled; DHL/FedEx (local pickup) have none → no block, so
  // Outbound falls back to the customer-only view. The customer's intl address (above) stays as the
  // final-destination reference to attach to the box.
  const exportShipment = !!detail?.export_courier;
  const exportAddressBlock = useMemo(() => {
    if (!detail || !detail.export_needs_address) return '';
    const addr = (detail.export_addr_text ?? '').trim();
    if (!addr) return '';
    const lines = [detail.export_addr_recipient, addr, detail.export_addr_phone]
      .filter((x) => x && String(x).trim())
      .join('\n');
    return lines;
  }, [detail]);

  async function copyExportAddress() {
    try {
      await navigator.clipboard.writeText(exportAddressBlock);
      setCopiedExport(true);
      setTimeout(() => setCopiedExport(false), 1500);
    } catch {
      setError('Copy failed — select the block and copy manually.');
    }
  }

  function applyDetail(d: ShipDetail | null) {
    setDetail(d);
    setIncluded(new Set());        // PR197: a fresh primary drops any consolidation selection
    setSibDetails(new Map());
    if (d) {
      setVerified(new Map());      // O1: lines start UNCHECKED
      setScanCounts(new Map());
      setScannedBarcodes(new Map());
      setBoxes([makeBox()]);
      setScan('');
      setScanMsg(null);
      setCopied(false);
      setCopiedExport(false);
    }
  }

  // PR197: other ready orders combinable with the open one — same customer + same ship address + same
  // courier (one parcel = one courier). Only when the primary is addressed; the RPC re-checks server-side.
  const siblings = useMemo(() => {
    if (!detail || detail.address_id == null) return [];
    return queue.filter(
      (q) =>
        q.sales_id !== detail.sales_id &&
        q.customer_id != null && q.customer_id === detail.customer_id &&
        q.address_id != null && q.address_id === detail.address_id &&
        (q.planned_courier ?? null) === (detail.planned_courier ?? null)
    );
  }, [queue, detail]);

  // the merged line set actually shipping: primary + every included sibling's lines.
  const shipLines: ShipLine[] = useMemo(() => {
    const base = detail?.lines ?? [];
    const extra = [...included].flatMap((sid) => sibDetails.get(sid)?.lines ?? []);
    return [...base, ...extra];
  }, [detail, included, sibDetails]);

  // tick/untick a sibling — load its detail (lines + pending count) on first include.
  async function toggleSibling(salesId: string) {
    if (included.has(salesId)) {
      setIncluded((prev) => { const n = new Set(prev); n.delete(salesId); return n; });
      return;
    }
    if (!sibDetails.has(salesId)) {
      setSibBusy(salesId);
      try {
        const d = await getOrderForShip(salesId);
        if (d) setSibDetails((prev) => new Map(prev).set(salesId, d));
        else { setError(`Couldn't load ${salesId}.`); return; }
      } catch {
        setError(`Couldn't load ${salesId}.`); return;
      } finally {
        setSibBusy(null);
      }
    }
    setIncluded((prev) => new Set(prev).add(salesId));
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
  // PR155: bodyview — the shell hides the tab bar while the ship detail is open.
  useEffect(() => { onDetailOpenChange?.(!!selected); }, [selected, onDetailOpenChange]);
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
    setScannedBarcodes((prev) => new Map(prev).set(target.line_id, code)); // remember the read barcode
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
  // PR197: gates span the merged line set (primary + included siblings).
  const allVerified = !!detail && shipLines.length > 0 && shipLines.every((l) => verified.has(l.line_id));
  const customIncomplete = boxes.some(
    (b) => b.preset === CUSTOM && !(numOrNull(b.p) != null && numOrNull(b.l) != null && numOrNull(b.t) != null)
  );
  // PR197: every box must carry a MEASURED real weight (> 0) — never ship an unweighed parcel. Mirrors
  // the Custom-dims gate; blocks the whole send until each box has a real weight (an empty extra box can
  // be removed via its × button).
  const weightMissing = boxes.some((b) => { const r = numOrNull(b.real); return r == null || r <= 0; });
  const unitsShipping = shipLines.reduce((s, l) => s + l.qty, 0);
  // every involved order completes only if it has no still-unfulfilled line (primary + each sibling).
  const willComplete =
    !!detail && shipLines.length > 0 &&
    detail.pending_fulfill_count === 0 &&
    [...included].every((sid) => (sibDetails.get(sid)?.pending_fulfill_count ?? 0) === 0);

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
    if (!detail || !allVerified || customIncomplete || weightMissing) return;
    setCommitting(true);
    setError(null);
    try {
      const willCompleteNow = willComplete;
      // 0035: how each line was checked — 'scan' carries the read barcode, 'manual' a tick. The gate
      // (allVerified) guarantees every line has a method; default to 'manual' defensively.
      const verifyFor = (lines: ShipLine[]) =>
        lines.map((l) => {
          const method = verified.get(l.line_id) ?? 'manual';
          return { line_id: l.line_id, method, barcode: method === 'scan' ? (scannedBarcodes.get(l.line_id) ?? null) : null };
        });
      const boxPayload = boxes
        .filter((b) => {
          const d = boxDims(b);
          return b.real.trim() || d.p != null || d.l != null || d.t != null;
        })
        .map((b) => {
          const d = boxDims(b);
          return { real_weight: numOrNull(b.real), dim_p: d.p, dim_l: d.l, dim_t: d.t };
        });
      // PR197: siblings included → one consolidated send across orders; else the single-order path.
      const res = included.size > 0
        ? await recordConsolidatedShipment({
            line_ids: shipLines.map((l) => l.line_id),
            verify: verifyFor(shipLines),
            boxes: boxPayload,
            staff: getActiveStaff(),
          })
        : await recordShipment({
            sales_id: detail.sales_id,
            line_ids: detail.lines.map((l) => l.line_id), // all-or-none: ship every fulfilled-unshipped line
            verify: verifyFor(detail.lines),
            boxes: boxPayload,
            staff: getActiveStaff(),
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

  // PR197: one line row of the ship detail — reused for the primary order and each included sibling.
  function renderShipLine(l: ShipLine) {
    const mode = verified.get(l.line_id);
    const n = scanCounts.get(l.line_id) ?? 0;
    const countText = mode ? `${l.qty}/${l.qty}` : `${n}/${l.qty}`;
    const countCls = mode === 'manual' ? 'manual' : mode === 'scan' ? 'scan' : 'zero';
    return (
      <li key={l.line_id} className="ff-line pend-line-card">
        <div className="pend-line">
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
        </div>
        {/* note set in Pending/Fulfill — read-only here */}
        {l.line_note && (
          <div className="note-show"><span className="note-show-tag" aria-hidden="true">✎</span><span className="note-show-text">{l.line_note}</span></div>
        )}
      </li>
    );
  }

  // PR155 — bodyview: the body shows EITHER the staff line + ship queue (full width) OR the tapped
  // order's ship detail with a ← back button; the shell hides the tab bar while the detail is open.
  const body = (
    <>
      <div className="bodyview">
        {/* ── Queue ── */}
        {!selected && (
          <>
            {/* Staff line — who's on shift (stamped onto each shipment), today's date on the right. */}
            {staffOptions.length > 0 && (
              <div className="ob-staff-line">
                <StaffPicker options={staffOptions} />
                <span className="ob-staff-date">{todayLocal()}</span>
              </div>
            )}
            {queue.length === 0 && <div className="hint fq-empty">Nothing fulfilled and waiting to ship.</div>}
            <ul className="fq-list">
              {queue.map((q) => (
                <li key={q.sales_id}>
                  <button className="fq-row" onClick={() => openOrder(q.sales_id)}>
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
          </>
        )}

        {/* ── Detail ── */}
        {selected && (
          <>
          <button className="btn-link bv-back" onClick={() => { setSelected(null); setDetail(null); }}>← back</button>
          <div className="bv-detail">
          {loadingDetail && <div className="fd-empty">Loading…</div>}
          {!loadingDetail && !detail && <div className="fd-empty">Order not found or nothing left to ship.</div>}

          {detail && (
            <>
              {/* O3: shipping-details label (section-head style) + copyable address block. PR193: an
                  EXPORT shipment (intl ship-to) shows two blocks side-by-side — customer (final
                  destination) first, export courier (intermediary) second; both go on the box. A
                  no-address export courier (DHL/FedEx) shows the customer block only. */}
              <div className="fd-head">
                <div className="fd-section-head">Shipping details</div>
                {exportShipment && (
                  <div className="validation warn ob-export-banner">
                    Export shipment via {detail.export_courier}.{' '}
                    {exportAddressBlock
                      ? 'Ship the parcel to the courier (right) first; attach the customer address (left) for onward delivery.'
                      : `${detail.export_courier} picks up locally — ship to the customer address below.`}
                  </div>
                )}
                <div className={`ob-addr-pair ${exportShipment && exportAddressBlock ? 'two' : ''}`}>
                  <div className="ob-addr">
                    {exportShipment && exportAddressBlock && <div className="ob-addr-cap">Customer — final destination</div>}
                    <button className="ob-copy" onClick={copyAddress} aria-label="Copy customer address block">
                      {copied ? '✓ Copied' : '⧉ Copy'}
                    </button>
                    <pre className="ob-addr-block">{addressBlock}</pre>
                    {!(detail.courier_label || detail.planned_courier) && <div className="hint ob-addr-hint">Courier not set — set it in Fulfill.</div>}
                  </div>
                  {exportShipment && exportAddressBlock && (
                    <div className="ob-addr">
                      <div className="ob-addr-cap">Send to {detail.export_courier} first (intermediary)</div>
                      <button className="ob-copy" onClick={copyExportAddress} aria-label="Copy export courier address block">
                        {copiedExport ? '✓ Copied' : '⧉ Copy'}
                      </button>
                      <pre className="ob-addr-block">{exportAddressBlock}</pre>
                    </div>
                  )}
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

              {/* PR197: other ready orders to this same customer + address + courier — tick to ship them
                  in this one parcel (one send). */}
              {siblings.length > 0 && (
                <section className="fd-section">
                  <div className="fd-section-head">Also going to this address</div>
                  <ul className="ff-lines">
                    {siblings.map((q) => (
                      <li key={q.sales_id} className="ff-line pend-line-card">
                        <label className="pend-line" style={{ cursor: 'pointer', alignItems: 'center' }}>
                          <input
                            type="checkbox"
                            checked={included.has(q.sales_id)}
                            disabled={sibBusy === q.sales_id || committing}
                            onChange={() => toggleSibling(q.sales_id)}
                          />
                          <div className="pend-line-main">
                            <span className="ff-code">{q.sales_id}</span>
                            <span className="ff-name">{q.ready_count} {q.ready_count === 1 ? 'item' : 'items'}{q.planned_courier ? ` · ${q.planned_courier}` : ''}</span>
                          </div>
                          {sibBusy === q.sales_id && <span className="scan-msg">loading…</span>}
                        </label>
                      </li>
                    ))}
                  </ul>
                  {included.size > 0 && (
                    <div className="hint">Shipping {included.size + 1} orders as one send ({unitsShipping} units).</div>
                  )}
                </section>
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
                  {detail.lines.map((l) => renderShipLine(l))}
                </ul>
                {/* PR197: included siblings' lines, grouped under their order id (they ship in this send) */}
                {[...included].map((sid) => {
                  const sd = sibDetails.get(sid);
                  if (!sd) return null;
                  return (
                    <div key={sid}>
                      <div className="fd-section-head" style={{ marginTop: 8, opacity: 0.8 }}>＋ {sid}</div>
                      <ul className="ff-lines">
                        {sd.lines.map((l) => renderShipLine(l))}
                      </ul>
                    </div>
                  );
                })}
              </section>

              {/* Boxes — numbered icon; row 1 = box type (largest) + L/W/H side-by-side (static for a
                  preset, editable for Custom); row 2 = real weight + the chargeable (largest of vol/real).
                  Dims are in cm; L=length(P) W=width(L) H=height(T). */}
              <section className="fd-section">
                <div className="fd-section-head">Boxes</div>
                <ul className="ff-lines">
                  {boxes.map((b, i) => {
                    const { vol, charge } = boxPreview(b);
                    const dims = boxDims(b);
                    const custom = b.preset === CUSTOM;
                    return (
                      <li key={b.key} className="box-sum box-edit">
                        <span className="box-idx">{i + 1}</span>
                        <div className="box-sum-main">
                          <div className="box-dim-row">
                            <IconSelect
                              className="box-preset"
                              ariaLabel="Box preset"
                              value={b.preset}
                              options={[
                                ...boxPresets.map((p) => ({ value: p.code, label: p.code, icon: p.icon })),
                                { value: CUSTOM, label: 'Custom' },
                              ]}
                              onChange={(code) => setBox(b.key, { preset: code })}
                            />
                            {custom ? (
                              <>
                                <input className="box-dim" type="number" inputMode="numeric" min={0} placeholder="L" value={b.p} onChange={(e) => setBox(b.key, { p: e.target.value })} />
                                <input className="box-dim" type="number" inputMode="numeric" min={0} placeholder="W" value={b.l} onChange={(e) => setBox(b.key, { l: e.target.value })} />
                                <input className="box-dim" type="number" inputMode="numeric" min={0} placeholder="H" value={b.t} onChange={(e) => setBox(b.key, { t: e.target.value })} />
                              </>
                            ) : (
                              <>
                                <input className="box-dim box-dim-ro" type="text" readOnly aria-label="length (cm)" value={dims.p ?? ''} />
                                <input className="box-dim box-dim-ro" type="text" readOnly aria-label="width (cm)" value={dims.l ?? ''} />
                                <input className="box-dim box-dim-ro" type="text" readOnly aria-label="height (cm)" value={dims.t ?? ''} />
                              </>
                            )}
                            {boxes.length > 1 && <button className="box-remove" onClick={() => setBoxes((prev) => prev.filter((x) => x.key !== b.key))} aria-label="remove box">×</button>}
                          </div>
                          <div className="box-meta-row">
                            <input className="box-real" type="number" inputMode="numeric" min={0} placeholder="real (g)" value={b.real} onChange={(e) => setBox(b.key, { real: e.target.value })} />
                            <span className="box-meta">vol {vol != null ? `${vol.toFixed(0)} g` : '—'} · chargeable {charge != null ? `${charge.toFixed(0)} g` : '—'}</span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <button className="btn-link box-add" onClick={() => setBoxes((prev) => [...prev, makeBox()])}>+ box</button>
              </section>

              {/* Commit bar (O5: all-or-none) — button + a two-line readiness checklist (grey → green). */}
              <div className="fd-commit">
                <button className="btn-primary" onClick={commit} disabled={committing || !allVerified || customIncomplete || weightMissing}>
                  {committing ? 'Shipping…' : 'Mark shipped'}
                </button>
                <ul className="ship-checks">
                  <li className={allVerified ? 'done' : ''}>{allVerified ? '✓' : '○'} All items checked</li>
                  <li className={!customIncomplete ? 'done' : ''}>{!customIncomplete ? '✓' : '○'} Box details filled</li>
                  <li className={!weightMissing ? 'done' : ''}>{!weightMissing ? '✓' : '○'} Real weight measured</li>
                </ul>
              </div>

              {/* Return to Fulfill (PR-B §6) — bottom, left-aligned text button (clears courier, keeps
                  tracking; order drops back to the Fulfill To-send queue). */}
              <div className="ob-return">
                <button className="btn-link" onClick={doReturnToFulfill} disabled={committing}>↩ Return to Fulfill</button>
              </div>
            </>
          )}
          </div>
          </>
        )}
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

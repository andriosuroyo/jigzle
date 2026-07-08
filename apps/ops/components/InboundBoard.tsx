'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import type { ExpectedLine, ReceiveLine, ReceiveQueueRow } from '@jigzle/db/types';
import {
  getReceiveQueue,
  getShipmentForReceive,
  resolveBarcode,
  searchSkus,
  createCatalogueStub,
  mapPlaceholderPO,
  linkBarcode,
  newAdhocShipId,
  recordReceipt,
  reverseReceipt,
  suggestShipIds,
} from '@/app/inbound/actions';
import type {
  ReceiveDetail,
  ResolvedSku,
  RecordReceiptResult,
  SkuHit,
  ShipIdSuggestion,
  ReceiveClass,
  ReceiveConfirmData,
  ReceiveConfirmRow,
} from '@/app/inbound/types';
import type { InboundLabel, StaffMember } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import IconSelect from '@/components/IconSelect';
import BarcodePicker from '@/components/BarcodePicker';
import ReceiveConfirm from '@/components/ReceiveConfirm';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import { getActiveStaff, setActiveStaff } from '@/components/staffStore';
import SearchInput from '@/components/SearchInput';
import { PackageIcon } from '@/components/AddIcons';

// PR243 — copy/check glyphs for the header id chips (mirrors Sales → Pending/History).
const csvg = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const CopyIcon = () => (<svg {...csvg}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>);
const CheckIcon = () => (<svg {...csvg}><polyline points="20 6 9 17 4 12" /></svg>);

// Never render a raw internal id as a name (Fulfill F4 parity, §4b). When the only "name" we have is
// the item_code itself (an edge case — stub creation + search both supply real names), show this.
function displayName(name: string | null | undefined, code?: string | null): string {
  const n = (name ?? '').trim();
  if (!n || (code && n === code)) return 'Unmatched item';
  return n;
}

function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// the synthetic detail for an ad-hoc receive (no shipments-ledger row, no expected list)
const ADHOC_SENTINEL = '__adhoc__';

// effective excluded count for a draft line: explicit excluded_qty, else the legacy whole-line flag.
function excludedOf(l: ReceiveLine): number {
  return l.excluded_qty ?? (l.excluded ? Math.max(l.qty, 0) : 0);
}
function sellableOf(l: ReceiveLine): number {
  return l.qty - excludedOf(l);
}

export default function InboundBoard({
  initialQueue,
  inboundLabels,
  staffOptions = [],
  userEmail,
  embedded = false,
  onCountChange,
  onDetailOpenChange,
  adhocSignal = 0,
}: {
  initialQueue: ReceiveQueueRow[];
  inboundLabels: InboundLabel[];
  staffOptions?: StaffMember[];
  userEmail: string;
  // Inbound window (InboundShell): same embedded/onCountChange contract as OutboundBoard.
  embedded?: boolean;
  onCountChange?: (n: number) => void;
  // PR154: the shell hides the tab bar while the receive detail bodyview is open (breadcrumb stays).
  onDetailOpenChange?: (open: boolean) => void;
  // PR130: the "+ Unmarked shipment" trigger moved to the shell's tab bar — a bumped counter fires startAdhoc().
  adhocSignal?: number;
}) {
  const [queue, setQueue] = useState<ReceiveQueueRow[]>(initialQueue);
  const [selected, setSelected] = useState<string | null>(null); // ship_id, or ADHOC_SENTINEL
  const [detail, setDetail] = useState<ReceiveDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const reqIdRef = useRef(0);

  const [mode, setMode] = useState<'shipment' | 'adhoc'>('shipment');
  const [adhocShipId, setAdhocShipId] = useState('');

  // what physically arrived, keyed by item_code (1 line → 1 inbound row on save)
  const [received, setReceived] = useState<Map<string, ReceiveLine>>(new Map());

  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [picker, setPicker] = useState<ResolvedSku[] | null>(null);
  const [stub, setStub] = useState<{ barcode: string; item_code: string; name: string; brand: string } | null>(null);

  const [skuQuery, setSkuQuery] = useState('');
  const [skuHits, setSkuHits] = useState<SkuHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [skuSearched, setSkuSearched] = useState(false); // true after a real search → drives "No results"
  const searchSeq = useRef(0); // stale-response guard for the debounced SKU search
  const skuInputRef = useRef<HTMLInputElement>(null);
  const [manualAdd, setManualAdd] = useState(false); // the "manual add" search overlay
  // when Manual add is opened from an unresolved line, the placeholder code being mapped (else null).
  // In this mode a search pick / new-SKU relinks the placeholder PO to the real SKU instead of just
  // adding a received unit.
  const [mappingRaw, setMappingRaw] = useState<string | null>(null);
  // optional barcode captured while mapping — linked to the chosen SKU so future receives auto-resolve.
  const [mapBarcode, setMapBarcode] = useState('');

  const [receiveDate, setReceiveDate] = useState(todayStr());
  const [closeShipment, setCloseShipment] = useState(true);

  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(RecordReceiptResult & { units: number }) | null>(null);

  // ── §6 confirmation window ──
  const [showConfirm, setShowConfirm] = useState(false);

  // ── reverse a confirmed receipt ──
  const [reverseAsk, setReverseAsk] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [reverseMsg, setReverseMsg] = useState<string | null>(null);

  // ── §5 scan-to-find-shipment (suggest open ship_ids for a scanned SKU) ──
  const [findScan, setFindScan] = useState('');
  const [finding, setFinding] = useState(false);
  const [suggestions, setSuggestions] = useState<ShipIdSuggestion[] | null>(null);
  const [findMsg, setFindMsg] = useState<string | null>(null);
  const [findNotFound, setFindNotFound] = useState(false); // PR154 → offer "+ Receive as unmarked"

  // PR243 — which header id chip flashed "copied" (ship id vs tracking); mirrors Sales.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  async function copyVal(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); setCopiedKey(key); setTimeout(() => setCopiedKey(null), 1400); } catch { /* clipboard unavailable */ }
  }

  // PR154: bodyview — the shell hides the tab bar while the receive detail is open.
  useEffect(() => { onDetailOpenChange?.(!!selected); }, [selected, onDetailOpenChange]);

  // PR154: the queue sorts by shipped date, newest first (undated last; ship_id tiebreak).
  const sortedQueue = useMemo(() => {
    return [...queue].sort((a, b) => {
      const da = a.ship_date ?? '', db = b.ship_date ?? '';
      if (da && db) return da < db ? 1 : da > db ? -1 : a.ship_id.localeCompare(b.ship_id);
      if (da) return -1;
      if (db) return 1;
      return a.ship_id.localeCompare(b.ship_id);
    });
  }, [queue]);

  // barcode → expected item_code(s). Composite barcode model (0020): a barcode can link to many
  // SKUs, so this maps to a LIST. The fast path only fires when exactly ONE expected SKU owns the
  // scanned code; a shared barcode (>1 owner) defers to the server resolveBarcode so the collision
  // picker shows — never silently attributing the scan to one arbitrary owner.
  // live count badge for the shell tab (mirrors OutboundBoard)
  useEffect(() => { onCountChange?.(queue.length); }, [queue, onCountChange]);

  // PR130: the shell's "+ Unmarked shipment" button bumps adhocSignal → start an ad-hoc receive. Skip 0
  // (initial) so a fresh mount doesn't auto-open one.
  useEffect(() => {
    if (adhocSignal) startAdhoc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adhocSignal]);

  const barcodeMap = useMemo(() => {
    const m = new Map<string, string[]>();
    detail?.barcodes.forEach((b) => {
      const owners = m.get(b.barcode);
      if (owners) {
        if (!owners.includes(b.item_code)) owners.push(b.item_code);
      } else {
        m.set(b.barcode, [b.item_code]);
      }
    });
    return m;
  }, [detail]);
  const expectedNameByCode = useMemo(() => {
    const m = new Map<string, string>();
    detail?.expected.forEach((e) => {
      if (e.item_code) m.set(e.item_code, e.name);
    });
    return m;
  }, [detail]);

  // SKU images for everything visible: expected list, what's been received, the collision picker,
  // and search hits — one batch read, lazy. A picture here is the moment that stops a wrong-SKU scan.
  const imgCodes = useMemo(() => {
    const set = new Set<string>();
    detail?.expected.forEach((e) => { if (e.item_code) set.add(e.item_code); });
    received.forEach((_v, k) => set.add(k));
    skuHits.forEach((h) => set.add(h.item_code));
    picker?.forEach((p) => set.add(p.item_code));
    return [...set];
  }, [detail, received, skuHits, picker]);
  const imgMap = useSkuImages(imgCodes);

  function resetDraft() {
    setReceived(new Map());
    setScan('');
    setScanMsg(null);
    setPicker(null);
    setStub(null);
    setSkuQuery('');
    setSkuHits([]);
    setSkuSearched(false);
    setManualAdd(false);
    setMappingRaw(null);
    setMapBarcode('');
    setReceiveDate(todayStr());
    setResult(null);
    setError(null);
    setShowConfirm(false);
    setReverseAsk(false);
    setReverseMsg(null);
  }

  async function openShipment(shipId: string) {
    const myReq = ++reqIdRef.current;
    setSelected(shipId);
    setMode('shipment');
    setAdhocShipId('');
    setDetail(null);
    resetDraft();
    setCloseShipment(true);
    setSuggestions(null);
    setFindMsg(null);
    setLoadingDetail(true);
    try {
      const d = await getShipmentForReceive(shipId);
      if (reqIdRef.current !== myReq) return; // superseded by a newer selection
      setDetail(d);
    } catch (e) {
      if (reqIdRef.current !== myReq) return;
      setError(e instanceof Error ? e.message : 'Failed to load shipment.');
    } finally {
      if (reqIdRef.current === myReq) setLoadingDetail(false);
    }
  }

  async function startAdhoc() {
    const myReq = ++reqIdRef.current;
    setSelected(ADHOC_SENTINEL);
    setMode('adhoc');
    setDetail({ ship_id: '', origin_country: null, ship_date: null, tracking: null, courier: null, note: null, is_shipment: false, expected: [], barcodes: [] });
    resetDraft();
    setCloseShipment(false);
    setAdhocShipId('');
    setSuggestions(null);
    setFindMsg(null);
    setLoadingDetail(true);
    try {
      const id = await newAdhocShipId();
      if (reqIdRef.current !== myReq) return;
      setAdhocShipId(id);
    } catch (e) {
      if (reqIdRef.current !== myReq) return;
      setError(e instanceof Error ? e.message : 'Failed to allocate an ad-hoc id.');
    } finally {
      if (reqIdRef.current === myReq) setLoadingDetail(false);
    }
  }

  // ── §5: scan an item in the queue pane → suggest the open ship_ids that contain it ──
  async function findShipment() {
    const code = findScan.trim();
    if (!code) return;
    setFinding(true);
    setFindMsg(null);
    setSuggestions(null);
    setFindNotFound(false);
    try {
      // resolve the scan to a SKU first (a barcode → its item_code; a typed item_code resolves to itself).
      let itemCode = code;
      const res = await resolveBarcode(code);
      if (res.status === 'resolved') itemCode = res.sku.item_code;
      else if (res.status === 'collision') itemCode = res.skus[0].item_code; // any owner shares the same open POs query
      const sug = await suggestShipIds(itemCode);
      if (sug.length === 0) {
        setFindMsg(`No open shipment has an open order line for ${itemCode}.`);
        setFindNotFound(true); // PR154 → offer receiving it as an unmarked box
      } else if (sug.length === 1) {
        setSuggestions(sug);
        setFindMsg(`1 candidate — ${sug[0].ship_id}.`);
      } else {
        setSuggestions(sug);
        setFindMsg(`${sug.length} candidates — pick one (oldest first).`);
      }
    } catch (e) {
      setFindMsg(e instanceof Error ? e.message : 'lookup failed');
    } finally {
      setFinding(false);
    }
  }

  // ── received-lines mutators ──
  function addUnit(item_code: string, name: string, delta = 1) {
    setReceived((prev) => {
      const next = new Map(prev);
      const cur = next.get(item_code);
      next.set(
        item_code,
        cur
          ? { ...cur, qty: cur.qty + delta }
          : { item_code, name, qty: delta, excluded: false, excluded_qty: null, exclude_reason: null, label: null, dimension_weight: null }
      );
      return next;
    });
  }
  // direct qty entry on a line's counter field (creates the line on first edit; clamps excluded ≤ qty).
  function setQty(item_code: string, name: string, qty: number) {
    setReceived((prev) => {
      const next = new Map(prev);
      const cur = next.get(item_code);
      if (cur) {
        const patch: Partial<ReceiveLine> = { qty };
        if (cur.excluded_qty != null) patch.excluded_qty = Math.min(cur.excluded_qty, Math.max(qty, 0));
        next.set(item_code, { ...cur, ...patch });
      } else {
        next.set(item_code, { item_code, name, qty, excluded: false, excluded_qty: null, exclude_reason: null, label: null, dimension_weight: null });
      }
      return next;
    });
  }
  function setField(item_code: string, patch: Partial<ReceiveLine>) {
    setReceived((prev) => {
      const next = new Map(prev);
      const cur = next.get(item_code);
      if (cur) next.set(item_code, { ...cur, ...patch });
      return next;
    });
  }
  function removeReceived(item_code: string) {
    setReceived((prev) => {
      const next = new Map(prev);
      next.delete(item_code);
      return next;
    });
  }

  // ── scan → preloaded map, else server resolveBarcode (collision / not-found) ──
  async function doScan() {
    const code = scan.trim();
    if (!code || !detail) return;
    setScan('');
    setPicker(null);
    setStub(null);

    const owners = barcodeMap.get(code);
    if (owners && owners.length === 1) {
      addUnit(owners[0], expectedNameByCode.get(owners[0]) ?? owners[0]);
      setScanMsg(`✓ ${owners[0]} +1`);
      return;
    }
    // 0 expected owners, or >1 (a shared barcode) → server resolve: resolved / collision picker / not-found
    try {
      const res = await resolveBarcode(code);
      if (res.status === 'resolved') {
        addUnit(res.sku.item_code, res.sku.name);
        setScanMsg(`✓ ${res.sku.item_code} +1`);
      } else if (res.status === 'collision') {
        setPicker(res.skus);
        setScanMsg(`⚠ barcode ${code} → ${res.skus.length} SKUs — pick one`);
      } else {
        setStub({ barcode: code, item_code: '', name: '', brand: '' });
        setScanMsg(`unknown barcode ${code} — add a new SKU`);
      }
    } catch (e) {
      setScanMsg(e instanceof Error ? e.message : 'scan failed');
    }
  }

  function pick(sku: ResolvedSku) {
    addUnit(sku.item_code, sku.name);
    setScanMsg(`✓ ${sku.item_code} +1`);
    setPicker(null);
  }

  async function createStub() {
    if (!stub) return;
    const item_code = stub.item_code.trim();
    if (!item_code) {
      setScanMsg('enter an item code for the new SKU');
      return;
    }
    try {
      const hit = await createCatalogueStub({ item_code, name: stub.name.trim(), brand_prefix: stub.brand.trim() || null, barcode: stub.barcode });
      setStub(null);
      if (mappingRaw) {
        // creating the real SKU for a placeholder line → relink the PO to it, then it becomes countable
        await doMap(hit.item_code, hit.name);
      } else {
        addUnit(hit.item_code, hit.name);
        setScanMsg(`✓ stub ${hit.item_code} created (needs review) +1`);
        if (manualAdd) { setManualAdd(false); clearSearch(); }
      }
    } catch (e) {
      setScanMsg(e instanceof Error ? e.message : 'stub creation failed');
    }
  }

  // relink the placeholder PO(s) on this shipment to a real SKU (map-at-receive), then reload the
  // expected list so the line resolves and can be counted. Falls back to just receiving the unit if no
  // placeholder PO matched (e.g. the line came from shipment contents, not a PO).
  async function doMap(itemCode: string, itemName: string) {
    const shipId = detail?.ship_id;
    if (!shipId || !mappingRaw) return;
    const bc = mapBarcode.trim();
    try {
      const { updated } = await mapPlaceholderPO(shipId, mappingRaw, itemCode);
      // link the captured barcode to the real SKU so future receives auto-resolve via the scan path
      if (bc) { try { await linkBarcode(bc, itemCode); } catch { /* non-fatal — the map still stands */ } }
      const linkedNote = bc ? ` · barcode linked` : '';
      if (updated > 0) {
        const d = await getShipmentForReceive(shipId);
        setDetail(d);
        setScanMsg(`✓ mapped ${mappingRaw} → ${itemCode} (${updated} PO${updated === 1 ? '' : 's'})${linkedNote}`);
      } else {
        addUnit(itemCode, itemName); // nothing to relink → just record what arrived
        setScanMsg(`✓ ${itemCode} +1${linkedNote}`);
      }
    } catch (e) {
      setScanMsg(e instanceof Error ? e.message : 'map failed');
    } finally {
      setManualAdd(false);
      clearSearch();
      setStub(null);
      setMappingRaw(null);
      setMapBarcode('');
    }
  }

  // open the Manual-add modal, optionally pre-filling the search. When rawToMap is set (opened from an
  // unresolved line) the modal is in "map" mode — a pick/new-SKU relinks the placeholder PO.
  function openManualAdd(prefill?: string, rawToMap?: string) {
    setStub(null);
    setSkuSearched(false);
    setSkuHits([]);
    setSkuQuery(prefill ?? '');
    setMappingRaw(rawToMap ?? null);
    setMapBarcode('');
    setManualAdd(true);
  }

  async function runSearch() {
    const _id = ++searchSeq.current;
    const q = skuQuery.trim();
    if (q.length < 3) {
      // <3 chars can't use the shared RPC's pg_trgm index — clear, and don't claim "No results".
      setSkuHits([]);
      setSkuSearched(false);
      return;
    }
    setSearching(true);
    let hits: SkuHit[] = [];
    try {
      hits = await searchSkus(q);
    } catch {
      hits = [];
    }
    if (searchSeq.current !== _id) return; // a newer search superseded this one
    setSkuHits(hits);
    setSearching(false);
    setSkuSearched(true);
  }

  // live search — debounce keystrokes; clear below the 3-char floor (no stale results / spinner)
  useEffect(() => {
    const q = skuQuery.trim();
    if (q.length < 3) { setSkuHits([]); setSkuSearched(false); setSearching(false); return; }
    const t = setTimeout(() => { runSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skuQuery]);

  // clear the manual-search field + results and refocus it (W3). Used by the Clear link and after add.
  function clearSearch() {
    setSkuQuery('');
    setSkuHits([]);
    setSkuSearched(false);
    skuInputRef.current?.focus();
  }

  // ── expected vs received, merged ──
  const expectedByCode = useMemo(() => {
    const m = new Map<string, ExpectedLine>();
    detail?.expected.forEach((e) => {
      if (e.item_code) m.set(e.item_code, e);
    });
    return m;
  }, [detail]);
  const expectedUnresolved = useMemo(() => (detail?.expected ?? []).filter((e) => !e.item_code), [detail]);
  const extras = useMemo(
    () => [...received.values()].filter((l) => !expectedByCode.has(l.item_code)).sort((a, b) => a.name.localeCompare(b.name)),
    [received, expectedByCode]
  );
  const expectedResolved = useMemo(
    () => [...expectedByCode.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [expectedByCode]
  );

  const receivedList = [...received.values()];
  const sellableUnits = receivedList.reduce((s, l) => s + sellableOf(l), 0);
  const saveLines = receivedList.filter((l) => l.qty !== 0);
  const shipIdForSave = mode === 'adhoc' ? adhocShipId.trim() : detail?.ship_id ?? '';
  const canClose = mode === 'shipment' && !!detail?.is_shipment;

  function classify(exp: number, counted: number): ReceiveClass {
    if (exp === 0 && counted !== 0) return 'unexpected';
    if (counted < exp) return 'short';
    if (counted > exp) return 'over';
    return 'ok';
  }

  // build the confirmation-window data: every counted SKU + every expected-but-uncounted (a short).
  function buildConfirmData(): ReceiveConfirmData {
    const rows: ReceiveConfirmRow[] = [];
    const seen = new Set<string>();
    for (const line of received.values()) {
      const exp = expectedByCode.get(line.item_code)?.expected_qty ?? 0;
      rows.push({ item_code: line.item_code, name: line.name, expected: exp, counted: line.qty, excluded_qty: excludedOf(line), cls: classify(exp, line.qty) });
      seen.add(line.item_code);
    }
    for (const e of expectedResolved) {
      if (!e.item_code || seen.has(e.item_code) || e.expected_qty <= 0) continue;
      rows.push({ item_code: e.item_code, name: e.name, expected: e.expected_qty, counted: 0, excluded_qty: 0, cls: 'short' });
    }
    rows.sort((a, b) => a.item_code.localeCompare(b.item_code));
    const shorts = rows.filter((r) => r.counted < r.expected).map((r) => r.item_code);
    return { ship_id: shipIdForSave, is_shipment: !!detail?.is_shipment, rows, shorts };
  }

  // open the §6 window (validate first, same guards as the old direct commit).
  function openConfirm() {
    if (!detail) return;
    setError(null);
    if (!shipIdForSave) {
      setError('A ship id is required (the ad-hoc id, a shipment, or free text).');
      return;
    }
    if (saveLines.length === 0) {
      setError('Add at least one received line (a non-zero qty).');
      return;
    }
    setShowConfirm(true);
  }

  // confirm → one transaction (record_receipt). closeShipment/staff/receiveDate come from the overlay.
  async function doCommit({ closeShipment, staff, receiveDate: rDate }: { closeShipment: boolean; staff: string | null; receiveDate: string }) {
    if (!detail) return;
    setCommitting(true);
    setError(null);
    setActiveStaff(staff); // remember the choice as the default for next time
    try {
      const res = await recordReceipt({
        ship_id: shipIdForSave,
        receive_date: rDate,
        close_shipment: closeShipment && canClose,
        staff,
        lines: saveLines.map((l) => ({
          item_code: l.item_code,
          qty: l.qty,
          excluded: l.excluded,
          excluded_qty: l.excluded_qty,
          exclude_reason: l.exclude_reason?.trim() || null,
          label: l.label,
          dimension_weight: l.dimension_weight?.trim() || null,
        })),
      });
      setResult({ ...res, units: sellableUnits });
      setReverseMsg(null);
      setReverseAsk(false);
      setShowConfirm(false);
      // the inbound rows are now persisted — clear the draft so nothing is double-counted
      setReceived(new Map());
      // refresh the queue; drop the shipment if it was closed
      try {
        setQueue(await getReceiveQueue());
      } catch {
        /* keep current queue on transient error */
      }
      if (res.closed) {
        setDetail(null);
        setSelected(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setCommitting(false);
    }
  }

  // ── reverse the just-confirmed receipt (undo stock + restore PO lines + un-close) ──
  async function doReverse() {
    if (!result) return;
    setReversing(true);
    setError(null);
    try {
      const rev = await reverseReceipt(result.receipt_id);
      const where = rev.stock.map((s) => `${s.item_code}: avail ${s.available}, physical ${s.physical}`).join(' · ');
      setReverseMsg(`Receipt reversed — stock restored.${where ? ' ' + where : ''}`);
      setResult(null);
      setReverseAsk(false);
      try {
        setQueue(await getReceiveQueue());
      } catch {
        /* keep current queue on transient error */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reverse failed.');
    } finally {
      setReversing(false);
    }
  }

  const headerTitle = mode === 'adhoc' ? 'Unmarked shipment' : detail?.ship_id ?? '';

  // PR154 — bodyview: the body shows EITHER the scan-to-find + arrivals list (full width) OR the
  // receive detail with a ← back button; the shell hides the tab bar while the detail is open.
  const body = (
    <>
      <div className="bodyview">
        {/* ── Arrivals list ── */}
        {!selected && (
          <>
            {/* §5 scan-to-find-shipment — Sales-styled search bar; Enter (the scanner's auto-return) submits. */}
            <div className="rcv-find">
              <SearchInput
                value={findScan}
                onChange={setFindScan}
                placeholder="Scan barcode to find an item's shipment"
                ariaLabel="Scan barcode to find an item's shipment"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); findShipment(); } }}
                onClear={() => { setFindMsg(null); setSuggestions(null); setFindNotFound(false); }}
              />
              {finding && <div className="hint">Searching…</div>}
              {findMsg && <div className="hint">{findMsg}</div>}
              {findNotFound && (
                <button className="btn-link" onClick={() => { setFindNotFound(false); setFindMsg(null); setFindScan(''); startAdhoc(); }}>
                  + Receive it as an unmarked shipment
                </button>
              )}
              {suggestions && suggestions.length > 0 && (
                <ul className="rcv-suggest">
                  {suggestions.map((s) => (
                    <li key={s.ship_id}>
                      <button className="rcv-suggest-opt" onClick={() => { setSuggestions(null); setFindScan(''); openShipment(s.ship_id); }}>
                        <span className="fq-id">{s.ship_id}</span>
                        <span>{s.origin_country || '—'}{s.ship_date ? ` · ${s.ship_date}` : ''}</span>
                        <span className="badge ready" style={{ marginLeft: 'auto' }}>order {s.open_qty}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* banners survive a close (detail cleared) → visible back on the list */}
            {reverseMsg && <div className="validation ok">{reverseMsg}</div>}
            {result && renderResultBanner()}

            {sortedQueue.length === 0 && <div className="hint fq-empty">No open shipments.</div>}
            <ul className="fq-list">
              {sortedQueue.map((q) => (
                <li key={q.ship_id}>
                  <button className="fq-row" onClick={() => openShipment(q.ship_id)}>
                    {/* top: ship id (left) · shipped date (right — mirrors Purchasing History Active) */}
                    <div className="fq-row-top">
                      <span className="fq-id">{q.ship_id}</span>
                      <span className="fq-id-sub">shipped {q.ship_date || '—'}</span>
                    </div>
                    {/* second line, left-aligned: item count + the full SKU list (A-Z), else "no list" */}
                    <div className="fq-row-bot">
                      {q.expected_count > 0 ? (
                        <span className="ff-items-skus">
                          {q.expected_count} {q.expected_count === 1 ? 'item' : 'items'}
                          {q.sku_codes.length ? ` · ${q.sku_codes.join(', ')}` : ''}
                        </span>
                      ) : (
                        <span className="badge ready" style={{ marginLeft: 0 }}>no list</span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* ── Receive detail ── */}
        {selected && (
          <>
          <button className="btn-link bv-back" onClick={() => { setSelected(null); setDetail(null); setSuggestions(null); setFindMsg(null); setFindNotFound(false); }}>← back</button>
          <div className="bv-detail">
          {loadingDetail && <div className="fd-empty">Loading…</div>}

          {/* persistent result banner (survives a close, where detail is cleared) + Reverse */}
          {reverseMsg && <div className="validation ok">{reverseMsg}</div>}
          {result && renderResultBanner()}

          {detail && (
            <>
              {/* PR243 header: title left, shipped date top-right (norm); below, the shipment id and the
                  tracking each as a copyable chip (mirrors Sales → Pending). */}
              <div className="fd-head">
                <div className="fd-head-row">
                  <div className="fd-title">{headerTitle}</div>
                  {mode === 'shipment' && detail.ship_date && <span className="fd-date">{detail.ship_date}</span>}
                </div>
                {mode === 'shipment' ? (
                  <div className="fd-idchips">
                    <button className="fd-orderid-chip" onClick={() => copyVal(detail.ship_id, 'ship')} aria-label={copiedKey === 'ship' ? 'Shipment ID copied' : 'Copy shipment ID'} title="Copy shipment ID">
                      <span className="fd-orderid-code">{detail.ship_id}</span>
                      {copiedKey === 'ship' ? <CheckIcon /> : <CopyIcon />}
                    </button>
                    {detail.tracking ? (
                      <button className="fd-orderid-chip" onClick={() => copyVal(detail.tracking!, 'trk')} aria-label={copiedKey === 'trk' ? 'Tracking copied' : 'Copy tracking'} title="Copy tracking">
                        <span className="fd-orderid-code">{[detail.courier, detail.tracking].filter(Boolean).join(' ')}</span>
                        {copiedKey === 'trk' ? <CheckIcon /> : <CopyIcon />}
                      </button>
                    ) : (
                      <span className="fd-idchip-empty">no tracking</span>
                    )}
                    {!detail.is_shipment && <span className="warn-text">not in the shipment ledger</span>}
                  </div>
                ) : (
                  <div className="fd-sub">goods with no shipment ID</div>
                )}
              </div>

              {error && <div className="validation err">{error}</div>}

              {/* Ad-hoc id (editable; operator can override with free text) */}
              {mode === 'adhoc' && (
                <section className="fd-section">
                  <div className="fd-section-head">Unmarked ship id</div>
                  <input
                    type="text"
                    className="rcv-shipid"
                    value={adhocShipId}
                    onChange={(e) => setAdhocShipId(e.target.value)}
                    placeholder="📦YYMMXXX or free text"
                  />
                </section>
              )}

              {/* Items — one section: the scan/manual-add row, then the list. Enter (or the scanner's
                  auto-return) submits a scan; the counter shows received/expected (0/X), directly
                  editable, and each scan +1s the matching line. */}
              <section className="fd-section">
                <div className="fd-section-head">Items</div>
                <div className="rcv-scan-row">
                  <SearchInput
                    className="rcv-scan-search"
                    value={scan}
                    onChange={setScan}
                    placeholder="Scan / type a barcode, then Enter"
                    ariaLabel="Scan or type a barcode"
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doScan(); } }}
                  />
                  <button className="btn-brown btn-ico" onClick={() => openManualAdd()}><PackageIcon />Manual add</button>
                </div>
                {scanMsg && <div className="hint scan-msg">{scanMsg}</div>}

                {/* shared shared-barcode picker (F1) */}
                {picker && (
                  <BarcodePicker skus={picker} imgMap={imgMap} onPick={(s) => pick(s)} onCancel={() => setPicker(null)} />
                )}

                {/* D2 unknown barcode → minimal stub (inline; the Manual-add modal owns its own stub form) */}
                {stub && !manualAdd && (
                  <div className="rcv-stub">
                    <div className="subform-label">+ add new SKU (flagged needs review)</div>
                    <div className="hint">barcode {stub.barcode}</div>
                    <input type="text" placeholder="item code (brand-prefix convention, e.g. APP-300-358)" value={stub.item_code} onChange={(e) => setStub({ ...stub, item_code: e.target.value })} />
                    <input type="text" placeholder="name" value={stub.name} onChange={(e) => setStub({ ...stub, name: e.target.value })} />
                    <input type="text" placeholder="brand prefix (optional)" value={stub.brand} onChange={(e) => setStub({ ...stub, brand: e.target.value })} />
                    <div className="subform-actions">
                      <button className="btn-link" onClick={() => setStub(null)}>cancel</button>
                      <button className="btn-secondary" onClick={createStub}>create + add</button>
                    </div>
                  </div>
                )}

                {detail.expected.length === 0 && extras.length === 0 && (
                  <div className="hint">No item list — scan or use Manual add to record what arrived.</div>
                )}
                <ul className="ff-lines">
                  {expectedResolved.map((e) => renderItemLine(e.item_code!, e.name, e.expected_qty))}
                  {extras.map((line) => renderItemLine(line.item_code, line.name, 0))}

                  {expectedUnresolved.map((e, i) => (
                    <li key={`unres-${i}`} className="ff-line">
                      <button className="rcv-line-head rcv-unres-btn" onClick={() => openManualAdd(e.raw ?? e.name, e.raw ?? e.name)} title="Click to map a SKU">
                        <span className="ff-code">{e.name}</span>
                        <span className="rcv-exp">×{e.expected_qty}</span>
                        <span className="rcv-badge miss">click to map SKU</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Purchasing's per-Ship-ID note (read-only), under the items so the warehouse sees it. */}
              {detail.note && (
                <section className="fd-section">
                  <div className="fd-section-head">Shipment notes</div>
                  <div className="rcv-ship-note">{detail.note}</div>
                </section>
              )}

              {/* Commit bar → opens the §6 confirmation window, where staff + receive date are picked
                  alongside the received/short recap before saving. */}
              <div className="fd-commit">
                <button className="btn-primary" onClick={openConfirm} disabled={committing || saveLines.length === 0 || !shipIdForSave}>
                  {canClose ? 'Mark received' : 'Save inbound'}
                </button>
              </div>
            </>
          )}
          </div>
          </>
        )}
      </div>

      {/* Manual add — compact centered modal. Autocomplete search adds to the received list; when a
          search finds nothing, offer to add the SKU manually (a needs-review stub), mirroring
          Purchasing → manual. Stays open so several SKUs can be added in a row. */}
      {manualAdd && detail && (
        <div className="sc-modal-backdrop" onClick={() => { setManualAdd(false); clearSearch(); setStub(null); setMappingRaw(null); setMapBarcode(''); }}>
          <div className="sc-modal rcv-manual-modal" role="dialog" aria-modal="true" aria-label="Manual add" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head">
              <div className="sc-modal-title">{mappingRaw ? 'Map a SKU' : 'Manual add'}</div>
            </div>
            <div className="sc-modal-body">
              {/* Map mode edits the shipment's open placeholder line: pick an existing SKU below, or
                  create one from the pre-filled code. The optional barcode is linked to the chosen SKU
                  so future receives of this box auto-resolve via the scan path. */}
              {mappingRaw && (
                <>
                  <div className="hint rcv-map-intro">Mapping placeholder <b>{mappingRaw}</b> — this updates the shipment&apos;s open line.</div>
                  <label className="rcv-map-field">
                    <span className="fd-label">Barcode (optional)</span>
                    <input
                      type="text"
                      placeholder="scan / type the box's barcode"
                      value={mapBarcode}
                      onChange={(e) => setMapBarcode(e.target.value)}
                    />
                  </label>
                </>
              )}
              {!stub ? (
                <>
                  <div className="scan-row">
                    <SearchInput
                      ref={skuInputRef}
                      autoFocus
                      placeholder="Code, name, or piece count…"
                      value={skuQuery}
                      onChange={(v) => { setSkuQuery(v); setSkuSearched(false); }}
                      onClear={clearSearch}
                    />
                  </div>
                  {searching && <div className="hint">Searching…</div>}
                  {!searching && skuSearched && skuHits.length === 0 && (
                    <div className="rcv-noresult">
                      <div className="hint"><em>No results.</em></div>
                      <button
                        className="btn-brown btn-ico"
                        onClick={() => setStub({ barcode: '', item_code: mappingRaw ? mappingRaw : skuQuery.trim(), name: '', brand: '' })}
                      >
                        <PackageIcon />
                        {mappingRaw ? 'Create a new SKU + map' : `Add${skuQuery.trim() ? ` “${skuQuery.trim()}”` : ''} as a new SKU`}
                      </button>
                    </div>
                  )}
                  {skuHits.length > 0 && (
                    <ul className="result-list" style={{ marginTop: 6 }}>
                      {skuHits.map((h) => (
                        <li key={h.item_code}>
                          {/* §4a Pattern A: image left, code / name / avail stacked beside (ff-card family) */}
                          <button className="result-item ff-card" onClick={() => { if (mappingRaw) { doMap(h.item_code, h.name); } else { addUnit(h.item_code, h.name); setScanMsg(`✓ ${h.item_code} +1`); clearSearch(); } }}>
                            <SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={SKU_IMG.sm} />
                            <div className="ff-card-info">
                              <div className="ff-card-code">{h.item_code}</div>
                              <div className="ff-card-name">{displayName(h.name, h.item_code)}</div>
                              <div className="ff-card-status">{mappingRaw ? 'tap to map' : `avail ${h.available}`}</div>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : mappingRaw ? (
                // Map mode: just the SKU code, pre-filled from the placeholder. Name/brand are dropped —
                // brand is auto-derived from the code's prefix; the row is flagged needs-review to name later.
                <div className="rcv-stub">
                  <div className="subform-label">Create &amp; map a new SKU (flagged needs review)</div>
                  <label className="rcv-map-field">
                    <span className="fd-label">SKU code</span>
                    <input type="text" placeholder="brand-prefix convention, e.g. APP-300-358" value={stub.item_code} onChange={(e) => setStub({ ...stub, item_code: e.target.value })} />
                  </label>
                  <div className="subform-actions">
                    <button className="btn-link" onClick={() => setStub(null)}>← back to search</button>
                    <button className="btn-primary" onClick={createStub}>Create + map</button>
                  </div>
                </div>
              ) : (
                // Manual add: create a new SKU (needs-review stub) — like Purchasing → manual
                <div className="rcv-stub">
                  <div className="subform-label">+ add new SKU (flagged needs review)</div>
                  <input type="text" placeholder="item code (brand-prefix convention, e.g. APP-300-358)" value={stub.item_code} onChange={(e) => setStub({ ...stub, item_code: e.target.value })} />
                  <input type="text" placeholder="name" value={stub.name} onChange={(e) => setStub({ ...stub, name: e.target.value })} />
                  <input type="text" placeholder="brand prefix (optional)" value={stub.brand} onChange={(e) => setStub({ ...stub, brand: e.target.value })} />
                  <div className="subform-actions">
                    <button className="btn-link" onClick={() => setStub(null)}>← back to search</button>
                    <button className="btn-primary" onClick={createStub}>create + add</button>
                  </div>
                </div>
              )}
            </div>
            <div className="sc-modal-foot">
              <button className="btn-secondary" onClick={() => { setManualAdd(false); clearSearch(); setStub(null); setMappingRaw(null); setMapBarcode(''); }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* §6 pre-submit confirmation window */}
      {showConfirm && detail && (
        <ReceiveConfirm
          data={buildConfirmData()}
          canClose={canClose}
          defaultClose={closeShipment}
          staffOptions={staffOptions}
          defaultStaff={getActiveStaff()}
          defaultDate={receiveDate}
          busy={committing}
          error={error}
          onConfirm={(opts) => doCommit(opts)}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </>
  );

  if (embedded) return body;
  return (
    <div className="ops">
      <AppHeader active="inbound" userEmail={userEmail} />
      {body}
    </div>
  );

  // the post-save result banner + Reverse — shown in the detail AND back on the list after a close
  // (PR154: extracted so both bodyview states render the same block).
  function renderResultBanner() {
    if (!result) return null;
    return (
      <div className="validation ok rcv-result">
        <div>
          Received {result.units} sellable unit{result.units === 1 ? '' : 's'}.{' '}
          {result.closed ? 'Shipment → completed. ' : 'Shipment left open. '}
          {result.stock.map((s) => `${s.item_code}: avail ${s.available}, physical ${s.physical}`).join(' · ')}
        </div>
        <div className="rcv-result-actions">
          {!reverseAsk ? (
            <button className="btn-link" onClick={() => setReverseAsk(true)} disabled={reversing}>Reverse this receipt</button>
          ) : (
            <span className="rcv-reverse-ask">
              Undo this receipt? Stock it added will be reversed.
              <button className="btn-secondary" onClick={() => setReverseAsk(false)} disabled={reversing}>Cancel</button>
              <button className="btn-primary danger" onClick={doReverse} disabled={reversing}>{reversing ? 'Reversing…' : 'Yes, reverse'}</button>
            </span>
          )}
        </div>
      </div>
    );
  }

  // one item row: image · code/name · an editable received/expected (0/X) counter. Each scan +1s the
  // matching line; the counter field accepts direct entry. The exclude/label/dim controls drop in
  // below once the line has been touched.
  function renderItemLine(item_code: string, name: string, exp: number) {
    const line = received.get(item_code);
    const got = line?.qty ?? 0;
    const countCls = got === 0 ? 'zero' : exp > 0 && got < exp ? 'short' : 'ok';
    return (
      <li key={`item-${item_code}`} className="ff-line rcv-item">
        <div className="pend-line">
          <SkuImage status={imgMap[item_code]?.status} displayUrl={imgMap[item_code]?.displayUrl} name={name} size={SKU_IMG.sm} />
          <div className="pend-line-main">
            <span className="ff-code">{item_code}</span>
            <span className="ff-name">{displayName(name, item_code)}</span>
          </div>
          <div className="rcv-count">
            <input
              type="number"
              inputMode="numeric"
              step={1}
              className={`rcv-qty-in ${countCls}`}
              value={got}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setQty(item_code, name, Number.isFinite(n) ? n : 0);
              }}
              aria-label={`received qty for ${item_code}`}
            />
            <span className="rcv-denom">/ {exp > 0 ? exp : '—'}</span>
          </div>
        </div>
        {line && renderControls(line)}
      </li>
    );
  }

  // per-received-line controls: exclude (+ qty/reason) · label · dim/weight · remove
  function renderControls(line: ReceiveLine) {
    const excl = excludedOf(line);
    return (
      <div className="rcv-controls">
        <label className="rcv-ctl rcv-ex">
          <input
            type="checkbox"
            checked={line.excluded}
            onChange={(e) =>
              setField(line.item_code, e.target.checked
                ? { excluded: true, excluded_qty: line.excluded_qty ?? Math.max(line.qty, 0) }
                : { excluded: false, excluded_qty: null, exclude_reason: null })
            }
          />
          <span>exclude</span>
        </label>
        {line.excluded && (
          <>
            <label className="rcv-ctl">
              <span>excl qty</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                className="rcv-qty"
                value={excl}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  setField(line.item_code, { excluded_qty: Number.isFinite(n) ? Math.max(n, 0) : 0 });
                }}
              />
            </label>
            <input
              type="text"
              className="rcv-dim"
              placeholder="reason (e.g. damaged box)"
              value={line.exclude_reason ?? ''}
              onChange={(e) => setField(line.item_code, { exclude_reason: e.target.value })}
            />
          </>
        )}
        <label className="rcv-ctl">
          <span>label</span>
          <IconSelect
            ariaLabel="Inbound label"
            value={line.label ?? ''}
            options={[
              { value: '', label: '—' },
              ...inboundLabels.map((l) => ({ value: l.label, label: l.label, icon: l.icon })),
            ]}
            onChange={(v) => setField(line.item_code, { label: v || null })}
          />
        </label>
        <input
          type="text"
          className="rcv-dim"
          placeholder="dim / weight (optional)"
          value={line.dimension_weight ?? ''}
          onChange={(e) => setField(line.item_code, { dimension_weight: e.target.value })}
        />
        <button className="li-remove" onClick={() => removeReceived(line.item_code)} aria-label="remove line">×</button>
      </div>
    );
  }
}

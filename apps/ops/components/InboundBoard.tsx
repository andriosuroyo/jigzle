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
  remapShipmentSku,
  translateToEnglish,
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
import { isRealName } from '@/components/skuName';
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
// PR243 — 16px action glyphs: the per-line edit pencil + the remove-line trash (mirrors Sales → Pending).
const asvg = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const PencilIcon = () => (<svg {...asvg}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);
const TrashIcon = () => (<svg {...asvg}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>);

// PR257 — a name that's blank or just repeats the item_code is NOT shown (the old "Unmatched item"
// filler is gone): the code stands alone and the SKU is fixed via Edit items / the map flow instead.
// The shared isRealName (PR241) is the rule; rows render the name line conditionally.

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
  // PR257 — the new-SKU stub form: SKU code · original (native) name · translated (English) name ·
  // barcode. `name` is the translated side; brand still auto-derives server-side from the code prefix.
  const [stub, setStub] = useState<{ barcode: string; item_code: string; original: string; name: string } | null>(null);
  const [translating, setTranslating] = useState(false); // the original→English auto-fill in flight

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

  // PR243 — the received line whose per-line editor overlay is open (exclude / label / dim-weight /
  // remove), keyed by item_code. The line data itself stays live in `received`; this just gates the modal.
  const [lineEditCode, setLineEditCode] = useState<string | null>(null);

  // PR257 — the "Edit items" overlay: batch-fix the shipment's lines for ONE thing — the SKU. Each
  // line gets a Change → inline search; a pick re-points the not-yet-received PO lines (resolved code
  // via remapShipmentSku, placeholder via mapPlaceholderPO) and reloads the expected list.
  const [editItems, setEditItems] = useState(false);
  const [eiTarget, setEiTarget] = useState<{ key: string; item_code: string | null; raw: string | null } | null>(null);
  const [eiQuery, setEiQuery] = useState('');
  const [eiHits, setEiHits] = useState<SkuHit[]>([]);
  const [eiSearching, setEiSearching] = useState(false);
  const [eiBusy, setEiBusy] = useState(false);
  const [eiMsg, setEiMsg] = useState<string | null>(null);
  const eiSeq = useRef(0);

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
    eiHits.forEach((h) => set.add(h.item_code));
    picker?.forEach((p) => set.add(p.item_code));
    return [...set];
  }, [detail, received, skuHits, eiHits, picker]);
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
    closeEditItems();
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
        setStub({ barcode: code, item_code: '', original: '', name: '' });
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
      const hit = await createCatalogueStub({ item_code, name: stub.name.trim(), original_name: stub.original.trim() || null, barcode: stub.barcode.trim() || null });
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

  // ── PR257 — Edit items: open/close the overlay and re-point one line's SKU ──
  function openEditItems() {
    setEiTarget(null);
    setEiQuery('');
    setEiHits([]);
    setEiSearching(false);
    setEiMsg(null);
    setEditItems(true);
  }
  function closeEditItems() {
    setEditItems(false);
    setEiTarget(null);
    setEiQuery('');
    setEiHits([]);
    setEiMsg(null);
  }
  async function eiPick(hit: SkuHit) {
    const shipId = detail?.ship_id;
    if (!shipId || !eiTarget) return;
    const fromLabel = eiTarget.item_code ?? eiTarget.raw ?? '';
    setEiBusy(true);
    setEiMsg(null);
    try {
      let updated = 0;
      if (eiTarget.item_code) {
        const res = await remapShipmentSku(shipId, eiTarget.item_code, hit.item_code);
        if (res.error) { setEiMsg(res.error); return; }
        updated = res.updated;
        // a count already entered under the old code follows the re-point (merging if needed)
        const oldCode = eiTarget.item_code;
        setReceived((prev) => {
          const cur = prev.get(oldCode);
          if (!cur) return prev;
          const next = new Map(prev);
          next.delete(oldCode);
          const tgt = next.get(hit.item_code);
          next.set(hit.item_code, tgt ? { ...tgt, qty: tgt.qty + cur.qty } : { ...cur, item_code: hit.item_code, name: hit.name });
          return next;
        });
      } else if (eiTarget.raw) {
        const { updated: u } = await mapPlaceholderPO(shipId, eiTarget.raw, hit.item_code);
        updated = u;
      }
      const d = await getShipmentForReceive(shipId);
      setDetail(d);
      setEiMsg(updated > 0
        ? `✓ ${fromLabel} → ${hit.item_code} (${updated} order line${updated === 1 ? '' : 's'})`
        : `No open order line to update for ${fromLabel} — a contents-only or already-received line stays as is.`);
      setEiTarget(null);
      setEiQuery('');
      setEiHits([]);
    } catch (e) {
      setEiMsg(e instanceof Error ? e.message : 'SKU change failed.');
    } finally {
      setEiBusy(false);
    }
  }

  // ── PR257 — best-effort auto-fill of the stub's Translated name from the Original name (on blur).
  // Only fills an EMPTY translated field — never clobbers something the operator typed. ──
  async function autoTranslate(original: string) {
    const q = original.trim();
    if (!q) return;
    setTranslating(true);
    try {
      const { text } = await translateToEnglish(q);
      if (text) setStub((s) => (s && !s.name.trim() ? { ...s, name: text } : s));
    } finally {
      setTranslating(false);
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

  // PR257 — the Edit-items inline SKU search (same debounce + 3-char floor + stale guard)
  useEffect(() => {
    const q = eiQuery.trim();
    if (q.length < 3) { setEiHits([]); setEiSearching(false); return; }
    const t = setTimeout(async () => {
      const _id = ++eiSeq.current;
      setEiSearching(true);
      let hits: SkuHit[] = [];
      try { hits = await searchSkus(q); } catch { hits = []; }
      if (eiSeq.current !== _id) return;
      setEiHits(hits);
      setEiSearching(false);
    }, 220);
    return () => clearTimeout(t);
  }, [eiQuery]);

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
                <button className="btn-brown btn-ico rcv-find-adhoc" onClick={() => { setFindNotFound(false); setFindMsg(null); setFindScan(''); startAdhoc(); }}>
                  <PackageIcon />Receive as an unmarked shipment
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
                {/* PR257 — Edit items (head-right): batch-fix the lines' SKUs in one overlay */}
                <div className="fd-section-head fd-section-head-row">
                  <span>Items</span>
                  {detail.expected.length > 0 && (
                    <button className="btn-link rcv-edit-items" onClick={openEditItems}><PencilIcon />Edit items</button>
                  )}
                </div>
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
                    <div className="subform-label">Add new SKU (flagged needs review)</div>
                    <div className="hint">barcode {stub.barcode}</div>
                    <input type="text" placeholder="SKU code (brand-prefix convention, e.g. APP-300-358)" value={stub.item_code} onChange={(e) => setStub({ ...stub, item_code: e.target.value })} />
                    <input type="text" placeholder="original name" value={stub.original} onChange={(e) => setStub({ ...stub, original: e.target.value })} onBlur={(e) => autoTranslate(e.target.value)} />
                    <input type="text" placeholder="translated name (English)" value={stub.name} onChange={(e) => setStub({ ...stub, name: e.target.value })} />
                    {translating && <div className="hint"><em>Translating…</em></div>}
                    <div className="subform-actions">
                      <button className="btn-link" onClick={() => setStub(null)}>cancel</button>
                      <button className="btn-primary" onClick={createStub}>create + add</button>
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
                      placeholder="SKU, name, or piece count…"
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
                        onClick={() => setStub({ barcode: '', item_code: mappingRaw ? mappingRaw : skuQuery.trim(), original: '', name: '' })}
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
                              {isRealName(h.name, h.item_code) && <div className="ff-card-name">{h.name}</div>}
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
                // Manual add: create a new SKU (needs-review stub). PR257 — four fields: SKU (pre-
                // filled from the search), original (native) name, translated name (auto-filled from
                // the original via best-effort translation), and an optional barcode to link.
                <div className="rcv-stub">
                  <div className="subform-label">+ add new SKU (flagged needs review)</div>
                  <input type="text" placeholder="SKU code (brand-prefix convention, e.g. APP-300-358)" value={stub.item_code} onChange={(e) => setStub({ ...stub, item_code: e.target.value })} />
                  <input type="text" placeholder="original name" value={stub.original} onChange={(e) => setStub({ ...stub, original: e.target.value })} onBlur={(e) => autoTranslate(e.target.value)} />
                  <input type="text" placeholder="translated name (English)" value={stub.name} onChange={(e) => setStub({ ...stub, name: e.target.value })} />
                  {translating && <div className="hint"><em>Translating…</em></div>}
                  <input type="text" placeholder="barcode (optional)" value={stub.barcode} onChange={(e) => setStub({ ...stub, barcode: e.target.value })} />
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

      {/* PR257 — Edit items: every shipment line with a Change → inline SKU search. A pick re-points
          the not-yet-received PO lines to the chosen SKU and reloads the expected list; the overlay
          stays open so several lines can be fixed in a row. */}
      {editItems && detail && (
        <div className="sc-modal-backdrop" onClick={() => { if (!eiBusy) closeEditItems(); }}>
          <div className="sc-modal rcv-manual-modal" role="dialog" aria-modal="true" aria-label="Edit items" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <div className="sc-modal-title">Edit items · SKU</div>
              <button className="sc-modal-x" onClick={closeEditItems} aria-label="Close" disabled={eiBusy}>×</button>
            </div>
            <div className="sc-modal-body">
              <div className="hint" style={{ marginBottom: 8 }}>Tap Change to re-point a line to a different SKU (not-yet-received order lines only).</div>
              {eiMsg && <div className="hint scan-msg">{eiMsg}</div>}
              <ul className="ei-lines">
                {detail.expected.map((e, i) => {
                  const code = e.item_code ?? e.raw ?? '—';
                  const key = e.item_code ?? `raw:${e.raw ?? i}`;
                  const active = eiTarget?.key === key;
                  return (
                    <li key={key} className="ei-line">
                      <div className="ei-row">
                        <SkuImage status={imgMap[e.item_code ?? '']?.status} displayUrl={imgMap[e.item_code ?? '']?.displayUrl} name={e.name} size={SKU_IMG.sm} />
                        <div className="ei-main">
                          <span className="ff-code">{code}</span>
                          {isRealName(e.name, code) && <span className="ff-name">{e.name}</span>}
                        </div>
                        <span className="rcv-exp">×{e.expected_qty}</span>
                        <button
                          className="btn-link"
                          onClick={() => { setEiTarget(active ? null : { key, item_code: e.item_code, raw: e.raw }); setEiQuery(''); setEiHits([]); }}
                          disabled={eiBusy}
                        >
                          {active ? 'cancel' : 'Change'}
                        </button>
                      </div>
                      {active && (
                        <div className="ei-search">
                          <SearchInput autoFocus placeholder="search SKU by code / name" value={eiQuery} onChange={setEiQuery} />
                          {eiSearching && <div className="hint">Searching…</div>}
                          {!eiSearching && eiQuery.trim().length >= 3 && eiHits.length === 0 && <div className="hint"><em>No results.</em></div>}
                          {eiHits.length > 0 && (
                            <ul className="result-list" style={{ marginTop: 6 }}>
                              {eiHits.map((h) => (
                                <li key={h.item_code}>
                                  <button className="result-item ff-card" onClick={() => eiPick(h)} disabled={eiBusy}>
                                    <SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={SKU_IMG.sm} />
                                    <div className="ff-card-info">
                                      <div className="ff-card-code">{h.item_code}</div>
                                      {isRealName(h.name, h.item_code) && <div className="ff-card-name">{h.name}</div>}
                                      <div className="ff-card-status">{eiBusy ? 'working…' : 'tap to use this SKU'}</div>
                                    </div>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="sc-modal-foot">
              <button className="btn-secondary" onClick={closeEditItems} disabled={eiBusy}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* PR243 — per-line editor overlay (exclude / label / dim-weight / remove) */}
      {renderLineEditor()}

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
    const excl = line ? excludedOf(line) : 0;
    return (
      <li key={`item-${item_code}`} className="ff-line rcv-item">
        <div className="pend-line">
          <SkuImage status={imgMap[item_code]?.status} displayUrl={imgMap[item_code]?.displayUrl} name={name} size={SKU_IMG.sm} />
          <div className="pend-line-main">
            <span className="ff-code">{item_code}</span>
            {isRealName(name, item_code) && <span className="ff-name">{name}</span>}
            {/* touched-line summary: only surface exclude/label/dim when set, so the row stays clean */}
            {line && (excl > 0 || line.label || line.dimension_weight) && (
              <span className="rcv-line-tags">
                {excl > 0 && <span className="rcv-tag danger">−{excl} excluded</span>}
                {line.label && <span className="rcv-tag">{line.label}</span>}
                {line.dimension_weight && <span className="rcv-tag">{line.dimension_weight}</span>}
              </span>
            )}
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
          {line && (
            <button className="btn-edit" onClick={() => setLineEditCode(item_code)} aria-label="Edit line" title="Edit line"><PencilIcon /></button>
          )}
        </div>
      </li>
    );
  }

  // PR243 — per-line editor overlay (opened by the row pencil): exclude (+ qty/reason), inbound label,
  // dim/weight, and remove-line. Edits apply live to the received line; "Done" just closes it.
  function renderLineEditor() {
    if (!lineEditCode) return null;
    const line = received.get(lineEditCode);
    if (!line) return null;
    const excl = excludedOf(line);
    const close = () => setLineEditCode(null);
    return (
      <div className="sc-modal-backdrop" onClick={close}>
        <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Edit line" onClick={(e) => e.stopPropagation()}>
          <div className="sc-modal-head sc-modal-head-row">
            <span className="sc-modal-title">Edit line · {line.item_code}</span>
            <button className="sc-modal-x" onClick={close} aria-label="Close">×</button>
          </div>
          <div className="sc-modal-body rcv-le-body">
            <label className="rcv-le-check">
              <input
                type="checkbox"
                checked={line.excluded}
                onChange={(e) =>
                  setField(line.item_code, e.target.checked
                    ? { excluded: true, excluded_qty: line.excluded_qty ?? Math.max(line.qty, 0) }
                    : { excluded: false, excluded_qty: null, exclude_reason: null })
                }
              />
              <span>Exclude damaged / not-sellable units</span>
            </label>
            {line.excluded && (
              <div className="rcv-le-excl">
                <div className="rcv-le-field rcv-le-field-sm">
                  <span className="fd-label">Excluded qty</span>
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
                </div>
                <div className="rcv-le-field">
                  <span className="fd-label">Reason</span>
                  <input
                    type="text"
                    placeholder="e.g. damaged box"
                    value={line.exclude_reason ?? ''}
                    onChange={(e) => setField(line.item_code, { exclude_reason: e.target.value })}
                  />
                </div>
              </div>
            )}
            <div className="rcv-le-field">
              <span className="fd-label">Label</span>
              <IconSelect
                ariaLabel="Inbound label"
                value={line.label ?? ''}
                options={[
                  { value: '', label: '—' },
                  ...inboundLabels.map((l) => ({ value: l.label, label: l.label, icon: l.icon })),
                ]}
                onChange={(v) => setField(line.item_code, { label: v || null })}
              />
            </div>
            <div className="rcv-le-field">
              <span className="fd-label">Dim / weight <em>(optional)</em></span>
              <input
                type="text"
                placeholder="e.g. 30×20×10, 1.2kg"
                value={line.dimension_weight ?? ''}
                onChange={(e) => setField(line.item_code, { dimension_weight: e.target.value })}
              />
            </div>
          </div>
          <div className="sc-modal-foot le-foot">
            <button className="btn-primary" onClick={close}>Done</button>
            <button className="btn-danger btn-ico le-del" onClick={() => { removeReceived(line.item_code); close(); }}><TrashIcon />Remove line</button>
          </div>
        </div>
      </div>
    );
  }
}

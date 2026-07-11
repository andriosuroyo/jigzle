'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import type { ExpectedLine, ReceiveLine, ReceiveQueueRow } from '@jigzle/db/types';
import {
  getReceiveQueue,
  getShipmentForReceive,
  resolveBarcode,
  searchSkus,
  createCatalogueStub,
  mapPlaceholderPO,
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
import BarcodePicker from '@/components/BarcodePicker';
import ReceiveConfirm from '@/components/ReceiveConfirm';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import { getActiveStaff, setActiveStaff } from '@/components/staffStore';
import { saveDraft, loadDraft, clearDraft, listDraftKeys } from '@/components/draftStore';
import SearchInput from '@/components/SearchInput';
import { PackageIcon } from '@/components/AddIcons';
import { useEscToClose, useOverlayClose } from '@/components/useOverlayClose';
import { fmtNiceDate } from '@jigzle/lib';

// PR243 — copy/check glyphs for the header id chips (mirrors Sales → Pending/History).
const csvg = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const CopyIcon = () => (<svg {...csvg}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>);
const CheckIcon = () => (<svg {...csvg}><polyline points="20 6 9 17 4 12" /></svg>);
// PR243 — 16px action glyphs: the per-line edit pencil + the remove-line trash (mirrors Sales → Pending).
const asvg = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const TrashIcon = () => (<svg {...asvg}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>);
// PR262 — the "Mark received / Save inbound" commit-button glyph (an inbox — goods into stock).
const InboxIcon = () => (<svg {...asvg}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>);
// PR289 — exclude (damaged / not-sellable): a no-entry circle with a slash.
const ExcludeIcon = () => (<svg {...asvg}><circle cx="12" cy="12" r="9" /><line x1="5.6" y1="5.6" x2="18.4" y2="18.4" /></svg>);

// PR257 — a name that's blank or just repeats the item_code is NOT shown (the old "Unmatched item"
// filler is gone): the code stands alone. A placeholder line is resolved via the per-line "map SKU"
// here; correcting an already-resolved line's SKU lives in Purchasing → History (PR262).
// The shared isRealName (PR241) is the rule; rows render the name line conditionally.

function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// PR288 — a value that STARTS with 3+ letters then a "-" reads as a SKU code (APP-300-358); anything
// else (mostly digit barcodes) reads as a barcode. Drives which field a new-SKU form pre-fills.
const looksLikeSku = (s: string): boolean => /^[A-Za-z]{3,}-/.test(s.trim());
type NewSkuStub = { barcode: string; item_code: string; original: string; name: string };
const prefillStub = (v: string): NewSkuStub =>
  looksLikeSku(v)
    ? { barcode: '', item_code: v.trim(), original: '', name: '' }
    : { barcode: v.trim(), item_code: '', original: '', name: '' };

// the synthetic detail for an ad-hoc receive (no shipments-ledger row, no expected list)
const ADHOC_SENTINEL = '__adhoc__';

// PR259 — draft persistence keys. A real shipment's in-progress count is keyed by its ship_id (so
// juggling several open shipments each keeps its own draft); the unmarked/ad-hoc receive uses ONE
// fixed key (you do one at a time) so it can be resumed after a reload even though its id regenerates.
const DRAFT_PREFIX = 'jz:inbound:draft:';
const DRAFT_SHIP_PREFIX = DRAFT_PREFIX + 'ship:';
const ADHOC_DRAFT_KEY = DRAFT_PREFIX + 'adhoc';
const draftKeyForShip = (shipId: string) => DRAFT_SHIP_PREFIX + shipId;
// what a persisted receive draft holds — the counts plus the header choices, replayed on restore.
type InboundDraft = {
  received: [string, ReceiveLine][]; // Map entries
  receiveDate: string;
  closeShipment: boolean;
  adhocShipId?: string; // ad-hoc mode only — resume keeps the original id
};

// effective excluded count for a draft line: explicit excluded_qty, else the legacy whole-line flag.
function excludedOf(l: ReceiveLine): number {
  return l.excluded_qty ?? (l.excluded ? Math.max(l.qty, 0) : 0);
}
function sellableOf(l: ReceiveLine): number {
  return l.qty - excludedOf(l);
}

export default function InboundBoard({
  initialQueue,
  // inboundLabels is still threaded from Settings but the per-line label picker was dropped (PR289);
  // it's kept in the props shape so the shell/loader plumbing stays valid.
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

  // PR259 — draft persistence. `hydratingRef` gates the persist effect while a session is opening, so
  // resetDraft()'s momentary empty map can't clobber the very draft we're about to restore.
  // `restoredCount` drives the "restored N lines" banner; `draftIndex` badges list rows / resume ad-hoc.
  const hydratingRef = useRef(false);
  const [restoredCount, setRestoredCount] = useState(0);
  const [draftIndex, setDraftIndex] = useState<{ ships: Set<string>; adhoc: boolean }>({ ships: new Set(), adhoc: false });
  const refreshDraftIndex = useCallback(() => {
    const ships = new Set<string>();
    let adhoc = false;
    for (const k of listDraftKeys(DRAFT_PREFIX)) {
      if (k === ADHOC_DRAFT_KEY) adhoc = true;
      else if (k.startsWith(DRAFT_SHIP_PREFIX)) ships.add(k.slice(DRAFT_SHIP_PREFIX.length));
    }
    setDraftIndex({ ships, adhoc });
  }, []);
  useEffect(() => { refreshDraftIndex(); }, [refreshDraftIndex]);

  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [picker, setPicker] = useState<ResolvedSku[] | null>(null);
  // PR257 — the new-SKU stub form: SKU code · original (native) name · translated (English) name ·
  // barcode. `name` is the translated side; brand still auto-derives server-side from the code prefix.
  const [stub, setStub] = useState<{ barcode: string; item_code: string; original: string; name: string } | null>(null);
  const [stubTouched, setStubTouched] = useState(false); // PR288: user edited the new-SKU form → stop tracking the query
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

  // PR262 — SKU corrections for a shipment line moved to Purchasing → History → item detail. Inbound
  // keeps only the per-line "map SKU" for unresolved/placeholder lines (identifying an arriving box).

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

  // PR307 — shared overlay-close. The Manual-add overlay is a dirty create-form (typed search / new-SKU
  // stub / barcode) → its close routes through a discard confirm; the per-line editor (renderLineEditor)
  // applies live with no separate save, so it's Esc-only.
  const manualClose = useOverlayClose({
    open: manualAdd && !!detail,
    onClose: () => { setManualAdd(false); clearSearch(); setStub(null); setMappingRaw(null); setMapBarcode(''); },
    dirty: !!(skuQuery.trim() || mapBarcode.trim() || (stub && (stub.item_code || stub.original || stub.name || stub.barcode))),
  });
  useEscToClose(lineEditCode !== null, () => setLineEditCode(null));

  // PR259 — persist the in-progress count as it changes (skipped while a session is hydrating). A
  // non-empty draft is saved under the session's key; emptying it (or committing) clears the draft.
  useEffect(() => {
    if (!selected || hydratingRef.current) return;
    const key = mode === 'adhoc' ? ADHOC_DRAFT_KEY : draftKeyForShip(selected);
    if (received.size > 0) {
      saveDraft<InboundDraft>(key, {
        received: [...received.entries()],
        receiveDate,
        closeShipment,
        adhocShipId: mode === 'adhoc' ? adhocShipId : undefined,
      });
    } else {
      clearDraft(key);
    }
    refreshDraftIndex();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [received, receiveDate, closeShipment, adhocShipId, selected, mode]);

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

  // PR259 — throw away the current session's saved + in-memory draft (from the "restored" banner).
  function discardDraft() {
    if (selected) clearDraft(mode === 'adhoc' ? ADHOC_DRAFT_KEY : draftKeyForShip(selected));
    setReceived(new Map());
    setRestoredCount(0);
    refreshDraftIndex();
  }

  async function openShipment(shipId: string) {
    const myReq = ++reqIdRef.current;
    hydratingRef.current = true; // gate the persist effect until this session's draft is restored
    setSelected(shipId);
    setMode('shipment');
    setAdhocShipId('');
    setDetail(null);
    resetDraft();
    setCloseShipment(true);
    setSuggestions(null);
    setFindMsg(null);
    setRestoredCount(0);
    setLoadingDetail(true);
    try {
      const d = await getShipmentForReceive(shipId);
      if (reqIdRef.current !== myReq) return; // superseded by a newer selection
      setDetail(d);
      // PR259 — restore any saved in-progress count for this shipment (survives deploy reloads etc.)
      const draft = loadDraft<InboundDraft>(draftKeyForShip(shipId));
      if (draft && draft.received.length) {
        setReceived(new Map(draft.received));
        setReceiveDate(draft.receiveDate || todayStr());
        setCloseShipment(draft.closeShipment);
        setRestoredCount(draft.received.length);
      }
    } catch (e) {
      if (reqIdRef.current !== myReq) return;
      setError(e instanceof Error ? e.message : 'Failed to load shipment.');
    } finally {
      // only the latest selection clears the gate (rapid switching: an older call mustn't ungate a newer)
      if (reqIdRef.current === myReq) { setLoadingDetail(false); hydratingRef.current = false; }
    }
  }

  async function startAdhoc() {
    const myReq = ++reqIdRef.current;
    hydratingRef.current = true;
    setSelected(ADHOC_SENTINEL);
    setMode('adhoc');
    setDetail({ ship_id: '', origin_country: null, ship_date: null, tracking: null, courier: null, note: null, is_shipment: false, expected: [], barcodes: [] });
    resetDraft();
    setCloseShipment(false);
    setAdhocShipId('');
    setSuggestions(null);
    setFindMsg(null);
    setRestoredCount(0);

    // PR259 — resume a saved unmarked receive if one exists (keep its original id; don't allocate anew).
    const draft = loadDraft<InboundDraft>(ADHOC_DRAFT_KEY);
    if (draft && draft.received.length && draft.adhocShipId) {
      setReceived(new Map(draft.received));
      setReceiveDate(draft.receiveDate || todayStr());
      setAdhocShipId(draft.adhocShipId);
      setRestoredCount(draft.received.length);
      hydratingRef.current = false;
      return;
    }

    setLoadingDetail(true);
    try {
      const id = await newAdhocShipId();
      if (reqIdRef.current !== myReq) return;
      setAdhocShipId(id);
    } catch (e) {
      if (reqIdRef.current !== myReq) return;
      setError(e instanceof Error ? e.message : 'Failed to allocate an ad-hoc id.');
    } finally {
      if (reqIdRef.current === myReq) { setLoadingDetail(false); hydratingRef.current = false; }
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
        // PR288 — unknown → open Manual add prefilled with the scan; the form pre-fills the right field.
        // PR311 — no inline "unknown …" note: the Manual-add overlay opening is the feedback.
        openManualAdd(code);
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
    // PR288 — manual add seeds the new-SKU form live from the query (map mode keeps its button flow).
    setStub(rawToMap ? null : prefillStub(prefill ?? ''));
    setStubTouched(false);
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
    setStubTouched(false); // PR288 — reset the new-SKU form's tracking
    skuInputRef.current?.focus();
  }

  // PR288 — while the user hasn't edited the new-SKU form, keep its SKU/barcode field tracking the
  // search query (so a scan or typed value flows straight into the right field). Manual add only.
  useEffect(() => {
    if (!manualAdd || mappingRaw || stubTouched) return;
    setStub(prefillStub(skuQuery));
  }, [skuQuery, manualAdd, mappingRaw, stubTouched]);

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
      // the inbound rows are now persisted — clear the draft so nothing is double-counted (both the
      // in-memory map and its localStorage copy, incl. when the shipment closes and detail is dropped).
      clearDraft(mode === 'adhoc' ? ADHOC_DRAFT_KEY : draftKeyForShip(shipIdForSave));
      setReceived(new Map());
      setRestoredCount(0);
      refreshDraftIndex();
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

  const headerTitle = mode === 'adhoc' ? 'Add unmarked items' : detail?.ship_id ?? '';

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
                        <span>{s.origin_country || '—'}{s.ship_date ? ` · ${fmtNiceDate(s.ship_date)}` : ''}</span>
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

            {/* PR259 — a saved unmarked receive from a prior session (e.g. a deploy reloaded the tab). */}
            {draftIndex.adhoc && (
              <button className="btn-brown btn-ico rcv-resume-draft" onClick={() => startAdhoc()}>
                <PackageIcon />Resume your in-progress unmarked receive
              </button>
            )}

            {sortedQueue.length === 0 && <div className="hint fq-empty">No open shipments.</div>}
            <ul className="fq-list">
              {sortedQueue.map((q) => (
                <li key={q.ship_id}>
                  <button className="fq-row" onClick={() => openShipment(q.ship_id)}>
                    <div className="fq-row-main">
                      {/* top: ship id (left) · shipped date (right — mirrors Purchasing History Active) */}
                      <div className="fq-row-top">
                        <span className="fq-id">{q.ship_id}</span>
                        {/* PR259 — badge a shipment that has an unsaved in-progress count waiting to resume */}
                        {draftIndex.ships.has(q.ship_id) && <span className="badge draft">in-progress</span>}
                        <span className="fq-id-sub" style={{ marginLeft: 'auto' }}>shipped {fmtNiceDate(q.ship_date) || '—'}</span>
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
                    </div>
                    <span className="po-chev" aria-hidden>›</span>
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
                  {mode === 'shipment' && detail.ship_date && <span className="fd-date">{fmtNiceDate(detail.ship_date)}</span>}
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
                ) : null}
              </div>

              {error && <div className="validation err">{error}</div>}

              {/* PR259 — restored a saved in-progress count (e.g. a deploy reloaded the tab mid-receive). */}
              {restoredCount > 0 && (
                <div className="validation ok rcv-restored">
                  <span>Restored {restoredCount} in-progress line{restoredCount === 1 ? '' : 's'} from your last session.</span>
                  <button className="btn-link" onClick={discardDraft}>discard</button>
                </div>
              )}

              {/* Ad-hoc id (editable; operator can override with free text) */}
              {mode === 'adhoc' && (
                <section className="fd-section">
                  <div className="fd-section-head">Unmarked shipment id</div>
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

                {/* PR288 — an unknown scan now opens the Manual-add overlay (prefilled); no inline stub here. */}

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
                <button className="btn-primary btn-ico" onClick={openConfirm} disabled={committing || saveLines.length === 0 || !shipIdForSave}>
                  <InboxIcon />{canClose ? 'Mark received' : 'Save inbound'}
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
        <div className="sc-modal-backdrop" onClick={manualClose.requestClose}>
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
              {mappingRaw ? (
                // ── MAP MODE (unchanged): search → pick, or create+map a new SKU from the placeholder ──
                !stub ? (
                  <>
                    <div className="scan-row">
                      <SearchInput ref={skuInputRef} autoFocus placeholder="Search by SKU, original name or barcode" value={skuQuery} onChange={(v) => { setSkuQuery(v); setSkuSearched(false); }} onClear={clearSearch} />
                    </div>
                    {searching && <div className="hint">Searching…</div>}
                    {!searching && skuSearched && skuHits.length === 0 && (
                      <div className="rcv-noresult">
                        <div className="hint"><em>No results.</em></div>
                        <button className="btn-brown btn-ico" onClick={() => setStub({ barcode: '', item_code: mappingRaw, original: '', name: '' })}><PackageIcon />Create a new SKU + map</button>
                      </div>
                    )}
                    {skuHits.length > 0 && (
                      <ul className="result-list" style={{ marginTop: 6 }}>
                        {skuHits.map((h) => (
                          <li key={h.item_code}>
                            <button className="result-item ff-card" onClick={() => doMap(h.item_code, h.name)}>
                              <SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={SKU_IMG.sm} />
                              <div className="ff-card-info"><div className="ff-card-code">{h.item_code}</div>{isRealName(h.name, h.item_code) && <div className="ff-card-name">{h.name}</div>}<div className="ff-card-status">tap to map</div></div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
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
                )
              ) : (
                // ── MANUAL ADD (PR288): search stays visible (so a scan/typed value keeps flowing in);
                // when nothing matches, the four-field new-SKU form appears inline, pre-filled per the
                // SKU-vs-barcode heuristic (ABC-123 → SKU code; 1234567890 → barcode). ──
                <>
                  <div className="scan-row">
                    <SearchInput ref={skuInputRef} autoFocus placeholder="Search by SKU, original name or barcode" value={skuQuery} onChange={(v) => { setSkuQuery(v); setSkuSearched(false); }} onClear={clearSearch} />
                  </div>
                  {searching && <div className="hint">Searching…</div>}
                  {skuHits.length > 0 && (
                    <ul className="result-list" style={{ marginTop: 6 }}>
                      {skuHits.map((h) => (
                        <li key={h.item_code}>
                          <button className="result-item ff-card" onClick={() => { addUnit(h.item_code, h.name); setScanMsg(`✓ ${h.item_code} +1`); clearSearch(); }}>
                            <SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={SKU_IMG.sm} />
                            <div className="ff-card-info"><div className="ff-card-code">{h.item_code}</div>{isRealName(h.name, h.item_code) && <div className="ff-card-name">{h.name}</div>}<div className="ff-card-status">avail {h.available}</div></div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!searching && skuSearched && skuHits.length === 0 && stub && (
                    <div className="rcv-stub" style={{ marginTop: 8 }}>
                      <div className="subform-label">No match — add new SKU</div>
                      <input type="text" placeholder="SKU code (brand-prefix convention, e.g. APP-300-358)" value={stub.item_code} onChange={(e) => { setStubTouched(true); setStub({ ...stub, item_code: e.target.value }); }} />
                      <input type="text" placeholder="original name" value={stub.original} onChange={(e) => { setStubTouched(true); setStub({ ...stub, original: e.target.value }); }} onBlur={(e) => autoTranslate(e.target.value)} />
                      <input type="text" placeholder="translated name (English)" value={stub.name} onChange={(e) => { setStubTouched(true); setStub({ ...stub, name: e.target.value }); }} />
                      {translating && <div className="hint"><em>Translating…</em></div>}
                      <input type="text" placeholder="barcode (optional)" value={stub.barcode} onChange={(e) => { setStubTouched(true); setStub({ ...stub, barcode: e.target.value }); }} />
                      {/* PR312 — the create button moved to the footer (Cancel · Add item), aligned right. */}
                    </div>
                  )}
                </>
              )}
            </div>
            {/* PR312 — modal-footer standard: Cancel left, primary (Add item) right. The create button
                shows only while the no-match new-SKU form is up (manual-add mode). */}
            <div className="sc-modal-foot">
              <button className="btn-secondary" onClick={manualClose.requestClose}>Cancel</button>
              {!mappingRaw && !searching && skuSearched && skuHits.length === 0 && stub && (
                <button className="btn-primary" onClick={createStub} disabled={!stub.item_code.trim()} title={!stub.item_code.trim() ? 'Enter a SKU code' : undefined}>Add item</button>
              )}
            </div>
          </div>
          {manualClose.confirm}
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
          </div>
          <div className="rcv-count">
            {/* PR289 — easy-adjust qty stepper (− input +). The predicted denom shows only when there's
                an expected qty; unmarked/manual lines are just a qty. */}
            <span className="qty-step">
              <button type="button" aria-label="one fewer" onClick={() => setQty(item_code, name, Math.max(0, got - 1))} disabled={got <= 0}>−</button>
              <input
                type="number"
                inputMode="numeric"
                step={1}
                className={`rcv-qty-in ${countCls}`}
                value={got}
                onChange={(e) => { const n = parseInt(e.target.value, 10); setQty(item_code, name, Number.isFinite(n) ? n : 0); }}
                aria-label={`received qty for ${item_code}`}
              />
              <button type="button" aria-label="one more" onClick={() => setQty(item_code, name, got + 1)}>+</button>
            </span>
            {exp > 0 && <span className="rcv-denom">/ {exp}</span>}
            {/* PR289 — excluded shows as a large −N beside the qty (same size as the count) */}
            {excl > 0 && <span className="rcv-excl-big">−{excl}</span>}
          </div>
          {line && (
            <button className="btn-edit rcv-excl-btn" onClick={() => setLineEditCode(item_code)} aria-label="Exclude units" title="Exclude damaged / not-sellable units"><ExcludeIcon /></button>
          )}
        </div>
      </li>
    );
  }

  // PR289 — per-line EXCLUDE overlay (opened by the row's exclude button): just excluded qty + reason.
  // (Label = Hold/Tokopedia and Dim/weight were relics of the old flow — dropped.) A damaged unit still
  // arrived, so it's scanned into the count; excluding it keeps it out of sellable stock.
  function renderLineEditor() {
    if (!lineEditCode) return null;
    const line = received.get(lineEditCode);
    if (!line) return null;
    const excl = excludedOf(line);
    const close = () => setLineEditCode(null);
    return (
      <div className="sc-modal-backdrop" onClick={close}>
        <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Exclude units" onClick={(e) => e.stopPropagation()}>
          <div className="sc-modal-head sc-modal-head-row">
            <span className="sc-modal-title">Exclude · {line.item_code}</span>
            <button className="sc-modal-x" onClick={close} aria-label="Close">×</button>
          </div>
          <div className="sc-modal-body rcv-le-body">
            <div className="hint">A damaged / not-sellable unit still arrived — scan it into the count, then record how many to keep out of sellable stock.</div>
            <div className="rcv-le-field rcv-le-field-sm">
              <span className="fd-label">Excluded qty</span>
              <input
                type="number"
                inputMode="numeric"
                step={1}
                className="rcv-qty"
                value={excl}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  const v = Number.isFinite(n) ? Math.abs(n) : 0;
                  setField(line.item_code, { excluded: v > 0, excluded_qty: v });
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
          <div className="sc-modal-foot le-foot">
            <button className="btn-primary" onClick={close}>Done</button>
            <button className="btn-danger btn-ico le-del" onClick={() => { removeReceived(line.item_code); close(); }}><TrashIcon />Remove line</button>
          </div>
        </div>
      </div>
    );
  }
}

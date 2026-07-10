'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { customerLabel, fmtNiceDate } from '@jigzle/lib';
import type { Forwarder, OpenPORow, POOpenStatus, Supplier, SupplierType } from '@jigzle/db/types';
import {
  addForwarder,
  addSupplier,
  createPO,
  deletePO,
  getOpenPOs,
  getOpenShipments,
  getRecentShipIds,
  groupIntoShipment,
  searchCustomers,
  searchSkus,
  setConsolidator,
  setPOStatus,
  setShipmentNote,
  updatePO,
} from '@/app/purchasing/actions';
import type { CustomerHit, OpenShipmentRow, SkuHit, UpdatePOPatch } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { StoreIcon, TruckIcon, PackageIcon } from '@/components/AddIcons';
import { isRealName } from '@/components/skuName';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import SearchInput from '@/components/SearchInput';

// PR248 — trash glyph for the "Delete PO" action button (Sales-style: btn-danger btn-ico + text).
const TrashIcon = () => (<svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>);
// PR256 — To-ship detail: Edit toggle + easy-copy (unit cost / item link) glyphs.
const PencilIcon = () => (<svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);
const CopyIcon = () => (<svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>);
const CheckIcon = () => (<svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>);

const OPEN_STATUSES: POOpenStatus[] = ['Processing', 'On the way', 'With Forwarder'];
const SUPPLIER_TYPES: SupplierType[] = ['Taobao account', 'agent', 'marketplace', 'other'];
const METHODS = ['EMS', 'ZTO', 'SF', 'YTO', 'STO', 'JD', 'Yunda', 'Best', 'China Post'];

// supplier-country → unit-cost currency filler (To forwarder). Keyed by the supplier's country
// (case-insensitive). Unknown / unset country → a generic "supplier ccy" label, no symbol.
const CURRENCY_BY_COUNTRY: Record<string, { label: string; symbol: string }> = {
  china: { label: 'yuan', symbol: '元' },
  japan: { label: 'yen', symbol: '¥' },
  taiwan: { label: 'NT$', symbol: 'NT$' },
  'hong kong': { label: 'HKD', symbol: 'HK$' },
  korea: { label: 'won', symbol: '₩' },
  'south korea': { label: 'won', symbol: '₩' },
  singapore: { label: 'SGD', symbol: 'S$' },
  thailand: { label: 'baht', symbol: '฿' },
  malaysia: { label: 'MYR', symbol: 'RM' },
  indonesia: { label: 'rupiah', symbol: 'Rp' },
  'united states': { label: 'USD', symbol: '$' },
  usa: { label: 'USD', symbol: '$' },
};
function currencyForCountry(country: string | null | undefined): { label: string; symbol: string } | null {
  if (!country) return null;
  return CURRENCY_BY_COUNTRY[country.trim().toLowerCase()] ?? null;
}
const isChina = (country: string | null | undefined): boolean => (country ?? '').trim().toLowerCase() === 'china';


function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function statusClass(s: string | null): string {
  if (s === 'Processing') return 'processing';
  if (s === 'On the way') return 'ontheway';
  if (s === 'With Forwarder') return 'forwarder';
  return '';
}

// A reverted "short" line (PR17): ship_id cleared back to NULL, with a breadcrumb
// "shorted from <ship_id> on <date>" appended to shipment_note. Surface which ship_id it was short
// from so the line explains itself. Breadcrumbs chain with ' · ' → take the LAST (most recent short).
function shortFromShip(po: OpenPORow): string | null {
  if (po.ship_id || !po.shipment_note) return null;
  const re = /shorted from (.+?) on /g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(po.shipment_note)) !== null) last = m[1];
  return last;
}

const numOrNull = (s: string): number | null => {
  const n = parseFloat(s);
  return s.trim() && Number.isFinite(n) ? n : null;
};

// the new/edit PO form state
type PoForm = {
  supplier_id: number | '';
  item_code: string;
  item_name: string;
  qty: string;
  item_cost: string;
  method: string;
  marketplace_order_id: string;
  customer_id: number | null;
  customer_label: string;
  item_note: string;
  product_link: string;
  tracking_to_forwarder: string;
  status: POOpenStatus;
  ship_id: string | null;
};

const emptyForm = (): PoForm => ({
  supplier_id: '',
  item_code: '',
  item_name: '',
  qty: '1',
  item_cost: '',
  method: '',
  marketplace_order_id: '',
  customer_id: null,
  customer_label: '',
  item_note: '',
  product_link: '',
  tracking_to_forwarder: '',
  status: 'Processing',
  ship_id: null,
});

const formFromPO = (po: OpenPORow): PoForm => ({
  supplier_id: po.supplier_id ?? '',
  item_code: po.item_code ?? '',
  item_name: po.name,
  qty: String(po.qty ?? 0),
  item_cost: po.item_cost != null ? String(po.item_cost) : '',
  method: po.method ?? '',
  marketplace_order_id: po.marketplace_order_id ?? '',
  customer_id: po.customer_id,
  customer_label: po.customer_name ?? (po.customer_id != null ? `#${po.customer_id}` : ''),
  item_note: po.item_note ?? '',
  product_link: po.product_link ?? '',
  tracking_to_forwarder: po.tracking_to_forwarder ?? '',
  status: OPEN_STATUSES.includes(po.status as POOpenStatus) ? (po.status as POOpenStatus) : 'Processing',
  ship_id: po.ship_id,
});

type RightMode = 'new' | 'edit' | 'group' | null;

// Purchasing pipeline buckets (PurchasingShell tabs): 'forwarder' = Processing + On the way (bought,
// awaiting details/tracking); 'ship' = With Forwarder (confirmed, grouped into shipments).
const BUCKET_STATUSES: Record<'forwarder' | 'ship', POOpenStatus[]> = {
  forwarder: ['Processing', 'On the way'],
  ship: ['With Forwarder'],
};

export default function OrderBoard({
  initialQueue,
  suppliers: initialSuppliers,
  forwarders: initialForwarders,
  shipments: initialShipments,
  userEmail,
  embedded = false,
  bucket,
  localCouriers = [],
  onDetailOpenChange,
  onCountChange,
}: {
  initialQueue: OpenPORow[];
  suppliers: Supplier[];
  forwarders: Forwarder[];
  shipments: OpenShipmentRow[];
  userEmail: string;
  // PurchasingShell embedding: render without the app chrome and constrain the queue to one bucket.
  embedded?: boolean;
  bucket?: 'forwarder' | 'ship';
  // 0055 — Settings-managed local (domestic) courier suggestions for the To-forwarder form.
  localCouriers?: string[];
  // PR153: report when a bucket's bodyview DETAIL is open (the shell hides the pipeline tabs).
  onDetailOpenChange?: (open: boolean) => void;
  onCountChange?: (n: number) => void;
}) {
  const [queue, setQueue] = useState<OpenPORow[]>(initialQueue);
  const [suppliers, setSuppliers] = useState<Supplier[]>(initialSuppliers);
  const [forwarders] = useState<Forwarder[]>(initialForwarders); // curated in Settings → Forwarders
  const [shipments, setShipments] = useState<OpenShipmentRow[]>(initialShipments);

  const [filterStatus, setFilterStatus] = useState('');
  const [filterSupplier, setFilterSupplier] = useState('');
  const [search, setSearch] = useState(''); // To ship: free-text search over the queue (replaces the supplier filter)

  const [selectedPoIds, setSelectedPoIds] = useState<Set<number>>(new Set());

  const [mode, setMode] = useState<RightMode>(null);
  const [editPo, setEditPo] = useState<OpenPORow | null>(null);
  const [shipNote, setShipNote] = useState(''); // the edited PO's Ship-ID note (To-ship), seeded on open
  const [attachShipId, setAttachShipId] = useState(''); // PR152: To-ship attach-to-open-shipment pick
  const [shipEditing, setShipEditing] = useState(false); // PR256: To-ship detail edit mode (fields unlocked)
  const [copiedKey, setCopiedKey] = useState<string | null>(null); // PR256: which easy-copy chip just fired
  const [form, setForm] = useState<PoForm>(emptyForm());

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false); // inline delete-order confirm (edit pane)

  // PR248 — To-forwarder BATCH flow: pick several items, then apply ONE supplier / local courier /
  // tracking / notes as a group (unit cost + item link stay per item), and confirm them all → To ship.
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchStep, setBatchStep] = useState<'pick' | 'fill'>('pick');
  const [batchIds, setBatchIds] = useState<Set<number>>(new Set());
  const [batchSupplier, setBatchSupplier] = useState<number | ''>('');
  const [batchMethod, setBatchMethod] = useState('');
  const [batchTracking, setBatchTracking] = useState('');
  const [batchMarketplace, setBatchMarketplace] = useState(''); // PR256: one marketplace order id for the group
  const [batchNote, setBatchNote] = useState('');
  const [batchPer, setBatchPer] = useState<Record<number, { cost: string; link: string }>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  // PR263 — Batch confirm / Create shipment ID are now in-list entry buttons (openBatch / openGroup
  // called directly); the old shell tab-row buttons + signal plumbing are gone.

  // PR153: a bucketed bodyview detail is open → the shell hides the pipeline tabs.
  const bvDetailOpen = !!bucket && mode === 'edit' && !!editPo;
  useEffect(() => { onDetailOpenChange?.(bvDetailOpen); }, [bvDetailOpen, onDetailOpenChange]);

  // SKU search
  const [skuQuery, setSkuQuery] = useState('');
  const [skuHits, setSkuHits] = useState<SkuHit[]>([]);
  const [skuSearching, setSkuSearching] = useState(false);
  const skuSeq = useRef(0); // stale-response guard (PR99): ignore out-of-order auto-search results
  // customer search
  const [custQuery, setCustQuery] = useState('');
  const [custHits, setCustHits] = useState<CustomerHit[]>([]);
  const [custSearching, setCustSearching] = useState(false);
  const custSeq = useRef(0);

  // inline + add supplier
  const [supForm, setSupForm] = useState<{ name: string; country: string; flag: string; type: SupplierType } | null>(null);

  // group-into-shipment form (forwarders are managed in Settings → Forwarders; no inline add here)
  const [grpForwarder, setGrpForwarder] = useState('');
  const [grpConsolCourier, setGrpConsolCourier] = useState('');   // PR274: consolidator courier (optional)
  const [grpConsolTracking, setGrpConsolTracking] = useState(''); // PR272: consolidator tracking (optional)
  const [grpShipId, setGrpShipId] = useState('');
  const [shipIdOpts, setShipIdOpts] = useState<string[]>([]); // PR285: recent ship_ids for autocomplete
  const [grpOrigin, setGrpOrigin] = useState(''); // kept internally (from an existing shipment) — no UI field
  const [grpDate, setGrpDate] = useState(todayStr());
  const [grpQty, setGrpQty] = useState<Record<number, number>>({}); // per-PO ship qty override (partial split)


  // PR254 — open shipments offered as tap-to-pick chips in the group overlay's Ship ID field. Once a
  // forwarder is chosen, scope to that forwarder's open shipments (else show all) so "add to an existing
  // shipment" is a reliable tap rather than a fiddly datalist.
  const openShipmentChoices = useMemo(
    () => shipments.filter((s) => !grpForwarder || s.forwarder_prefix === grpForwarder),
    [shipments, grpForwarder]
  );

  const selectedCount = selectedPoIds.size;
  const selectedPOs = useMemo(() => queue.filter((p) => selectedPoIds.has(p.po_id)), [queue, selectedPoIds]);
  // effective ship qty for a selected PO (defaults to its full qty; clamped 1..qty)
  const sendQty = (po: OpenPORow) => Math.max(1, Math.min(po.qty, grpQty[po.po_id] ?? po.qty));
  const totalItems = useMemo(() => selectedPOs.reduce((n, po) => n + sendQty(po), 0), [selectedPOs, grpQty]);

  // constrain the displayed queue to the tab's bucket (client-side over the loaded open queue)
  const shown = useMemo(() => {
    if (!bucket) return queue;
    const allowed = BUCKET_STATUSES[bucket];
    let rows = queue.filter((p) => allowed.includes(p.status as POOpenStatus));
    // PR163: To ship lists only POs NOT yet grouped into a shipment. Once grouped (ship_id set) a PO has
    // shipped from the forwarder and lives under its shipment in History → Active, so it drops out of the
    // To-ship work queue (and its count badge) instead of lingering as an already-shipped row.
    if (bucket === 'ship') rows = rows.filter((p) => !p.ship_id);
    return rows;
  }, [queue, bucket]);
  useEffect(() => { onCountChange?.(shown.length); }, [shown, onCountChange]);
  // embedded tabs mount fresh on each switch — refetch so a confirm/group done in a sibling tab shows.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (embedded) refreshQueue(); }, []);

  // ── To ship: country sub-tabs (Sales-Pending style). A PO's country comes from its supplier (set in
  // To forwarder), falling back to its shipment's origin country; anything without one lands in "Other".
  // Lets you consolidate same-origin items into a forwarder shipment. ──
  const ALL_COUNTRIES = '__all__';
  const OTHER_COUNTRY = '__other__';
  const supplierById = useMemo(() => new Map(suppliers.map((s) => [s.supplier_id, s])), [suppliers]);
  const shipmentById = useMemo(() => new Map(shipments.map((s) => [s.ship_id, s])), [shipments]);
  const countryOf = useCallback((po: OpenPORow): string | null => {
    const sup = po.supplier_id != null ? supplierById.get(po.supplier_id) : undefined;
    const c = sup?.country?.trim();
    if (c) return c;
    const sh = po.ship_id ? shipmentById.get(po.ship_id) : undefined;
    return sh?.origin_country?.trim() || null;
  }, [supplierById, shipmentById]);

  const [shipCountry, setShipCountry] = useState<string>(ALL_COUNTRIES);
  // the country tabs present in the ship bucket, with counts (+ an "Other" bucket for unattributed rows)
  const shipCountryTabs = useMemo(() => {
    if (bucket !== 'ship' && bucket !== 'forwarder') return []; // PR284: Confirm groups by Source country too
    const counts = new Map<string, number>();
    let other = 0;
    for (const po of shown) {
      const c = countryOf(po);
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
      else other += 1;
    }
    const tabs: { key: string; label: string; count: number }[] = [{ key: ALL_COUNTRIES, label: 'All', count: shown.length }];
    for (const [key, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) tabs.push({ key, label: key, count });
    if (other) tabs.push({ key: OTHER_COUNTRY, label: 'Other', count: other });
    return tabs;
  }, [bucket, shown, countryOf]);

  // the rows actually listed: the ship bucket narrows by the active country tab, then by the search box
  // (name / SKU code / supplier / ship id); other buckets pass through.
  const shownFiltered = useMemo(() => {
    let rows = shown;
    const grouped = bucket === 'ship' || bucket === 'forwarder'; // PR284
    if (grouped && shipCountry !== ALL_COUNTRIES) {
      rows = shipCountry === OTHER_COUNTRY ? rows.filter((p) => !countryOf(p)) : rows.filter((p) => countryOf(p) === shipCountry);
    }
    const q = search.trim().toLowerCase();
    if (grouped && q) {
      rows = rows.filter((p) =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.item_code || '').toLowerCase().includes(q) ||
        (p.supplier_name || '').toLowerCase().includes(q) ||
        (p.ship_id || '').toLowerCase().includes(q)
      );
    }
    return rows;
  }, [bucket, shipCountry, shown, countryOf, search]);

  // SKU thumbnails for the PO queue rows + the SKU search picker
  const imgCodes = useMemo(() => {
    const set = new Set<string>();
    queue.forEach((p) => { if (p.item_code) set.add(p.item_code); });
    skuHits.forEach((h) => set.add(h.item_code));
    return [...set];
  }, [queue, skuHits]);
  const imgMap = useSkuImages(imgCodes);

  function currentFilter() {
    return {
      statuses: bucket ? BUCKET_STATUSES[bucket] : undefined, // fetch only this tab's bucket, fully
      status: filterStatus || null,
      supplier_id: filterSupplier ? Number(filterSupplier) : null,
    };
  }

  async function refreshQueue() {
    try {
      setQueue(await getOpenPOs(currentFilter()));
    } catch {
      /* keep current queue on transient error */
    }
  }

  async function applyFilters(nextStatus: string, nextSupplier: string) {
    setFilterStatus(nextStatus);
    setFilterSupplier(nextSupplier);
    try {
      setQueue(
        await getOpenPOs({
          status: nextStatus || null,
          supplier_id: nextSupplier ? Number(nextSupplier) : null,
        })
      );
    } catch {
      /* keep current queue */
    }
  }

  function resetMessages() {
    setError(null);
    setSuccess(null);
  }

  function startNew() {
    resetMessages();
    setMode('new');
    setEditPo(null);
    setForm(emptyForm());
    setSkuQuery('');
    setSkuHits([]);
    setCustQuery('');
    setCustHits([]);
    setSupForm(null);
    setConfirmDel(false);
  }

  function openEdit(po: OpenPORow) {
    resetMessages();
    setMode('edit');
    setEditPo(po);
    setShipNote((po.ship_id ? shipmentById.get(po.ship_id)?.note : '') ?? '');
    setAttachShipId('');
    setShipEditing(false);
    setCopiedKey(null);
    setForm(formFromPO(po));
    setSkuQuery('');
    setSkuHits([]);
    setCustQuery('');
    setCustHits([]);
    setSupForm(null);
    setConfirmDel(false);
  }

  // ── To-ship: save the per-Ship-ID note (auto-saves on blur; editable from any of the shipment's POs).
  async function saveShipNote(next: string) {
    const po = editPo;
    if (!po?.ship_id) return;
    const v = next.trim();
    if (v === ((po.ship_id ? shipmentById.get(po.ship_id)?.note : '') ?? '')) return; // unchanged
    try {
      await setShipmentNote(po.ship_id, v);
      setShipments((prev) => prev.map((s) => (s.ship_id === po.ship_id ? { ...s, note: v || null } : s)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the shipment note.');
    }
  }

  // PR256 — easy-copy a To-ship detail value. Best-effort — falls back silently if clipboard is blocked.
  async function copyVal(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); setCopiedKey(key); setTimeout(() => setCopiedKey(null), 1400); } catch { /* clipboard unavailable */ }
  }

  // ── To forwarder: auto-save one field (there's no Save button — fields persist as you fill them,
  // mirroring the Settings editors). Merges the change back into the queue + the open edit row. ──
  async function autoSaveForwarder(patch: UpdatePOPatch) {
    if (!editPo) return;
    try {
      await updatePO(editPo.po_id, patch);
      setQueue((prev) => prev.map((p) => (p.po_id === editPo.po_id ? { ...p, ...patch } as OpenPORow : p)));
      setEditPo((prev) => (prev ? ({ ...prev, ...patch } as OpenPORow) : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    }
  }

  // ── To forwarder: confirm a single item is with the forwarder → With Forwarder (moves to To ship).
  // Per-item (not bulk) because cost / tracking differ per item, so they're handled one card at a time. ──
  async function confirmOne() {
    if (!editPo) return;
    resetMessages();
    // PR256 — a supplier is the one thing To-forwarder must record before an item can move on.
    if (!form.supplier_id) {
      setError('Pick a source before Ready to Ship.');
      return;
    }
    setBusy(true);
    try {
      // persist any field edits made in the detail view before advancing (fields auto-save on blur,
      // but a value still focused when Confirm is tapped may not have fired its blur yet)
      await updatePO(editPo.po_id, {
        supplier_id: form.supplier_id ? Number(form.supplier_id) : undefined,
        product_link: form.product_link.trim() || null,
        item_cost: numOrNull(form.item_cost),
        method: form.method.trim() || null,
        marketplace_order_id: form.marketplace_order_id.trim() || null,
        item_note: form.item_note.trim() || null,
        tracking_to_forwarder: form.tracking_to_forwarder.trim() || null,
      });
      await setPOStatus(editPo.po_id, 'With Forwarder');
      setSuccess(`PO #${editPo.po_id} confirmed → Ship.`);
      setMode(null);
      setEditPo(null);
      await refreshQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to confirm.');
    } finally {
      setBusy(false);
    }
  }

  // ── delete an open order (the PO won't be confirmed) ──
  async function doDelete() {
    if (!editPo) return;
    resetMessages();
    setBusy(true);
    try {
      await deletePO(editPo.po_id);
      setSuccess(`PO #${editPo.po_id} deleted.`);
      setMode(null);
      setEditPo(null);
      setConfirmDel(false);
      await refreshQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete.');
    } finally {
      setBusy(false);
    }
  }

  // ── To-forwarder BATCH: open the picker, toggle items, and confirm a whole group at once ──
  function openBatch() {
    resetMessages();
    setBatchOpen(true);
    setBatchStep('pick');
    setBatchIds(new Set());
    setBatchSupplier('');
    setBatchMethod('');
    setBatchTracking('');
    setBatchMarketplace('');
    setBatchNote('');
    setBatchPer({});
  }
  function closeBatch() {
    setBatchOpen(false);
    setBatchIds(new Set());
    setBatchPer({});
  }
  function toggleBatch(poId: number) {
    setBatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(poId)) next.delete(poId);
      else next.add(poId);
      return next;
    });
  }
  // advance to step 2, seeding per-item cost / link from each PO's current values
  function batchNext() {
    if (batchIds.size === 0) return;
    const per: Record<number, { cost: string; link: string }> = {};
    for (const po of shownFiltered) {
      if (!batchIds.has(po.po_id)) continue;
      per[po.po_id] = {
        cost: po.item_cost != null ? String(po.item_cost) : '',
        link: po.product_link ?? '',
      };
    }
    setBatchPer(per);
    setBatchStep('fill');
  }
  // apply the shared fields + per-item cost/link to every picked PO, then advance them all → To ship.
  async function submitBatch() {
    if (batchIds.size === 0) return;
    resetMessages();
    setBatchBusy(true);
    try {
      const ids = [...batchIds];
      for (const id of ids) {
        const per = batchPer[id] ?? { cost: '', link: '' };
        await updatePO(id, {
          supplier_id: batchSupplier ? Number(batchSupplier) : undefined,
          method: batchMethod.trim() || null,
          tracking_to_forwarder: batchTracking.trim() || null,
          marketplace_order_id: batchMarketplace.trim() || null,
          item_note: batchNote.trim() || null,
          item_cost: numOrNull(per.cost),
          product_link: per.link.trim() || null,
        });
        await setPOStatus(id, 'With Forwarder');
      }
      setSuccess(`${ids.length} item${ids.length === 1 ? '' : 's'} confirmed → Ship.`);
      closeBatch();
      await refreshQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Batch confirm failed.');
    } finally {
      setBatchBusy(false);
    }
  }

  // PR251 — checkboxes just toggle selection; the grouping form is opened separately by the tab-row
  // "Create shipment ID" button (it renders as an overlay, not an inline panel).
  function toggleSelect(poId: number) {
    setSelectedPoIds((prev) => {
      const next = new Set(prev);
      if (next.has(poId)) next.delete(poId);
      else next.add(poId);
      return next;
    });
  }

  // open the group overlay for the current selection (seeds fresh forwarder / ship id / date / qty)
  function openGroup() {
    if (selectedPoIds.size === 0) return;
    resetMessages();
    setGrpForwarder('');
    setGrpConsolCourier('');
    setGrpConsolTracking('');
    setGrpShipId('');
    setGrpOrigin('');
    setGrpDate(todayStr());
    setGrpQty({});
    setMode('group');
    // PR285 — load recent ship_ids (open + History) so the Shipment ID field can autocomplete.
    getRecentShipIds().then(setShipIdOpts).catch(() => {});
  }

  function clearSelection() {
    setSelectedPoIds(new Set());
    setSearch('');
    setGrpQty({});
    if (mode === 'group') setMode(null);
  }

  // ── SKU search (live, debounced — PR99). The seq guard drops out-of-order responses so a slow
  // earlier query can't overwrite a newer one or flip searching off after the latest is in flight. ──
  async function runSkuSearch() {
    const _id = ++skuSeq.current;
    const q = skuQuery.trim();
    if (q.length < 2) {
      setSkuHits([]);
      return;
    }
    setSkuSearching(true);
    try {
      const hits = await searchSkus(q);
      if (skuSeq.current !== _id) return; // a newer search superseded this one
      setSkuHits(hits);
    } catch {
      if (skuSeq.current !== _id) return;
      setSkuHits([]);
    } finally {
      if (skuSeq.current === _id) setSkuSearching(false);
    }
  }
  useEffect(() => {
    const q = skuQuery.trim();
    if (q.length < 2) { setSkuHits([]); setSkuSearching(false); return; }
    const t = setTimeout(() => { runSkuSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skuQuery]);
  function pickSku(hit: SkuHit) {
    setForm((f) => ({ ...f, item_code: hit.item_code, item_name: hit.name }));
    setSkuHits([]);
    setSkuQuery('');
  }

  // ── customer search (live, debounced — PR99; same stale-response guard as the SKU picker) ──
  async function runCustSearch() {
    const _id = ++custSeq.current;
    const q = custQuery.trim();
    if (q.length < 2) {
      setCustHits([]);
      return;
    }
    setCustSearching(true);
    try {
      const hits = await searchCustomers(q);
      if (custSeq.current !== _id) return; // a newer search superseded this one
      setCustHits(hits);
    } catch {
      if (custSeq.current !== _id) return;
      setCustHits([]);
    } finally {
      if (custSeq.current === _id) setCustSearching(false);
    }
  }
  useEffect(() => {
    const q = custQuery.trim();
    if (q.length < 2) { setCustHits([]); setCustSearching(false); return; }
    const t = setTimeout(() => { runCustSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custQuery]);
  function pickCustomer(hit: CustomerHit) {
    setForm((f) => ({ ...f, customer_id: hit.customer_id, customer_label: customerLabel(hit.name, hit.phone) }));
    setCustHits([]);
    setCustQuery('');
  }

  // ── inline add supplier ──
  async function submitSupplier() {
    if (!supForm) return;
    const name = supForm.name.trim();
    if (!name) {
      setError('Source name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sup = await addSupplier({ name, country: supForm.country.trim() || null, flag: supForm.flag.trim() || null, type: supForm.type });
      setSuppliers((prev) => (prev.some((s) => s.supplier_id === sup.supplier_id) ? prev : [...prev, sup].sort((a, b) => (a.name || '').localeCompare(b.name || ''))));
      setForm((f) => ({ ...f, supplier_id: sup.supplier_id }));
      setSupForm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add supplier.');
    } finally {
      setBusy(false);
    }
  }

  // ── create PO ──
  async function submitCreate() {
    resetMessages();
    if (!form.supplier_id) {
      setError('A supplier is required.');
      return;
    }
    if (!form.item_code.trim()) {
      setError('An item (SKU) is required.');
      return;
    }
    const qty = numOrNull(form.qty);
    if (qty == null || qty < 0) {
      setError('Qty must be a number ≥ 0.');
      return;
    }
    setBusy(true);
    try {
      const { po_id } = await createPO({
        supplier_id: Number(form.supplier_id),
        item_code: form.item_code.trim(),
        qty,
        item_cost: numOrNull(form.item_cost),
        method: form.method.trim() || null,
        marketplace_order_id: form.marketplace_order_id.trim() || null,
        customer_id: form.customer_id,
        item_note: form.item_note.trim() || null,
      });
      setSuccess(`PO #${po_id} created (Processing).`);
      setForm(emptyForm());
      await refreshQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create PO.');
    } finally {
      setBusy(false);
    }
  }

  // ── save edits (fields + status if changed) ──
  async function submitEdit() {
    if (!editPo) return;
    resetMessages();
    if (!form.supplier_id) {
      setError('A supplier is required.');
      return;
    }
    if (!form.item_code.trim()) {
      setError('An item (SKU) is required.');
      return;
    }
    const qty = numOrNull(form.qty);
    if (qty == null || qty < 0) {
      setError('Qty must be a number ≥ 0.');
      return;
    }
    setBusy(true);
    try {
      await updatePO(editPo.po_id, {
        supplier_id: Number(form.supplier_id),
        item_code: form.item_code.trim(),
        qty,
        item_cost: numOrNull(form.item_cost),
        method: form.method.trim() || null,
        marketplace_order_id: form.marketplace_order_id.trim() || null,
        customer_id: form.customer_id,
        item_note: form.item_note.trim() || null,
        tracking_to_forwarder: form.tracking_to_forwarder.trim() || null,
      });
      if (form.status !== editPo.status) {
        await setPOStatus(editPo.po_id, form.status);
      }
      setSuccess(`PO #${editPo.po_id} saved.`);
      await refreshQueue();
      setMode(null);
      setEditPo(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save PO.');
    } finally {
      setBusy(false);
    }
  }

  // ── detach a PO from its shipment ──
  async function detach() {
    if (!editPo) return;
    resetMessages();
    setBusy(true);
    try {
      await updatePO(editPo.po_id, { ship_id: null });
      setSuccess(`PO #${editPo.po_id} detached from ${editPo.ship_id}.`);
      setForm((f) => ({ ...f, ship_id: null }));
      await refreshQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to detach.');
    } finally {
      setBusy(false);
    }
  }

  // ── PR152: attach a With-Forwarder PO to an already-open shipment (To-ship's one editable field) ──
  async function attachShip() {
    if (!editPo || !attachShipId) return;
    resetMessages();
    setBusy(true);
    try {
      await updatePO(editPo.po_id, { ship_id: attachShipId });
      setSuccess(`PO #${editPo.po_id} attached to ${attachShipId}.`);
      setForm((f) => ({ ...f, ship_id: attachShipId }));
      setEditPo((prev) => (prev ? { ...prev, ship_id: attachShipId } : prev));
      setShipNote(shipmentById.get(attachShipId)?.note ?? '');
      setAttachShipId('');
      await refreshQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to attach.');
    } finally {
      setBusy(false);
    }
  }

  // ── pick an existing open shipment in the group form ──
  function pickExistingShipment(shipId: string) {
    setGrpShipId(shipId);
    const sh = shipments.find((s) => s.ship_id === shipId);
    if (sh) {
      if (sh.forwarder_prefix) setGrpForwarder(sh.forwarder_prefix);
      if (sh.origin_country) setGrpOrigin(sh.origin_country);
      if (sh.ship_date) setGrpDate(sh.ship_date);
    }
  }

  // ── group selected POs into a shipment ──
  async function submitGroup() {
    resetMessages();
    if (selectedCount === 0) {
      setError('Select at least one PO.');
      return;
    }
    const shipId = grpShipId.trim();
    // PR285 — the shipment CODE is the leading letters of the Shipment ID ("SUB 193" → "SUB").
    const prefix = (shipId.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
    if (!prefix) {
      setError('Enter a Shipment ID that starts with a code, e.g. "SUB 193".');
      return;
    }
    setBusy(true);
    try {
      // PR285 — ensure the code exists (FK on shipments.forwarder_prefix). addForwarder is idempotent;
      // a brand-new code lands in Settings → Shipment codes with no flag until one is added there.
      const known = forwarders.find((f) => f.prefix.toUpperCase() === prefix);
      if (!known) { try { await addForwarder({ prefix }); } catch { /* non-fatal: may already exist */ } }
      const origin = (grpOrigin.trim() || known?.country || '').trim() || null;
      const { affected } = await groupIntoShipment({
        ship_id: shipId,
        items: selectedPOs.map((po) => ({ po_id: po.po_id, qty: sendQty(po) })),
        forwarder_prefix: prefix,
        origin_country: origin,
        ship_date: grpDate || null,
      });
      // PR272/PR274 — best-effort: stamp the consolidator courier + tracking on the shipment (degrades
      // silently if 0078/0079 aren't applied). Never blocks the group itself, which already succeeded.
      if (grpConsolCourier.trim() || grpConsolTracking.trim()) {
        try { await setConsolidator(grpShipId.trim(), grpConsolCourier, grpConsolTracking); } catch { /* non-fatal */ }
      }
      setSuccess(`Successfully grouped ${totalItems} item${totalItems === 1 ? '' : 's'} into ${grpShipId.trim()}.`);
      setSelectedPoIds(new Set());
      setGrpQty({});
      setMode(null);
      await refreshQueue();
      try {
        setShipments(await getOpenShipments());
      } catch {
        /* keep current shipments list */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to group.');
    } finally {
      setBusy(false);
    }
  }

  // PR151 — To forwarder is a BODYVIEW (the Purchasing-History pattern): the body shows EITHER the
  // full-width compact card list OR the tapped PO's detail (image header + auto-save form) with a
  // ← back button. The other buckets keep the two-pane layout below.
  const closeForwardDetail = () => { setMode(null); setEditPo(null); setConfirmDel(false); };
  const forwarderBody = (
    <div className="bodyview">
      {error && <div className="validation err">{error}</div>}
      {success && <div className="validation ok">{success}</div>}

      {/* PR284 — country sub-tabs (by Source origin), like Ship, so same-origin items group together. */}
      {shipCountryTabs.some((t) => t.key !== ALL_COUNTRIES && t.key !== OTHER_COUNTRY) && (
        <div className="fq-filters" role="tablist" aria-label="Country">
          {shipCountryTabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={shipCountry === t.key}
              className={`fq-filter ${shipCountry === t.key ? 'active' : ''}`}
              onClick={() => setShipCountry(t.key)}
            >
              {t.label}<span className="fq-filter-count">{t.count}</span>
            </button>
          ))}
        </div>
      )}
      {/* PR284 — "Confirm item(s)" (ex-"Batch confirm"): the two-step picker; the list stays checkbox-free. */}
      <button className="btn-brown btn-ico po-add-full po-add-toplist" onClick={openBatch}><TruckIcon />Confirm item(s)</button>
      {shownFiltered.length === 0 && <div className="hint fq-empty">Nothing here yet.</div>}
      <ul className="po-cards po-cards-compact">
        {shownFiltered.map((po) => {
          const code = po.item_code ?? po.item_code_raw ?? '—';
          return (
          <li key={po.po_id}>
            {/* PR254 — the To-buy card standard: SKU (+ name) vertically centred on the left, qty
                ABOVE the date on the right. Keeps a nameless SKU centred (no drop under the code). */}
            <button className="po-card po-card-btn po-card-mini" onClick={() => openEdit(po)}>
              <SkuImage status={imgMap[po.item_code ?? '']?.status} displayUrl={imgMap[po.item_code ?? '']?.displayUrl} name={po.name} size={SKU_IMG.sm} />
              <div className="po-card-main">
                <span className="ff-code">{code}</span>
                {isRealName(po.name, code) && <span className="ff-name po-card-name">{po.name}</span>}
              </div>
              <div className="po-card-side">
                <span className="po-card-qty po-card-qty-lg">×{po.qty}</span>
                <div className="po-card-meta">
                  <span className="po-card-date">{fmtNiceDate(po.status_since)}</span>
                </div>
              </div>
              <span className="po-chev" aria-hidden>›</span>
            </button>
          </li>
          );
        })}
      </ul>

      {/* PR284 — item detail as an OVERLAY (was a bodyview); fields edit directly (no Edit button). */}
      {mode === 'edit' && editPo && (
        <div className="sc-modal-backdrop" onClick={closeForwardDetail}>
          <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Confirm item" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <div>
                <span className="sc-modal-title">{editPo.item_code ?? editPo.item_code_raw ?? '—'}</span>
                {isRealName(editPo.name, editPo.item_code ?? editPo.item_code_raw) && <div className="sc-modal-sub">{editPo.name} · ×{editPo.qty}</div>}
              </div>
              <button className="sc-modal-x" onClick={closeForwardDetail} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              {renderForwarderForm()}
            </div>
          </div>
        </div>
      )}
      {batchOpen && renderBatchModal()}
    </div>
  );

  // PR152 — To ship is a BODYVIEW too: country tabs + full-width checkbox card list (no search bar);
  // ticking rows opens the group panel BELOW the list; tapping a card opens the locked-down PO detail
  // (read-only summary of what To-forwarder recorded; the only editable thing is the Shipment ID).
  const shipDetailOpen = mode === 'edit' && !!editPo;
  const shipBody = (
    <div className="bodyview">
      {error && <div className="validation err">{error}</div>}
      {success && <div className="validation ok">{success}</div>}

      {!shipDetailOpen ? (
        <>
          {/* country sub-tabs (by supplier origin) so same-origin items group together */}
          {shipCountryTabs.some((t) => t.key !== ALL_COUNTRIES && t.key !== OTHER_COUNTRY) && (
            <div className="fq-filters" role="tablist" aria-label="Country">
              {shipCountryTabs.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={shipCountry === t.key}
                  className={`fq-filter ${shipCountry === t.key ? 'active' : ''}`}
                  onClick={() => { setShipCountry(t.key); setSelectedPoIds(new Set()); }}
                >
                  {t.label}<span className="fq-filter-count">{t.count}</span>
                </button>
              ))}
            </div>
          )}
          {/* PR263 — Create shipment is an entry button at the top of the list (mirrors Batch confirm);
              disabled until rows are ticked. */}
          <button
            className="btn-brown btn-ico po-add-full po-add-toplist"
            onClick={openGroup}
            disabled={selectedCount === 0}
            title={selectedCount === 0 ? 'Tick items in the list first' : `Create a shipment from ${selectedCount} selected`}
          >
            <PackageIcon />Create shipment{selectedCount > 0 ? ` · ${selectedCount}` : ''}
          </button>
          {shownFiltered.length === 0 && <div className="hint fq-empty">Nothing here yet.</div>}
          <ul className="po-cards po-cards-compact">
            {shownFiltered.map((po) => {
              const code = po.item_code ?? po.item_code_raw ?? '—';
              return (
              <li key={po.po_id}>
                <div className="po-row-wrap">
                  <input
                    type="checkbox"
                    className="po-check"
                    checked={selectedPoIds.has(po.po_id)}
                    onChange={() => toggleSelect(po.po_id)}
                    aria-label={`select PO ${po.po_id}`}
                  />
                  {/* PR254 — same To-buy card standard as To forwarder: qty above date, SKU centred. */}
                  <button className="po-card po-card-btn po-card-mini" style={{ flex: 1, minWidth: 0 }} onClick={() => openEdit(po)}>
                    <SkuImage status={imgMap[po.item_code ?? '']?.status} displayUrl={imgMap[po.item_code ?? '']?.displayUrl} name={po.name} size={SKU_IMG.sm} />
                    <div className="po-card-main">
                      <span className="ff-code">{code}</span>
                      {isRealName(po.name, code) && <span className="ff-name po-card-name">{po.name}</span>}
                      {shortFromShip(po) && <span className="badge short">Short · from {shortFromShip(po)}</span>}
                    </div>
                    <div className="po-card-side">
                      <span className="po-card-qty po-card-qty-lg">×{po.qty}</span>
                      <div className="po-card-meta">
                        <span className="po-card-date">{fmtNiceDate(po.status_since)}</span>
                      </div>
                    </div>
                    <span className="po-chev" aria-hidden>›</span>
                  </button>
                </div>
              </li>
              );
            })}
          </ul>

        </>
      ) : (
        <>
          <button className="btn-link bv-back" onClick={() => { setMode(null); setEditPo(null); setConfirmDel(false); }}>← back</button>
          <div className="bv-detail">
            {/* same body-header as To forwarder */}
            <div className="po-bvhead">
              <SkuImage status={imgMap[editPo!.item_code ?? '']?.status} displayUrl={imgMap[editPo!.item_code ?? '']?.displayUrl} name={editPo!.name} size={SKU_IMG.smd} />
              <div className="po-bvhead-main">
                <div className="po-card-l1">
                  <span className="ff-code">{editPo!.item_code ?? editPo!.item_code_raw ?? '—'}</span>
                  <span className="po-card-date">{fmtNiceDate(editPo!.status_since)}</span>
                </div>
                <div className="po-card-l1 po-card-mid">
                  {isRealName(editPo!.name, editPo!.item_code ?? editPo!.item_code_raw) && <span className="ff-name">{editPo!.name}</span>}
                  <span className="po-card-qty">×{editPo!.qty}</span>
                </div>
                <div className="po-card-l2 hint">PO #{editPo!.po_id}</div>
              </div>
            </div>
            {renderShipDetail()}
          </div>
        </>
      )}
      {mode === 'group' && renderGroupModal()}
    </div>
  );

  const body = bucket === 'forwarder' ? forwarderBody : bucket === 'ship' ? shipBody : (
    <>
      <div className="fulfill-layout">
        {/* ── Open-PO queue ── */}
        <aside className="fq-pane">
          {!embedded && <div className="fq-head"><span>Open POs</span></div>}
          {/* The standalone board keeps its status + supplier filters (the tab already scopes status when embedded). */}
          {!bucket && (
            <div className="po-filters">
              <select value={filterStatus} onChange={(e) => applyFilters(e.target.value, filterSupplier)}>
                <option value="">All open</option>
                {OPEN_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={filterSupplier} onChange={(e) => applyFilters(filterStatus, e.target.value)}>
                <option value="">All suppliers</option>
                {suppliers.map((s) => <option key={s.supplier_id} value={s.supplier_id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {/* New PO only on the standalone board — the embedded buckets are fed by the To-buy "Done →"
              flow (forwarder) / the confirm step (ship), so manual PO creation doesn't belong here. */}
          {!bucket && (
            <div className="po-newbtn">
              <button className="btn-primary" style={{ width: '100%' }} onClick={startNew}>+ New PO</button>
            </div>
          )}

          {shownFiltered.length === 0 && <div className="hint fq-empty">No open POs.</div>}

          <ul className="fq-list">
              {shownFiltered.map((po) => (
                <li key={po.po_id}>
                  <div className="po-row-wrap">
                    <input
                      type="checkbox"
                      className="po-check"
                      checked={selectedPoIds.has(po.po_id)}
                      onChange={() => toggleSelect(po.po_id)}
                      aria-label={`select PO ${po.po_id}`}
                    />
                    <SkuImage status={imgMap[po.item_code ?? '']?.status} displayUrl={imgMap[po.item_code ?? '']?.displayUrl} name={po.name} size={SKU_IMG.sm} />
                    <button className={`fq-row ${editPo?.po_id === po.po_id ? 'active' : ''}`} onClick={() => openEdit(po)}>
                      {/* Sales-style: product name headline, SKU code demoted to a muted mono tail. */}
                      <div className="fq-row-top">
                        <span className="fq-headline">{po.name}</span>
                        <span className="fq-id-sub">{po.item_code || '—'}</span>
                      </div>
                      <div className="fq-row-bot">
                        <span>×{po.qty}{po.supplier_name ? ` · ${po.supplier_name}` : ''}</span>
                        <span className={`po-status ${statusClass(po.status)}`}>{po.status || '—'}</span>
                      </div>
                      {po.ship_id && <div className="fq-row-bot"><span>ship {po.ship_id}</span></div>}
                      {shortFromShip(po) && (
                        <div className="fq-row-bot"><span className="badge short">Short · from {shortFromShip(po)}</span></div>
                      )}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
        </aside>

        {/* ── Detail ── */}
        <main className="fd-pane">
          {!mode && !success && !error && (
            <div className="fd-empty">Select a PO to edit, hit “+ New PO”, or check rows to group into a shipment.</div>
          )}

          {error && <div className="validation err">{error}</div>}
          {success && <div className="validation ok">{success}</div>}

          {(mode === 'new' || mode === 'edit') ? (
            <>
              <div className="fd-head">
                <div className="fd-title">{mode === 'edit' && editPo ? `PO #${editPo.po_id}` : 'New PO'}</div>
                <div className="fd-sub">{mode === 'edit' ? 'Edit an open PO' : 'Status starts Processing'}</div>
              </div>
              {renderPoForm(mode === 'edit')}
            </>
          ) : null}

          {mode === 'group' && renderGroupModal()}
        </main>
      </div>
    </>
  );

  if (embedded) return body;
  return (
    <div className="ops">
      <AppHeader active="purchasing" userEmail={userEmail} />
      {body}
    </div>
  );

  // ── PR152 → PR256: the To-ship detail. A read-only recap of EVERYTHING To-forwarder recorded
  // (supplier · item link · unit cost · local courier & tracking · marketplace id · notes), with
  // easy-copy on the unit cost and item link; the Edit button unlocks the same auto-save-on-blur
  // fields as To forwarder. SKU, qty, customer and status stay fixed at this stage (status flows
  // from grouping / receiving); the Shipment ID attach / detach keeps working either way. ──
  function renderShipDetail() {
    if (!editPo) return null;
    const sup = suppliers.find((s) => s.supplier_id === editPo.supplier_id);
    const ccy = currencyForCountry(sup?.country);
    // prefer the live lookup by id — an Edit-mode supplier change patches supplier_id only,
    // so editPo.supplier_name can be stale
    const supplierName = sup?.name || editPo.supplier_name || null;
    const costText = editPo.item_cost != null ? `${ccy ? ccy.symbol : ''}${editPo.item_cost}` : null;
    const courierText = [editPo.method || null, editPo.tracking_to_forwarder ? `#${editPo.tracking_to_forwarder}` : null].filter(Boolean).join(' · ');
    // edit mode: the unit-cost symbol filler follows the supplier currently picked in the form
    const editSup = suppliers.find((s) => s.supplier_id === Number(form.supplier_id));
    const editCcy = currencyForCountry(editSup?.country);
    return (
      <div className="po-form">
        {!shipEditing ? (
          /* what was set in To forwarder — read-only rows; unit cost + item link are easy-copy */
          <div className="po-roview">
            <div className="po-rorow"><span className="po-rok">Source</span><span className="po-rov">{supplierName || '—'}</span></div>
            <div className="po-rorow">
              <span className="po-rok">Item link</span>
              <span className="po-rov po-rov-link">{editPo.product_link ? <a href={editPo.product_link} target="_blank" rel="noreferrer">{editPo.product_link}</a> : '—'}</span>
              {editPo.product_link && (
                <button className="po-rocopy" onClick={() => copyVal(editPo.product_link!, 'link')} aria-label={copiedKey === 'link' ? 'Item link copied' : 'Copy item link'} title="Copy item link">
                  {copiedKey === 'link' ? <CheckIcon /> : <CopyIcon />}
                </button>
              )}
            </div>
            <div className="po-rorow">
              <span className="po-rok">Unit cost</span>
              <span className="po-rov">{costText || '—'}</span>
              {editPo.item_cost != null && (
                <button className="po-rocopy" onClick={() => copyVal(String(editPo.item_cost), 'cost')} aria-label={copiedKey === 'cost' ? 'Unit cost copied' : 'Copy unit cost'} title="Copy unit cost">
                  {copiedKey === 'cost' ? <CheckIcon /> : <CopyIcon />}
                </button>
              )}
            </div>
            <div className="po-rorow"><span className="po-rok">Local courier</span><span className="po-rov">{courierText || '—'}</span></div>
            <div className="po-rorow"><span className="po-rok">Marketplace ID</span><span className="po-rov">{editPo.marketplace_order_id || '—'}</span></div>
            <div className="po-rorow"><span className="po-rok">Notes</span><span className="po-rov">{editPo.item_note || '—'}</span></div>
          </div>
        ) : (
          <>
            {/* Edit mode — the To-forwarder field set, auto-saving on blur/change */}
            <div className="po-field">
              <label>Source</label>
              <select
                value={form.supplier_id}
                onChange={(e) => {
                  const supplier_id = e.target.value ? Number(e.target.value) : '';
                  setForm((f) => ({ ...f, supplier_id }));
                  autoSaveForwarder({ supplier_id: supplier_id ? Number(supplier_id) : undefined });
                }}
              >
                <option value="">— pick a supplier —</option>
                {suppliers.map((s) => (
                  <option key={s.supplier_id} value={s.supplier_id}>{s.flag ? `${s.flag} ` : ''}{s.name}</option>
                ))}
              </select>
            </div>
            <div className="po-field">
              <label>Item link <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
              <input
                type="text"
                placeholder="https://…"
                value={form.product_link}
                onChange={(e) => setForm((f) => ({ ...f, product_link: e.target.value }))}
                onBlur={(e) => autoSaveForwarder({ product_link: e.target.value.trim() || null })}
              />
            </div>
            <div className="po-field">
              <label>Unit cost <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
              <div className="po-cost-row">
                {editCcy && <span className="po-cost-ccy">{editCcy.symbol}</span>}
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  placeholder="0"
                  value={form.item_cost}
                  onChange={(e) => setForm((f) => ({ ...f, item_cost: e.target.value }))}
                  onBlur={(e) => autoSaveForwarder({ item_cost: numOrNull(e.target.value) })}
                />
              </div>
            </div>
            <div className="po-field">
              <label>Local courier &amp; tracking <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
              <div className="po-inline2">
                <input
                  type="text"
                  list="ship-methods"
                  placeholder="courier"
                  value={form.method}
                  onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}
                  onBlur={(e) => autoSaveForwarder({ method: e.target.value.trim() || null })}
                />
                <input
                  type="text"
                  placeholder="tracking number"
                  value={form.tracking_to_forwarder}
                  onChange={(e) => setForm((f) => ({ ...f, tracking_to_forwarder: e.target.value }))}
                  onBlur={(e) => autoSaveForwarder({ tracking_to_forwarder: e.target.value.trim() || null })}
                />
              </div>
              <datalist id="ship-methods">{(localCouriers.length ? localCouriers : METHODS).map((m) => <option key={m} value={m} />)}</datalist>
            </div>
            <div className="po-field">
              <label>Marketplace ID <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
              <input
                type="text"
                placeholder="marketplace order id"
                value={form.marketplace_order_id}
                onChange={(e) => setForm((f) => ({ ...f, marketplace_order_id: e.target.value }))}
                onBlur={(e) => autoSaveForwarder({ marketplace_order_id: e.target.value.trim() || null })}
              />
            </div>
            <div className="po-field">
              <label>Notes <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
              <textarea
                value={form.item_note}
                onChange={(e) => setForm((f) => ({ ...f, item_note: e.target.value }))}
                onBlur={(e) => autoSaveForwarder({ item_note: e.target.value.trim() || null })}
              />
            </div>
          </>
        )}

        {/* Shipment — attach / detach an open Ship ID; its warehouse note rides along when attached */}
        <div className="po-field">
          <label>Shipment</label>
          {form.ship_id ? (
            <>
              <div className="po-shipbox">
                <span className="fwd-prefix">{form.ship_id}</span>
                <button className="btn-link" onClick={detach} disabled={busy}>detach</button>
              </div>
              <textarea
                style={{ marginTop: 8 }}
                value={shipNote}
                onChange={(e) => setShipNote(e.target.value)}
                onBlur={(e) => saveShipNote(e.target.value)}
                placeholder="Note for this Ship ID — shown to the warehouse on Inbound receiving"
                rows={2}
              />
            </>
          ) : (
            <div className="po-inline2">
              <select value={attachShipId} onChange={(e) => setAttachShipId(e.target.value)}>
                <option value="">— pick an open shipment —</option>
                {shipments.map((s) => (
                  <option key={s.ship_id} value={s.ship_id}>{s.ship_id}</option>
                ))}
              </select>
              <button className="btn-secondary" onClick={attachShip} disabled={busy || !attachShipId}>Attach</button>
            </div>
          )}
        </div>

        {/* PR256 — the Sales / To-forwarder action-bar standard: secondary (Edit) then destructive
            last; Delete opens a modal confirm instead of the old bare trash + inline ask. */}
        <div className="td-actions">
          <button className="btn-secondary btn-ico" onClick={() => setShipEditing((v) => !v)} disabled={busy}>
            <PencilIcon />{shipEditing ? 'Done' : 'Edit'}
          </button>
          <button className="btn-danger btn-ico" onClick={() => setConfirmDel(true)} disabled={busy}><TrashIcon />Delete PO</button>
        </div>
        {confirmDel && (
          <div className="sc-modal-backdrop" onClick={() => setConfirmDel(false)}>
            <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Delete PO" onClick={(e) => e.stopPropagation()}>
              <div className="sc-modal-head"><div className="sc-modal-title">Delete PO #{editPo.po_id}?</div></div>
              <div className="sc-modal-body">This removes the order entirely.</div>
              <div className="sc-modal-foot">
                <button className="btn-secondary" onClick={() => setConfirmDel(false)} disabled={busy}>Cancel</button>
                <button className="btn-primary danger" onClick={doDelete} disabled={busy}>{busy ? 'Deleting…' : 'Delete PO'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── PR248 — the two-step BATCH overlay. Step 1: tick items that share a supplier + local courier.
  // Step 2: supplier / courier / tracking / notes apply to the whole group; unit cost + item link are
  // per item (or open a single item's full detail). Confirm advances them all → To ship. ──
  function renderBatchModal() {
    const picked = shownFiltered.filter((po) => batchIds.has(po.po_id));
    return (
      <div className="sc-modal-backdrop" onClick={closeBatch}>
        <div className="sc-modal batch-modal" role="dialog" aria-modal="true" aria-label="Confirm items" onClick={(e) => e.stopPropagation()}>
          <div className="sc-modal-head sc-modal-head-row">
            <div className="sc-modal-title">{batchStep === 'pick' ? 'Confirm item(s) · step 1 of 2' : 'Confirm item(s) · step 2 of 2'}</div>
            <button className="sc-modal-x" onClick={closeBatch} aria-label="Close">×</button>
          </div>

          {batchStep === 'pick' ? (
            <>
              <div className="sc-modal-body">
                <div className="hint" style={{ marginBottom: 8 }}>Tick items that share one supplier &amp; local courier.</div>
                {picked.length === 0 && shownFiltered.length === 0 && <div className="hint">Nothing to batch.</div>}
                <ul className="po-cards po-cards-compact batch-picklist">
                  {shownFiltered.map((po) => (
                    <li key={po.po_id}>
                      <label className="po-row-wrap batch-pickrow">
                        <input type="checkbox" className="po-check" checked={batchIds.has(po.po_id)} onChange={() => toggleBatch(po.po_id)} aria-label={`select PO ${po.po_id}`} />
                        <span className="po-card batch-pickcard" style={{ flex: 1, minWidth: 0 }}>
                          <SkuImage status={imgMap[po.item_code ?? '']?.status} displayUrl={imgMap[po.item_code ?? '']?.displayUrl} name={po.name} size={SKU_IMG.sm} />
                          <div className="po-card-main">
                            <div className="po-card-l1">
                              <span className="ff-code">{po.item_code ?? po.item_code_raw ?? '—'}</span>
                              <span className="po-card-poid">{fmtNiceDate(po.status_since)}</span>
                            </div>
                            <div className="po-card-l2">
                              {isRealName(po.name, po.item_code ?? po.item_code_raw) && <span className="ff-name">{po.name}</span>}
                              <span className="po-card-qty">×{po.qty}</span>
                            </div>
                          </div>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="sc-modal-foot">
                <button className="btn-secondary" onClick={closeBatch}>Cancel</button>
                <button className="btn-primary" onClick={batchNext} disabled={batchIds.size === 0}>Next · {batchIds.size} selected</button>
              </div>
            </>
          ) : (
            <>
              <div className="sc-modal-body">
                {/* group fields — each its own subheader; applied to every picked item */}
                <div className="batch-group">
                  <div className="fd-section-head">Source</div>
                  <select className="batch-field" value={batchSupplier} onChange={(e) => setBatchSupplier(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">— pick a supplier —</option>
                    {suppliers.map((s) => (
                      <option key={s.supplier_id} value={s.supplier_id}>{s.flag ? `${s.flag} ` : ''}{s.name}</option>
                    ))}
                  </select>
                </div>
                <div className="batch-group">
                  <div className="fd-section-head">Local courier &amp; tracking</div>
                  <div className="po-inline2">
                    <input className="batch-field" type="text" list="batch-methods" placeholder="courier" value={batchMethod} onChange={(e) => setBatchMethod(e.target.value)} />
                    <input className="batch-field" type="text" placeholder="tracking number" value={batchTracking} onChange={(e) => setBatchTracking(e.target.value)} />
                  </div>
                  <datalist id="batch-methods">{(localCouriers.length ? localCouriers : METHODS).map((m) => <option key={m} value={m} />)}</datalist>
                </div>
                <div className="batch-group">
                  <div className="fd-section-head">Marketplace ID</div>
                  <input className="batch-field" type="text" placeholder="marketplace order id" value={batchMarketplace} onChange={(e) => setBatchMarketplace(e.target.value)} />
                </div>
                <div className="batch-group">
                  <div className="fd-section-head">Notes</div>
                  <textarea className="batch-field" value={batchNote} onChange={(e) => setBatchNote(e.target.value)} />
                </div>

                {/* item list (PR256) — plain flush-left rows (no card box): 54px image + two lines,
                    SKU ×qty / unit cost (no spinner) · name / item link */}
                <div className="fd-section-head batch-items-head">Item list, costs &amp; links</div>
                <ul className="batch-items">
                  {picked.map((po) => {
                    const code = po.item_code ?? po.item_code_raw ?? '—';
                    return (
                      <li key={po.po_id} className="batch-item">
                        <SkuImage status={imgMap[po.item_code ?? '']?.status} displayUrl={imgMap[po.item_code ?? '']?.displayUrl} name={po.name} size={SKU_IMG.smd} />
                        <div className="batch-item-body">
                          <div className="batch-item-row">
                            <span className="batch-item-id"><span className="ff-code">{code}</span><span className="po-card-qty">×{po.qty}</span></span>
                            <input
                              className="batch-field batch-cost"
                              type="number" inputMode="decimal" min={0} step="any" placeholder="unit cost"
                              value={batchPer[po.po_id]?.cost ?? ''}
                              onChange={(e) => setBatchPer((p) => ({ ...p, [po.po_id]: { cost: e.target.value, link: p[po.po_id]?.link ?? '' } }))}
                            />
                          </div>
                          <div className="batch-item-row">
                            <span className="ff-name batch-item-name">{isRealName(po.name, code) ? po.name : ''}</span>
                            <input
                              className="batch-field batch-link"
                              type="text" placeholder="item link"
                              value={batchPer[po.po_id]?.link ?? ''}
                              onChange={(e) => setBatchPer((p) => ({ ...p, [po.po_id]: { cost: p[po.po_id]?.cost ?? '', link: e.target.value } }))}
                            />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="sc-modal-foot">
                <button className="btn-secondary" onClick={() => setBatchStep('pick')}>← Back</button>
                <button className="btn-primary btn-ico" onClick={submitBatch} disabled={batchBusy || batchIds.size === 0}><TruckIcon />{batchBusy ? 'Confirming…' : `Ready to Ship · ${batchIds.size}`}</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── the To-forwarder detail form: record what was bought, then confirm it to To ship. No Save
  // button — every field auto-saves on blur/change (mirrors the Settings editors). Fields, in fill
  // order: Supplier · Item link · Unit cost · Courier · Tracking # · Marketplace ID · Notes. ──
  function renderForwarderForm() {
    const selSup = suppliers.find((s) => s.supplier_id === Number(form.supplier_id));
    const ccy = currencyForCountry(selSup?.country);
    return (
      <div className="po-form">
        {/* 1 · Source — LOCKED (PR284): it's chosen in Buy and can't change here. A legacy PO with no
            Source yet falls back to an editable picker so it isn't stranded. */}
        <div className="po-field">
          <label>Source</label>
          {form.supplier_id ? (
            <div className="po-ro-locked">{selSup ? `${selSup.flag ? selSup.flag + ' ' : ''}${selSup.name}` : '—'}</div>
          ) : (
            <select
              value={form.supplier_id}
              onChange={(e) => {
                const supplier_id = e.target.value ? Number(e.target.value) : '';
                setForm((f) => ({ ...f, supplier_id }));
                autoSaveForwarder({ supplier_id: supplier_id ? Number(supplier_id) : undefined });
              }}
            >
              <option value="">— pick a source —</option>
              {suppliers.map((s) => (
                <option key={s.supplier_id} value={s.supplier_id}>{s.flag ? `${s.flag} ` : ''}{s.name}</option>
              ))}
            </select>
          )}
        </div>

        {/* 2 · Item link */}
        <div className="po-field">
          <label>Item link <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
          <input
            type="text"
            placeholder="https://…"
            value={form.product_link}
            onChange={(e) => setForm((f) => ({ ...f, product_link: e.target.value }))}
            onBlur={(e) => autoSaveForwarder({ product_link: e.target.value.trim() || null })}
          />
        </div>

        {/* 3 · Unit cost (optional) — the symbol filler still follows the supplier's country. */}
        <div className="po-field">
          <label>Unit cost <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
          <div className="po-cost-row">
            {ccy && <span className="po-cost-ccy">{ccy.symbol}</span>}
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder="0"
              value={form.item_cost}
              onChange={(e) => setForm((f) => ({ ...f, item_cost: e.target.value }))}
              onBlur={(e) => autoSaveForwarder({ item_cost: numOrNull(e.target.value) })}
            />
          </div>
        </div>

        {/* 4 · Local courier & tracking, one line (PR151) — the DOMESTIC leg to the forwarder,
            distinct from the mandatory outbound Shipping courier. Suggestions come from Settings →
            Purchasing → Local couriers (0055; falls back to the legacy hard-wired list). */}
        <div className="po-field">
          <label>Local courier &amp; tracking <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
          <div className="po-inline2">
            <input
              type="text"
              list="po-methods"
              placeholder="courier"
              value={form.method}
              onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}
              onBlur={(e) => autoSaveForwarder({ method: e.target.value.trim() || null })}
            />
            <input
              type="text"
              placeholder="tracking number"
              value={form.tracking_to_forwarder}
              onChange={(e) => setForm((f) => ({ ...f, tracking_to_forwarder: e.target.value }))}
              onBlur={(e) => autoSaveForwarder({ tracking_to_forwarder: e.target.value.trim() || null })}
            />
          </div>
          <datalist id="po-methods">{(localCouriers.length ? localCouriers : METHODS).map((m) => <option key={m} value={m} />)}</datalist>
        </div>

        {/* 5 · Marketplace ID (PR151: always shown, no longer China-only) */}
        <div className="po-field">
          <label>Marketplace ID <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
          <input
            type="text"
            placeholder="marketplace order id"
            value={form.marketplace_order_id}
            onChange={(e) => setForm((f) => ({ ...f, marketplace_order_id: e.target.value }))}
            onBlur={(e) => autoSaveForwarder({ marketplace_order_id: e.target.value.trim() || null })}
          />
        </div>

        {/* 6 · Notes (optional) */}
        <div className="po-field">
          <label>Notes <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
          <textarea
            value={form.item_note}
            onChange={(e) => setForm((f) => ({ ...f, item_note: e.target.value }))}
            onBlur={(e) => autoSaveForwarder({ item_note: e.target.value.trim() || null })}
          />
        </div>

        {/* PR248 — action-bar standard: left-aligned, slides on mobile; primary then destructive.
            Delete opens a Sales-style modal confirm. Edits auto-save on blur. */}
        <div className="td-actions">
          <button className="btn-primary btn-ico" onClick={confirmOne} disabled={busy}><TruckIcon />{busy ? '…' : 'Ready to Ship'}</button>
          <button className="btn-danger btn-ico" onClick={() => setConfirmDel(true)} disabled={busy}><TrashIcon />Delete PO</button>
        </div>
        {confirmDel && (
          <div className="sc-modal-backdrop" onClick={() => setConfirmDel(false)}>
            <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Delete PO" onClick={(e) => e.stopPropagation()}>
              <div className="sc-modal-head"><div className="sc-modal-title">Delete PO #{editPo?.po_id}?</div></div>
              <div className="sc-modal-body">This removes the order entirely.</div>
              <div className="sc-modal-foot">
                <button className="btn-secondary" onClick={() => setConfirmDel(false)} disabled={busy}>Cancel</button>
                <button className="btn-primary danger" onClick={doDelete} disabled={busy}>{busy ? 'Deleting…' : 'Delete PO'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── the new/edit PO form ──
  function renderPoForm(isEdit: boolean) {
    return (
      <div className="po-form">
        {/* Supplier */}
        <div className="po-field">
          <label>Source</label>
          <div className="po-inline">
            <div className="po-field" style={{ marginBottom: 0 }}>
              <select value={form.supplier_id} onChange={(e) => setForm((f) => ({ ...f, supplier_id: e.target.value ? Number(e.target.value) : '' }))}>
                <option value="">— pick a supplier —</option>
                {suppliers.map((s) => (
                  <option key={s.supplier_id} value={s.supplier_id}>{s.flag ? `${s.flag} ` : ''}{s.name}</option>
                ))}
              </select>
            </div>
            <button className="btn-brown btn-ico" onClick={() => setSupForm(supForm ? null : { name: '', country: '', flag: '', type: 'Taobao account' })}><StoreIcon />add supplier</button>
          </div>
          {supForm && (
            <div className="subform" style={{ marginTop: 8 }}>
              <div className="subform-label">+ add supplier</div>
              <input type="text" placeholder="name (e.g. 1688-zhang)" value={supForm.name} onChange={(e) => setSupForm({ ...supForm, name: e.target.value })} />
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="text" placeholder="flag (🇨🇳)" value={supForm.flag} onChange={(e) => setSupForm({ ...supForm, flag: e.target.value })} style={{ width: 90 }} />
                <input type="text" placeholder="country" value={supForm.country} onChange={(e) => setSupForm({ ...supForm, country: e.target.value })} style={{ flex: 1 }} />
              </div>
              <select value={supForm.type} onChange={(e) => setSupForm({ ...supForm, type: e.target.value as SupplierType })}>
                {SUPPLIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <div className="subform-actions">
                <button className="btn-link" onClick={() => setSupForm(null)}>cancel</button>
                <button className="btn-secondary" onClick={submitSupplier} disabled={busy}>add</button>
              </div>
            </div>
          )}
        </div>

        {/* SKU */}
        <div className="po-field">
          <label>Item (SKU)</label>
          {form.item_code ? (
            <div className="po-current">
              <span className="ff-code">{form.item_code}</span>
              <span className="ff-name">{form.item_name}</span>
              <button className="btn-link po-detach" onClick={() => setForm((f) => ({ ...f, item_code: '', item_name: '' }))}>change</button>
            </div>
          ) : (
            <>
              <div className="scan-row">
                <SearchInput value={skuQuery} onChange={setSkuQuery} placeholder="search SKU by code / name" />
              </div>
              {skuQuery.trim().length >= 2 && !skuSearching && skuHits.length === 0 && (
                <div className="hint" style={{ marginTop: 6 }}>No matching SKUs.</div>
              )}
              {skuHits.length > 0 && (
                <ul className="result-list" style={{ marginTop: 6 }}>
                  {skuHits.map((h) => (
                    <li key={h.item_code}>
                      <button className="result-item po-sku-hit" onClick={() => pickSku(h)}>
                        <span className="ri-name"><SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={SKU_IMG.sm} /> {h.item_code} · {h.name}</span>
                        <span className="po-sku-meta">avail <b>{h.available}</b> · pending <b>{h.pending}</b> · on the way <b>{h.with_forwarder + h.on_the_way}</b></span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {/* qty + unit cost */}
        <div className="po-inline">
          <div className="po-field">
            <label>Qty</label>
            <input type="number" inputMode="numeric" min={0} step={1} value={form.qty} onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))} />
          </div>
          <div className="po-field">
            <label>Unit cost <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(supplier ccy)</em></label>
            <input type="number" inputMode="decimal" min={0} step="any" value={form.item_cost} onChange={(e) => setForm((f) => ({ ...f, item_cost: e.target.value }))} />
          </div>
        </div>

        {/* method + marketplace order id */}
        <div className="po-inline">
          <div className="po-field">
            <label>Method</label>
            <input type="text" list="po-methods" placeholder="domestic courier" value={form.method} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))} />
            <datalist id="po-methods">{METHODS.map((m) => <option key={m} value={m} />)}</datalist>
          </div>
          <div className="po-field">
            <label>Marketplace order #</label>
            <input type="text" placeholder="Taobao order id (opt)" value={form.marketplace_order_id} onChange={(e) => setForm((f) => ({ ...f, marketplace_order_id: e.target.value }))} />
          </div>
        </div>

        {/* for customer (optional) */}
        <div className="po-field">
          <label>For customer <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
          {form.customer_id != null ? (
            <div className="po-current">
              <span className="ff-name">{form.customer_label}</span>
              <button className="btn-link po-detach" onClick={() => setForm((f) => ({ ...f, customer_id: null, customer_label: '' }))}>clear</button>
            </div>
          ) : (
            <>
              <div className="scan-row">
                <SearchInput value={custQuery} onChange={setCustQuery} placeholder="search customer by name / phone" />
              </div>
              {custQuery.trim().length >= 2 && !custSearching && custHits.length === 0 && (
                <div className="hint" style={{ marginTop: 6 }}>No matching customers.</div>
              )}
              {custHits.length > 0 && (
                <ul className="result-list" style={{ marginTop: 6 }}>
                  {custHits.map((h) => (
                    <li key={h.customer_id}>
                      <button className="result-item" onClick={() => pickCustomer(h)}>
                        <span className="ri-name">{customerLabel(h.name, h.phone)}</span>
                        <span className="ri-meta">{h.phone || '—'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {/* note */}
        <div className="po-field">
          <label>Note</label>
          <textarea value={form.item_note} onChange={(e) => setForm((f) => ({ ...f, item_note: e.target.value }))} />
        </div>

        {/* status (edit only) + shipment detach */}
        {isEdit && (
          <>
            <div className="po-field">
              <label>Status</label>
              <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as POOpenStatus }))}>
                {OPEN_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {form.ship_id && (
              <div className="po-field">
                <label>Shipment</label>
                <div className="po-current">
                  <span className="ff-code">{form.ship_id}</span>
                  <button className="btn-link po-detach" onClick={detach} disabled={busy}>detach</button>
                </div>
              </div>
            )}
          </>
        )}

        <div className="fd-commit">
          <div className="fd-commit-info">{isEdit ? 'Editing is blocked once Received.' : 'New PO → Processing.'}</div>
          <button className="btn-primary" onClick={isEdit ? submitEdit : submitCreate} disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create PO'}
          </button>
        </div>

        {/* Delete order — for an order that won't be confirmed (danger text-button + inline confirm). */}
        {isEdit && (
          <div className="ob-return">
            {!confirmDel ? (
              <button className="btn-link danger" onClick={() => setConfirmDel(true)} disabled={busy}>Delete order</button>
            ) : (
              <span className="rcv-reverse-ask">
                Delete PO #{editPo?.po_id}? This removes the order entirely.
                <button className="btn-secondary" onClick={() => setConfirmDel(false)} disabled={busy}>Cancel</button>
                <button className="btn-primary danger" onClick={doDelete} disabled={busy}>{busy ? 'Deleting…' : 'Yes, delete'}</button>
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── PR251 — the group-into-shipment OVERLAY (opened by the tab-row "Create shipment ID"): the picked
  // POs (with a per-PO ship-qty stepper), the forwarder, and the Ship ID picker. Buttons carry icons. ──
  function renderGroupModal() {
    const setSend = (po: OpenPORow, n: number) => {
      const v = Math.max(1, Math.min(po.qty, Math.floor(n) || 1));
      setGrpQty((prev) => ({ ...prev, [po.po_id]: v }));
    };
    const close = () => { if (!busy) setMode(null); };
    return (
      <div className="sc-modal-backdrop" onClick={close}>
        <div className="sc-modal batch-modal" role="dialog" aria-modal="true" aria-label="Create shipment" onClick={(e) => e.stopPropagation()}>
          <div className="sc-modal-head sc-modal-head-row">
            <div className="sc-modal-title">Create shipment · {totalItems} item{totalItems === 1 ? '' : 's'}</div>
            <button className="sc-modal-x" onClick={close} aria-label="Close">×</button>
          </div>
          <div className="sc-modal-body">
            {error && <div className="validation err" style={{ marginBottom: 10 }}>{error}</div>}

            <div className="batch-group">
              <div className="fd-section-head">Selected POs · ship date {fmtNiceDate(grpDate)}</div>
              <ul className="po-cards po-cards-compact">
                {selectedPOs.map((po) => (
                  <li key={po.po_id}>
                    <div className="po-card">
                      <SkuImage status={imgMap[po.item_code ?? '']?.status} displayUrl={imgMap[po.item_code ?? '']?.displayUrl} name={po.name} size={SKU_IMG.sm} />
                      <div className="po-card-main">
                        <div className="po-card-l1"><span className="ff-code">{po.item_code ?? po.item_code_raw ?? '—'}</span></div>
                        <div className="po-card-l2">
                          {isRealName(po.name, po.item_code ?? po.item_code_raw) && <span className="ff-name">{po.name}</span>}
                          {po.qty > 1 ? (
                            <span className="grp-qty">
                              <span className="qty-step">
                                <button type="button" aria-label="one fewer" onClick={() => setSend(po, sendQty(po) - 1)} disabled={sendQty(po) <= 1}>−</button>
                                <input type="number" inputMode="numeric" min={1} max={po.qty} value={sendQty(po)} onChange={(e) => setSend(po, Number(e.target.value))} />
                                <button type="button" aria-label="one more" onClick={() => setSend(po, sendQty(po) + 1)} disabled={sendQty(po) >= po.qty}>+</button>
                              </span>
                              <span className="grp-qty-of">/ {po.qty}</span>
                            </span>
                          ) : (
                            <span className="po-card-qty">×1</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            {/* PR285 — Shipment ID is now the single primary field: type it (autocomplete surfaces the
                last-used, e.g. SUB 192, so you can bump to SUB 193). The shipment CODE (the leading
                letters) is derived from what you type — no separate picker. */}
            <div className="batch-group">
              <div className="fd-section-head">Shipment ID</div>
              <input className="field" type="text" list="grp-shipids" placeholder='e.g. "SUB 193"' value={grpShipId} onChange={(e) => setGrpShipId(e.target.value)} />
              <datalist id="grp-shipids">{shipIdOpts.map((s) => <option key={s} value={s} />)}</datalist>
              {openShipmentChoices.length > 0 && (
                <div className="grp-shipid-picks">
                  <span className="grp-shipid-lead">or add to an open shipment:</span>
                  {openShipmentChoices.map((s) => (
                    <button
                      key={s.ship_id}
                      type="button"
                      className={`chip ${grpShipId.trim() === s.ship_id ? 'active' : ''}`}
                      onClick={() => pickExistingShipment(s.ship_id)}
                    >
                      {s.ship_id}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="batch-group">
              {/* PR274/PR285 — Consolidator → Shipper leg: courier (dropdown, shared local list) + tracking. */}
              <div className="fd-section-head">Consolidator courier &amp; tracking <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></div>
              <div className="po-inline2">
                <select className="field" value={grpConsolCourier} onChange={(e) => setGrpConsolCourier(e.target.value)}>
                  <option value="">— courier —</option>
                  {(localCouriers.length ? localCouriers : METHODS).map((m) => <option key={m} value={m}>{m}</option>)}
                  {grpConsolCourier && !(localCouriers.length ? localCouriers : METHODS).includes(grpConsolCourier) && <option value={grpConsolCourier}>{grpConsolCourier}</option>}
                </select>
                <input className="field" type="text" placeholder="consolidator tracking" value={grpConsolTracking} onChange={(e) => setGrpConsolTracking(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="sc-modal-foot">
            <button className="btn-secondary" onClick={close} disabled={busy}>Cancel</button>
            <button className="btn-primary btn-ico" onClick={submitGroup} disabled={busy || selectedCount === 0}><PackageIcon />{busy ? 'Grouping…' : 'Group shipment'}</button>
          </div>
        </div>
      </div>
    );
  }
}

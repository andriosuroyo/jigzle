'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { customerLabel } from '@jigzle/lib';
import type { Forwarder, OpenPORow, POOpenStatus, Supplier, SupplierType } from '@jigzle/db/types';
import {
  addSupplier,
  createPO,
  deletePO,
  getLastShipId,
  getOpenPOs,
  getOpenShipments,
  groupIntoShipment,
  searchCustomers,
  searchSkus,
  setPOStatus,
  updatePO,
} from '@/app/purchasing/actions';
import type { CustomerHit, OpenShipmentRow, SkuHit, UpdatePOPatch } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const OPEN_STATUSES: POOpenStatus[] = ['Processing', 'On the way', 'With Forwarder'];
const SUPPLIER_TYPES: SupplierType[] = ['Taobao account', 'agent', 'marketplace', 'other'];
const METHODS = ['EMS', 'ZTO', 'SF', 'YTO', 'STO', 'JD', 'Yunda', 'Best', 'China Post'];

// supplier-country → unit-cost currency filler (To forwarder). Keyed by the supplier's country
// (case-insensitive). Unknown / unset country → a generic "supplier ccy" label, no symbol.
const CURRENCY_BY_COUNTRY: Record<string, { label: string; symbol: string }> = {
  china: { label: 'yuan', symbol: '¥' },
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

const fmtDay = (s: string | null): string => (s ? s.slice(0, 10) : '');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 'YYYY-MM-DD' → 'Jul 1, 2026' (display only; avoids Date() tz surprises)
function fmtNiceDate(s: string | null): string {
  if (!s) return '';
  const [y, m, d] = s.slice(0, 10).split('-');
  const mi = parseInt(m, 10) - 1;
  return `${MONTHS[mi] ?? m} ${parseInt(d, 10)}, ${y}`;
}

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
  const [form, setForm] = useState<PoForm>(emptyForm());

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false); // inline delete-order confirm (edit pane)

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
  const [grpShipId, setGrpShipId] = useState('');
  const [grpOrigin, setGrpOrigin] = useState(''); // kept internally (from an existing shipment) — no UI field
  const [grpDate, setGrpDate] = useState(todayStr());
  const [grpLastId, setGrpLastId] = useState<string | null>(null); // "last ID:" hint for the picked forwarder
  const [grpQty, setGrpQty] = useState<Record<number, number>>({}); // per-PO ship qty override (partial split)

  const selectedCount = selectedPoIds.size;
  const selectedPOs = useMemo(() => queue.filter((p) => selectedPoIds.has(p.po_id)), [queue, selectedPoIds]);
  // effective ship qty for a selected PO (defaults to its full qty; clamped 1..qty)
  const sendQty = (po: OpenPORow) => Math.max(1, Math.min(po.qty, grpQty[po.po_id] ?? po.qty));
  const totalItems = useMemo(() => selectedPOs.reduce((n, po) => n + sendQty(po), 0), [selectedPOs, grpQty]);

  // constrain the displayed queue to the tab's bucket (client-side over the loaded open queue)
  const shown = useMemo(() => {
    if (!bucket) return queue;
    const allowed = BUCKET_STATUSES[bucket];
    return queue.filter((p) => allowed.includes(p.status as POOpenStatus));
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
    if (bucket !== 'ship') return [];
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
    if (bucket === 'ship' && shipCountry !== ALL_COUNTRIES) {
      rows = shipCountry === OTHER_COUNTRY ? rows.filter((p) => !countryOf(p)) : rows.filter((p) => countryOf(p) === shipCountry);
    }
    const q = search.trim().toLowerCase();
    if (bucket === 'ship' && q) {
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
    setForm(formFromPO(po));
    setSkuQuery('');
    setSkuHits([]);
    setCustQuery('');
    setCustHits([]);
    setSupForm(null);
    setConfirmDel(false);
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
      setSuccess(`PO #${editPo.po_id} confirmed → To ship.`);
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

  // Ticking the first row opens the group panel automatically (no separate "Group into shipment"
  // button); clearing the last row closes it. Ticking more rows just updates the selected list.
  function toggleSelect(poId: number) {
    setSelectedPoIds((prev) => {
      const next = new Set(prev);
      if (next.has(poId)) next.delete(poId);
      else next.add(poId);
      if (next.size > 0 && mode !== 'group') {
        resetMessages();
        setMode('group');
        setGrpForwarder('');
        setGrpShipId('');
        setGrpOrigin('');
        setGrpDate(todayStr());
        setGrpLastId(null);
        setGrpQty({});
      } else if (next.size === 0 && mode === 'group') {
        setMode(null);
      }
      return next;
    });
  }

  // pick a forwarder in the group panel → show its "last ID:" hint (we do NOT auto-fill the ship id,
  // because a shipment can gain more items later, so the operator may reuse an existing id or start the
  // next number themselves). Forwarder's country seeds the (hidden) origin.
  async function pickForwarder(prefix: string) {
    setGrpForwarder(prefix);
    setGrpLastId(null);
    const fwd = forwarders.find((f) => f.prefix === prefix);
    if (fwd?.country) setGrpOrigin(fwd.country);
    if (!prefix) return;
    try {
      setGrpLastId(await getLastShipId(prefix));
    } catch {
      /* hint is best-effort */
    }
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
      setError('Supplier name is required.');
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
    if (!grpForwarder.trim()) {
      setError('Pick a forwarder.');
      return;
    }
    if (!grpShipId.trim()) {
      setError('A ship id is required (existing or new, e.g. "SUB 192").');
      return;
    }
    setBusy(true);
    try {
      const { affected } = await groupIntoShipment({
        ship_id: grpShipId.trim(),
        items: selectedPOs.map((po) => ({ po_id: po.po_id, qty: sendQty(po) })),
        forwarder_prefix: grpForwarder.trim(),
        origin_country: grpOrigin.trim() || null,
        ship_date: grpDate || null,
      });
      setSuccess(`Grouped ${totalItems} item${totalItems === 1 ? '' : 's'} into ${grpShipId.trim()} → With Forwarder.`);
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

  const body = (
    <>
      <div className="fulfill-layout">
        {/* ── Open-PO queue ── */}
        <aside className="fq-pane">
          {!embedded && <div className="fq-head"><span>Open POs</span></div>}
          {/* To ship: a free-text search over the queue (replaces the supplier filter), with Clear beside
              it (clears the search + any selection). Ticking a row auto-opens the group panel — there's
              no separate "Group into shipment" button. */}
          {bucket === 'ship' && (
            <div className="po-searchbar">
              <input
                type="text"
                className="po-search"
                placeholder="search name, SKU, supplier…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button className="btn-secondary" onClick={clearSelection} disabled={!search && selectedCount === 0}>Clear</button>
            </div>
          )}
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

          {/* To ship: country sub-tabs (by supplier origin) so same-origin items group together */}
          {bucket === 'ship' && shipCountryTabs.some((t) => t.key !== ALL_COUNTRIES && t.key !== OTHER_COUNTRY) && (
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

          {shownFiltered.length === 0 && <div className="hint fq-empty">{bucket ? 'Nothing here yet.' : 'No open POs.'}</div>}

          {/* To forwarder: compact two-line quick-view cards (small image; line 1 SKU + PO#,
              line 2 name + qty), no checkbox — tap a card to open its detail editor. */}
          {bucket === 'forwarder' ? (
            <ul className="po-cards po-cards-compact po-list-scroll" style={{ padding: 8 }}>
              {shownFiltered.map((po) => (
                <li key={po.po_id}>
                  <button className={`po-card po-card-btn ${editPo?.po_id === po.po_id ? 'active' : ''}`} onClick={() => openEdit(po)}>
                    <SkuImage status={imgMap[po.item_code ?? '']?.status} displayUrl={imgMap[po.item_code ?? '']?.displayUrl} name={po.name} size={SKU_IMG.sm} />
                    <div className="po-card-main">
                      <div className="po-card-l1">
                        <span className="ff-code">{po.item_code || '—'}</span>
                        <span className="po-card-poid">{fmtDay(po.status_since)}</span>
                      </div>
                      <div className="po-card-l2">
                        <span className="ff-name">{po.name}</span>
                        <span className="po-card-qty">×{po.qty}</span>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : bucket === 'ship' ? (
            /* To ship: same compact card as To forwarder (SKU + PO date on line 1, name + ×qty on
               line 2), with a checkbox to select for grouping. No forwarder badge or supplier detail. */
            <ul className="po-cards po-cards-compact po-list-scroll" style={{ padding: 8 }}>
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
                    <button className={`po-card po-card-btn ${editPo?.po_id === po.po_id ? 'active' : ''}`} style={{ flex: 1, minWidth: 0 }} onClick={() => openEdit(po)}>
                      <SkuImage status={imgMap[po.item_code ?? '']?.status} displayUrl={imgMap[po.item_code ?? '']?.displayUrl} name={po.name} size={SKU_IMG.sm} />
                      <div className="po-card-main">
                        <div className="po-card-l1">
                          <span className="ff-code">{po.item_code || '—'}</span>
                          <span className="po-card-poid">{fmtDay(po.status_since)}</span>
                        </div>
                        <div className="po-card-l2">
                          <span className="ff-name">{po.name}</span>
                          <span className="po-card-qty">×{po.qty}</span>
                        </div>
                        {shortFromShip(po) && (
                          <div className="po-card-l2"><span className="badge short">Short · from {shortFromShip(po)}</span></div>
                        )}
                      </div>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
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
          )}
        </aside>

        {/* ── Detail ── */}
        <main className="fd-pane">
          {!mode && !success && !error && (
            <div className="fd-empty">
              {bucket === 'forwarder'
                ? 'Select an item to add its supplier, unit cost and tracking, then confirm it to To ship.'
                : 'Select a PO to edit, hit “+ New PO”, or check rows to group into a shipment.'}
            </div>
          )}

          {error && <div className="validation err">{error}</div>}
          {success && <div className="validation ok">{success}</div>}

          {(mode === 'new' || mode === 'edit') && bucket === 'forwarder' && editPo ? (
            <>
              {/* To-forwarder detail: header = SKU + qty; subheader = PO# · date · customer (sales only) */}
              <div className="fd-head">
                <div className="fd-title">{editPo.item_code || '—'} · ×{editPo.qty}</div>
                <div className="fd-sub">
                  PO #{editPo.po_id}
                  {fmtDay(editPo.input_date) ? ` · ${fmtDay(editPo.input_date)}` : ''}
                  {editPo.customer_id != null ? ` · ${editPo.customer_name || `#${editPo.customer_id}`}` : ''}
                </div>
              </div>
              {renderForwarderForm()}
            </>
          ) : (mode === 'new' || mode === 'edit') ? (
            <>
              <div className="fd-head">
                <div className="fd-title">{mode === 'edit' && editPo ? `PO #${editPo.po_id}` : 'New PO'}</div>
                <div className="fd-sub">{mode === 'edit' ? 'Edit an open PO' : 'Status starts Processing'}</div>
              </div>
              {renderPoForm(mode === 'edit')}
            </>
          ) : null}

          {mode === 'group' && (
            <>
              <div className="fd-head">
                <div className="fd-title">Group into shipment</div>
                <div className="fd-sub">Ship date: {fmtNiceDate(grpDate)}</div>
              </div>
              {renderGroupForm()}
            </>
          )}
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

  // ── the To-forwarder detail form: record what was bought, then confirm it to To ship. No Save
  // button — every field auto-saves on blur/change (mirrors the Settings editors). Fields, in fill
  // order: Supplier · Item link · Unit cost · Courier · Tracking # · Taobao ID (China only) · Note. ──
  function renderForwarderForm() {
    const selSup = suppliers.find((s) => s.supplier_id === Number(form.supplier_id));
    const ccy = currencyForCountry(selSup?.country);
    return (
      <div className="po-form">
        {/* 1 · Supplier — managed in Settings → Suppliers (no inline add here). Flag + name, A–Z. */}
        <div className="po-field">
          <label>Supplier</label>
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

        {/* 3 · Unit cost — currency filler follows the supplier's country (¥ yuan, ¥ yen, …). 0 is valid. */}
        <div className="po-field">
          <label>Unit cost <em style={{ fontStyle: 'normal', opacity: 0.7 }}>({ccy ? ccy.label : 'supplier ccy'})</em></label>
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

        {/* 4 · Courier (optional) */}
        <div className="po-field">
          <label>Courier <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
          <input
            type="text"
            list="po-methods"
            placeholder="domestic courier"
            value={form.method}
            onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}
            onBlur={(e) => autoSaveForwarder({ method: e.target.value.trim() || null })}
          />
          <datalist id="po-methods">{METHODS.map((m) => <option key={m} value={m} />)}</datalist>
        </div>

        {/* 5 · Tracking number (optional) */}
        <div className="po-field">
          <label>Tracking number <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(to forwarder, optional)</em></label>
          <input
            type="text"
            placeholder="courier tracking number"
            value={form.tracking_to_forwarder}
            onChange={(e) => setForm((f) => ({ ...f, tracking_to_forwarder: e.target.value }))}
            onBlur={(e) => autoSaveForwarder({ tracking_to_forwarder: e.target.value.trim() || null })}
          />
        </div>

        {/* 6 · Taobao ID — only meaningful for a China supplier */}
        {isChina(selSup?.country) && (
          <div className="po-field">
            <label>Taobao ID <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
            <input
              type="text"
              placeholder="Taobao order id"
              value={form.marketplace_order_id}
              onChange={(e) => setForm((f) => ({ ...f, marketplace_order_id: e.target.value }))}
              onBlur={(e) => autoSaveForwarder({ marketplace_order_id: e.target.value.trim() || null })}
            />
          </div>
        )}

        {/* 7 · Note (optional) */}
        <div className="po-field">
          <label>Note <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
          <textarea
            value={form.item_note}
            onChange={(e) => setForm((f) => ({ ...f, item_note: e.target.value }))}
            onBlur={(e) => autoSaveForwarder({ item_note: e.target.value.trim() || null })}
          />
        </div>

        {/* Confirm → To ship (the only button; edits already auto-save). Delete stays below. */}
        <div className="fd-commit">
          <div className="fd-commit-info">Fields save as you go. Confirm once it’s with the forwarder.</div>
          <button className="btn-primary" onClick={confirmOne} disabled={busy}>{busy ? '…' : 'Confirm → To ship'}</button>
        </div>

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
      </div>
    );
  }

  // ── the new/edit PO form ──
  function renderPoForm(isEdit: boolean) {
    return (
      <div className="po-form">
        {/* Supplier */}
        <div className="po-field">
          <label>Supplier</label>
          <div className="po-inline">
            <div className="po-field" style={{ marginBottom: 0 }}>
              <select value={form.supplier_id} onChange={(e) => setForm((f) => ({ ...f, supplier_id: e.target.value ? Number(e.target.value) : '' }))}>
                <option value="">— pick a supplier —</option>
                {suppliers.map((s) => (
                  <option key={s.supplier_id} value={s.supplier_id}>{s.flag ? `${s.flag} ` : ''}{s.name}</option>
                ))}
              </select>
            </div>
            <button className="btn-secondary" onClick={() => setSupForm(supForm ? null : { name: '', country: '', flag: '', type: 'Taobao account' })}>+ add</button>
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
                <input
                  type="text"
                  placeholder="search SKU by code / name"
                  value={skuQuery}
                  onChange={(e) => setSkuQuery(e.target.value)}
                />
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
                <input
                  type="text"
                  placeholder="search customer by name / phone"
                  value={custQuery}
                  onChange={(e) => setCustQuery(e.target.value)}
                />
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

  // ── the group-into-shipment form ──
  function renderGroupForm() {
    const setSend = (po: OpenPORow, n: number) => {
      const v = Math.max(1, Math.min(po.qty, Math.floor(n) || 1));
      setGrpQty((prev) => ({ ...prev, [po.po_id]: v }));
    };
    return (
      <div className="po-form">
        {/* Selected POs — two-line cards; a PO with qty>1 gets a stepper to ship fewer than all (the
            rest stays in To ship). Header shows the total item count being shipped. */}
        <div className="po-field">
          <label>Selected POs <em style={{ fontStyle: 'normal', opacity: 0.7 }}>({totalItems} item{totalItems === 1 ? '' : 's'})</em></label>
          <ul className="po-cards po-cards-compact">
            {selectedPOs.map((po) => (
              <li key={po.po_id}>
                <div className="po-card">
                  <SkuImage status={imgMap[po.item_code ?? '']?.status} displayUrl={imgMap[po.item_code ?? '']?.displayUrl} name={po.name} size={SKU_IMG.sm} />
                  <div className="po-card-main">
                    <div className="po-card-l1"><span className="ff-code">{po.item_code || '—'}</span></div>
                    <div className="po-card-l2">
                      <span className="ff-name">{po.name}</span>
                      {po.qty > 1 ? (
                        <span className="grp-qty">
                          <span className="qty-step">
                            <button type="button" aria-label="one fewer" onClick={() => setSend(po, sendQty(po) - 1)} disabled={sendQty(po) <= 1}>−</button>
                            <input
                              type="number"
                              inputMode="numeric"
                              min={1}
                              max={po.qty}
                              value={sendQty(po)}
                              onChange={(e) => setSend(po, Number(e.target.value))}
                            />
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

        {/* Forwarder + Ship id on one row. Forwarders are managed in Settings → Forwarders (no inline
            add). Ship id is manual (a shipment can gain items later); the "last ID" hint shows the
            highest number used for the picked forwarder so you can start the next one or reuse. */}
        <div className="po-inline">
          <div className="po-field">
            <label>Forwarder</label>
            <select value={grpForwarder} onChange={(e) => pickForwarder(e.target.value)}>
              <option value="">— pick —</option>
              {forwarders.map((f) => (
                <option key={f.prefix} value={f.prefix}>{f.flag ? `${f.flag} ` : ''}{f.prefix}{f.name ? ` — ${f.name}` : ''}</option>
              ))}
            </select>
          </div>
          <div className="po-field">
            <label>Ship id</label>
            <input
              type="text"
              list="po-shipids"
              className="rcv-shipid"
              placeholder="PREFIX n"
              value={grpShipId}
              onChange={(e) => pickExistingShipment(e.target.value)}
            />
            <datalist id="po-shipids">{shipments.map((s) => <option key={s.ship_id} value={s.ship_id} />)}</datalist>
          </div>
        </div>
        {grpForwarder && (
          <div className="hint" style={{ margin: '-4px 0 8px' }}>last ID: {grpLastId ? grpLastId : 'none yet'}</div>
        )}

        <div className="fd-commit">
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
            <button className="btn-secondary" onClick={() => { setSelectedPoIds(new Set()); setGrpQty({}); setMode(null); }}>Cancel</button>
            <button className="btn-primary" onClick={submitGroup} disabled={busy || selectedCount === 0}>{busy ? 'Grouping…' : 'Group shipment'}</button>
          </div>
        </div>
      </div>
    );
  }
}

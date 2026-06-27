'use client';

import { useEffect, useMemo, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import type { Forwarder, OpenPORow, POOpenStatus, Supplier, SupplierType } from '@jigzle/db/types';
import {
  addForwarder,
  addSupplier,
  createPO,
  deletePO,
  getOpenPOs,
  getOpenShipments,
  groupIntoShipment,
  searchCustomers,
  searchSkus,
  setPOStatus,
  updatePO,
} from '@/app/purchasing/actions';
import type { CustomerHit, OpenShipmentRow, SkuHit } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const OPEN_STATUSES: POOpenStatus[] = ['Processing', 'On the way', 'With Forwarder'];
const SUPPLIER_TYPES: SupplierType[] = ['Taobao account', 'agent', 'marketplace', 'other'];
const METHODS = ['EMS', 'ZTO', 'SF', 'YTO', 'STO', 'JD', 'Yunda', 'Best', 'China Post'];

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
  const [forwarders, setForwarders] = useState<Forwarder[]>(initialForwarders);
  const [shipments, setShipments] = useState<OpenShipmentRow[]>(initialShipments);

  const [filterStatus, setFilterStatus] = useState('');
  const [filterSupplier, setFilterSupplier] = useState('');

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
  // customer search
  const [custQuery, setCustQuery] = useState('');
  const [custHits, setCustHits] = useState<CustomerHit[]>([]);
  const [custSearching, setCustSearching] = useState(false);

  // inline + add supplier
  const [supForm, setSupForm] = useState<{ name: string; country: string; flag: string; type: SupplierType } | null>(null);
  // inline + add forwarder (group mode)
  const [fwdForm, setFwdForm] = useState<{ prefix: string; name: string; country: string } | null>(null);

  // group-into-shipment form
  const [grpForwarder, setGrpForwarder] = useState('');
  const [grpShipId, setGrpShipId] = useState('');
  const [grpOrigin, setGrpOrigin] = useState('');
  const [grpDate, setGrpDate] = useState(todayStr());

  const selectedCount = selectedPoIds.size;
  const selectedPOs = useMemo(() => queue.filter((p) => selectedPoIds.has(p.po_id)), [queue, selectedPoIds]);

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

  // ── Confirm get: advance the selected To-forwarder POs to With Forwarder → they move to To ship ──
  async function confirmSelected() {
    if (selectedCount === 0) return;
    resetMessages();
    setBusy(true);
    try {
      for (const id of selectedPoIds) await setPOStatus(id, 'With Forwarder');
      setSuccess(`Confirmed ${selectedCount} item${selectedCount === 1 ? '' : 's'} → To ship.`);
      setSelectedPoIds(new Set());
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

  function toggleSelect(poId: number) {
    setSelectedPoIds((prev) => {
      const next = new Set(prev);
      if (next.has(poId)) next.delete(poId);
      else next.add(poId);
      return next;
    });
  }

  function startGroup() {
    if (selectedCount === 0) return;
    resetMessages();
    setMode('group');
    setFwdForm(null);
    setGrpForwarder('');
    setGrpShipId('');
    setGrpOrigin('');
    setGrpDate(todayStr());
  }

  // ── SKU search ──
  async function runSkuSearch() {
    const q = skuQuery.trim();
    if (q.length < 2) {
      setSkuHits([]);
      return;
    }
    setSkuSearching(true);
    try {
      setSkuHits(await searchSkus(q));
    } catch {
      setSkuHits([]);
    } finally {
      setSkuSearching(false);
    }
  }
  function pickSku(hit: SkuHit) {
    setForm((f) => ({ ...f, item_code: hit.item_code, item_name: hit.name }));
    setSkuHits([]);
    setSkuQuery('');
  }

  // ── customer search ──
  async function runCustSearch() {
    const q = custQuery.trim();
    if (q.length < 2) {
      setCustHits([]);
      return;
    }
    setCustSearching(true);
    try {
      setCustHits(await searchCustomers(q));
    } catch {
      setCustHits([]);
    } finally {
      setCustSearching(false);
    }
  }
  function pickCustomer(hit: CustomerHit) {
    setForm((f) => ({ ...f, customer_id: hit.customer_id, customer_label: hit.name || hit.phone || `#${hit.customer_id}` }));
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

  // ── inline add forwarder ──
  async function submitForwarder() {
    if (!fwdForm) return;
    const prefix = fwdForm.prefix.trim();
    if (!prefix) {
      setError('Forwarder prefix is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fwd = await addForwarder({ prefix, name: fwdForm.name.trim() || null, country: fwdForm.country.trim() || null });
      setForwarders((prev) => (prev.some((f) => f.prefix === fwd.prefix) ? prev : [...prev, fwd].sort((a, b) => a.prefix.localeCompare(b.prefix))));
      setGrpForwarder(fwd.prefix);
      if (fwd.country && !grpOrigin.trim()) setGrpOrigin(fwd.country);
      setFwdForm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add forwarder.');
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
        po_ids: [...selectedPoIds],
        forwarder_prefix: grpForwarder.trim(),
        origin_country: grpOrigin.trim() || null,
        ship_date: grpDate || null,
      });
      setSuccess(`Grouped ${affected.length} PO${affected.length === 1 ? '' : 's'} into ${grpShipId.trim()} → With Forwarder.`);
      setSelectedPoIds(new Set());
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
          <div className="po-filters">
            {/* status dropdown only in the un-bucketed (standalone) board; the tab already scopes status */}
            {!bucket && (
              <select value={filterStatus} onChange={(e) => applyFilters(e.target.value, filterSupplier)}>
                <option value="">All open</option>
                {OPEN_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            <select value={filterSupplier} onChange={(e) => applyFilters(filterStatus, e.target.value)}>
              <option value="">All suppliers</option>
              {suppliers.map((s) => <option key={s.supplier_id} value={s.supplier_id}>{s.name}</option>)}
            </select>
          </div>
          {/* New PO belongs to the buying stage — hide it in the 'ship' (already-grouped) bucket */}
          {bucket !== 'ship' && (
            <div className="po-newbtn">
              <button className="btn-primary" style={{ width: '100%' }} onClick={startNew}>+ New PO</button>
            </div>
          )}

          {/* To forwarder → Confirm get advances the selected items to To ship (With Forwarder). */}
          {selectedCount > 0 && bucket === 'forwarder' && (
            <div className="po-group-bar">
              <span className="gb-count">{selectedCount} selected</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary" style={{ flex: 1 }} onClick={confirmSelected} disabled={busy}>Confirm get →</button>
                <button className="btn-secondary" onClick={() => setSelectedPoIds(new Set())}>clear</button>
              </div>
            </div>
          )}

          {/* To ship (and the standalone board) → group the confirmed items into a shipment. */}
          {selectedCount > 0 && bucket !== 'forwarder' && (
            <div className="po-group-bar">
              <span className="gb-count">{selectedCount} selected</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary" style={{ flex: 1 }} onClick={startGroup}>Group into shipment →</button>
                <button className="btn-secondary" onClick={() => setSelectedPoIds(new Set())}>clear</button>
              </div>
            </div>
          )}

          {shown.length === 0 && <div className="hint fq-empty">{bucket ? 'Nothing here yet.' : 'No open POs.'}</div>}
          <ul className="fq-list">
            {shown.map((po) => (
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
          {!mode && !success && !error && <div className="fd-empty">Select a PO to edit, hit “+ New PO”, or check rows to group into a shipment.</div>}

          {error && <div className="validation err">{error}</div>}
          {success && <div className="validation ok">{success}</div>}

          {(mode === 'new' || mode === 'edit') && (
            <>
              <div className="fd-head">
                <div className="fd-title">{mode === 'edit' && editPo ? `PO #${editPo.po_id}` : 'New PO'}</div>
                <div className="fd-sub">{mode === 'edit' ? 'Edit an open PO' : 'Status starts Processing'}</div>
              </div>
              {renderPoForm(mode === 'edit')}
            </>
          )}

          {mode === 'group' && (
            <>
              <div className="fd-head">
                <div className="fd-title">Group into shipment</div>
                <div className="fd-sub">{selectedCount} PO{selectedCount === 1 ? '' : 's'} → With Forwarder</div>
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
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSkuSearch(); } }}
                />
                <button className="btn-secondary" onClick={runSkuSearch} disabled={skuSearching}>{skuSearching ? '…' : 'search'}</button>
              </div>
              {skuHits.length > 0 && (
                <ul className="result-list" style={{ marginTop: 6 }}>
                  {skuHits.map((h) => (
                    <li key={h.item_code}>
                      <button className="result-item po-sku-hit" onClick={() => pickSku(h)}>
                        <span className="ri-name"><SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={SKU_IMG.sm} /> {h.item_code} · {h.name}</span>
                        <span className="po-sku-meta">avail <b>{h.available}</b> · pending <b>{h.pending}</b> · on the way <b>{h.on_the_way}</b></span>
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
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runCustSearch(); } }}
                />
                <button className="btn-secondary" onClick={runCustSearch} disabled={custSearching}>{custSearching ? '…' : 'search'}</button>
              </div>
              {custHits.length > 0 && (
                <ul className="result-list" style={{ marginTop: 6 }}>
                  {custHits.map((h) => (
                    <li key={h.customer_id}>
                      <button className="result-item" onClick={() => pickCustomer(h)}>
                        <span className="ri-name">{h.name || '(no name)'}</span>
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
    return (
      <div className="po-form">
        <div className="po-field">
          <label>Selected POs</label>
          <ul className="ff-lines">
            {selectedPOs.map((po) => (
              <li key={po.po_id} className="ff-line">
                <div className="rcv-line-head">
                  <SkuImage status={imgMap[po.item_code ?? '']?.status} displayUrl={imgMap[po.item_code ?? '']?.displayUrl} name={po.name} size={SKU_IMG.sm} />
                  <span className="ff-code">{po.item_code || '—'}</span>
                  <span className="ff-name">{po.name}</span>
                  <span className="rcv-exp">×{po.qty}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="po-field">
          <label>Forwarder</label>
          <div className="po-inline">
            <div className="po-field" style={{ marginBottom: 0 }}>
              <select
                value={grpForwarder}
                onChange={(e) => {
                  setGrpForwarder(e.target.value);
                  const fwd = forwarders.find((f) => f.prefix === e.target.value);
                  if (fwd?.country && !grpOrigin.trim()) setGrpOrigin(fwd.country);
                }}
              >
                <option value="">— pick a forwarder —</option>
                {forwarders.map((f) => <option key={f.prefix} value={f.prefix}>{f.prefix}{f.name ? ` — ${f.name}` : ''}</option>)}
              </select>
            </div>
            <button className="btn-secondary" onClick={() => setFwdForm(fwdForm ? null : { prefix: '', name: '', country: '' })}>+ add</button>
          </div>
          {fwdForm && (
            <div className="subform" style={{ marginTop: 8 }}>
              <div className="subform-label">+ add forwarder</div>
              <input type="text" placeholder="prefix (e.g. SUB)" value={fwdForm.prefix} onChange={(e) => setFwdForm({ ...fwdForm, prefix: e.target.value })} />
              <input type="text" placeholder="name (e.g. Subagen)" value={fwdForm.name} onChange={(e) => setFwdForm({ ...fwdForm, name: e.target.value })} />
              <input type="text" placeholder="country" value={fwdForm.country} onChange={(e) => setFwdForm({ ...fwdForm, country: e.target.value })} />
              <div className="subform-actions">
                <button className="btn-link" onClick={() => setFwdForm(null)}>cancel</button>
                <button className="btn-secondary" onClick={submitForwarder} disabled={busy}>add</button>
              </div>
            </div>
          )}
        </div>

        <div className="po-field">
          <label>Ship id <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(existing or new, e.g. “SUB 192”)</em></label>
          <input
            type="text"
            list="po-shipids"
            className="rcv-shipid"
            placeholder="&lt;PREFIX&gt; &lt;n&gt;"
            value={grpShipId}
            onChange={(e) => pickExistingShipment(e.target.value)}
          />
          <datalist id="po-shipids">{shipments.map((s) => <option key={s.ship_id} value={s.ship_id} />)}</datalist>
        </div>

        <div className="po-inline">
          <div className="po-field">
            <label>Origin country</label>
            <input type="text" placeholder="(optional)" value={grpOrigin} onChange={(e) => setGrpOrigin(e.target.value)} />
          </div>
          <div className="po-field">
            <label>Ship date</label>
            <input type="date" value={grpDate} onChange={(e) => setGrpDate(e.target.value)} />
          </div>
        </div>

        <div className="fd-commit">
          <div className="fd-commit-info">Sets ship id on {selectedCount} PO{selectedCount === 1 ? '' : 's'}, status → With Forwarder.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={() => setMode(null)}>cancel</button>
            <button className="btn-primary" onClick={submitGroup} disabled={busy || selectedCount === 0}>{busy ? 'Grouping…' : 'Group'}</button>
          </div>
        </div>
      </div>
    );
  }
}

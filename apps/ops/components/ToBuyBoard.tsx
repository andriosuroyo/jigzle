'use client';

// Purchasing → To buy tab (PR73). Two sub-tabs (styled like the Sales Pending readiness filters),
// each a live count:
//  • Manual    — manual buy-list (PO status 'Planned'). Has "+ add item". Qty is editable (± steppers).
//  • From Sales — derived from Sales (read-only): unfulfilled lines for ≤0-available SKUs. No add button;
//                 qty mirrors the order line (uneditable).
//
// PR304 — "out of stock" is now an INLINE flag, not a separate tab: a checkbox on the detail (beside
// Source) toggles it, and a red "Out of stock" pill shows left of the qty. A manual item flips its PO
// between 'Planned' and 'Sold out'; a From-Sales line is flagged by a 'Sold out' PO created for it.
//
// Every card shares one layout (larger image): code + name, then context and stock pills. Tapping a card
// opens a detail overlay (PR221): SKU + Edit (deep-link to the Catalog editor) with the name below; the
// qty and stock statuses beside the image; the catalogue "where to buy" links listed inline; and the
// Source picker + Done / Delete actions. "Done" sends the item to To Forwarder (a Processing PO).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useUrlTab } from '@/components/useUrlTab';
import {
  buyPreorder,
  createPlannedItem,
  deletePO,
  getPlannedItems,
  getPreorders,
  getSkuSources,
  getSkuStock,
  markSkuSoldOut,
  searchSkus,
  setPOSource,
  setPOStatus,
  setSoldOut,
  updatePlannedItem,
  updatePreorderLine,
} from '@/app/purchasing/actions';
import type { PlannedItemRow, PreorderRow, SkuStockInfo, Urgency } from '@/app/purchasing/types';
import type { SkuHit } from '@/app/purchasing/types';
import type { Supplier } from '@jigzle/db/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import StockPills from '@/components/StockPills';
import TrashButton from '@/components/TrashButton';
import SearchInput from '@/components/SearchInput';
import { PackageIcon } from '@/components/AddIcons';
import { useEscToClose, useOverlayClose } from '@/components/useOverlayClose';
import DropSearch from '@/components/DropSearch';
import { isRealName } from '@/components/skuName';
import { saveDraft, loadDraft, clearDraft } from '@/components/draftStore';
import { fmtNiceDate } from '@jigzle/lib';

const fmtDate = (s: string | null): string => fmtNiceDate(s) || '—';

type SubTab = 'manual' | 'sales';

// PR260 — the "add planned item" overlay draft: the typed content only (picked SKU + qty/link/note/
// urgency). One at a time, so a single fixed key. A deliberate close discards it; only an involuntary
// reload (deploy / PWA relaunch) preserves it, and reopening the overlay restores it.
const TOBUY_DRAFT_KEY = 'jz:tobuy:draft:add';
type ToBuyDraft = { skuQuery: string; picked: { item_code: string; name: string } | null; qty: number; link: string; note: string; addUrgency: Urgency | null };

const URGENCY_OPTS: { key: Urgency; label: string }[] = [
  { key: 'low', label: 'Low' },
  { key: 'mid', label: 'Mid' },
  { key: 'high', label: 'High' },
];

// PR167 — priority now shows as a thin coloured bar down the card's LEFT edge (red=high, orange=mid,
// green=low) via a modifier class on the .po-card, instead of a pill on line 1 — de-clutters the card.
const urgClass = (u: Urgency | null): string => (u ? ` po-urg-${u}` : '');

// the bare hostname of a URL (no www.), for the favicon + a tidy fallback
function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// a buy link rendered as the URL itself (truncated), with the site's favicon on the left
function BuyLink({ url, primary }: { url: string; primary?: boolean }) {
  const host = hostOf(url);
  const fav = host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null;
  return (
    <a className={`buy-link ${primary ? 'primary' : ''}`} href={url} target="_blank" rel="noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element -- favicon from an external host, off the data path */}
      {fav && <img className="buy-fav" src={fav} alt="" width={18} height={18} referrerPolicy="no-referrer" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />}
      <span className="buy-link-url">{url}</span>
    </a>
  );
}

// PR230 — action-button icons (out of stock / done buying / delete PO), matching the Sales style.
const _ic = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, width: 16, height: 16, 'aria-hidden': true };
const BagIcon = () => (<svg {..._ic}><path d="M6 2 3 6v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 0 1-8 0" /></svg>);
const TrashIcon = () => (<svg {..._ic}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>);
const PencilIcon = () => (<svg {..._ic}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);


// the active "Buy" overlay target — enough to load + render its links and run the right write-backs.
type BuyTarget = {
  kind: SubTab;
  item_code: string;
  name: string;
  qty: number;
  po_id: number | null;        // present for a manual PO
  customer_id: number | null;  // present for a from-sales preorder
  sales_id: string | null;     // the originating sale (from-sales preorder), kept on a sold-out mark
  product_link: string | null; // the card's own link (manual product_link / preorder item_link)
  out_of_stock: boolean;       // PR304 — inline out-of-stock flag
  oos_po_id: number | null;    // PR304 — for a From-Sales OOS: the 'Sold out' PO to delete on uncheck
};

export default function ToBuyBoard({
  planned: initialPlanned,
  preorders: initialPreorders,
  suppliers = [],
}: {
  planned: PlannedItemRow[];
  preorders: PreorderRow[];
  suppliers?: Supplier[]; // PR283 — the Source pick-list for Buy
}) {
  // PR223 — the sub-tab is mirrored to ?buy= (distinct from Purchasing's ?tab=) so a hard Refresh stays put.
  const [tab, setTab] = useUrlTab<SubTab>('buy', 'manual', ['manual', 'sales']);
  const [planned, setPlanned] = useState<PlannedItemRow[]>(initialPlanned);
  const [preorders, setPreorders] = useState<PreorderRow[]>(initialPreorders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // add-item overlay
  const [adding, setAdding] = useState(false);
  const [skuQuery, setSkuQuery] = useState('');
  const [skuHits, setSkuHits] = useState<SkuHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const searchSeq = useRef(0); // stale-response guard for the debounced SKU search
  const [picked, setPicked] = useState<{ item_code: string; name: string } | null>(null);
  const [pickedStock, setPickedStock] = useState<SkuStockInfo | null>(null);
  const [qty, setQty] = useState(1);
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const [addUrgency, setAddUrgency] = useState<Urgency | null>(null);
  // PR260 — draft persistence for the add overlay (survives a reload mid-entry)
  const hydratingRef = useRef(false);
  const [addRestored, setAddRestored] = useState(false);

  // PR221 — "where to buy" links now live inline in the detail overlay (the separate Buy step is gone).
  // Loaded lazily when the overlay opens, keyed on the SKU code.
  const [buySources, setBuySources] = useState<string[]>([]);
  const [buyLoading, setBuyLoading] = useState(false);
  // PR283 — the picked Source for the open Buy item. For a real PO (manual/oos) it auto-saves; for a
  // from-sales preorder it's held here and rides buyPreorder at Done. Mandatory before Done.
  const [buySource, setBuySource] = useState('');
  // PR322 — dropsearch options for the Source picker (flag + name; value = supplier id as a string).
  const supplierOpts = useMemo(() => suppliers.map((s) => ({ value: String(s.supplier_id), label: `${s.flag ? `${s.flag} ` : ''}${s.name}` })), [suppliers]);

  // PR240 — inline edit of a Manual buy-list item (SKU / qty / priority / note). Writes only to the PO,
  // never the catalogue (the SKU is resolved server-side; unknown codes stay placeholders for Inbound).
  const [editing, setEditing] = useState(false);
  const [eSku, setESku] = useState('');
  const [eQty, setEQty] = useState(0);
  const [ePrio, setEPrio] = useState<Urgency | null>(null);
  const [eNote, setENote] = useState('');
  const [eBusy, setEBusy] = useState(false);
  const [eErr, setEErr] = useState<string | null>(null);

  // delete-confirm overlay (Manual + Out-of-Stock): holds the po_id awaiting a Yes/No
  const [confirmDelId, setConfirmDelId] = useState<number | null>(null);

  // PR168 (Option B): the tapped card → an action overlay. Store {kind,id}; the live row is derived so
  // the overlay's qty stepper stays in sync with the list state.
  const [sel, setSel] = useState<{ kind: SubTab; id: number | string } | null>(null);

  const imgCodes = useMemo(() => {
    const set = new Set<string>();
    planned.forEach((p) => { if (p.item_code) set.add(p.item_code); });
    preorders.forEach((p) => { if (p.item_code) set.add(p.item_code); });
    skuHits.forEach((h) => set.add(h.item_code));
    return [...set];
  }, [planned, preorders, skuHits]);
  const imgMap = useSkuImages(imgCodes);

  async function refresh() {
    try { setPlanned(await getPlannedItems()); } catch { /* keep */ }
    try { setPreorders(await getPreorders()); } catch { /* keep */ }
  }

  // ── add-item overlay ──
  function openAdd() {
    setAdding(true);
    setSkuHits([]); setSearched(false); setPickedStock(null);
    setError(null);
    // PR260 — restore a draft left by a reload; else start blank.
    const draft = loadDraft<ToBuyDraft>(TOBUY_DRAFT_KEY);
    if (draft && (draft.picked || draft.skuQuery.trim() || draft.link.trim() || draft.note.trim() || draft.addUrgency || draft.qty !== 1)) {
      hydratingRef.current = true;
      setSkuQuery(draft.skuQuery); setPicked(draft.picked);
      setQty(draft.qty); setLink(draft.link); setNote(draft.note); setAddUrgency(draft.addUrgency);
      setAddRestored(true);
      if (draft.picked) { getSkuStock(draft.picked.item_code).then(setPickedStock).catch(() => {}); }
      // release the gate after this render commits so subsequent edits persist
      setTimeout(() => { hydratingRef.current = false; }, 0);
    } else {
      setSkuQuery(''); setPicked(null);
      setQty(1); setLink(''); setNote(''); setAddUrgency(null);
      setAddRestored(false);
    }
  }
  // deliberate dismissal discards the draft (only an involuntary reload preserves it)
  function closeAdd() {
    clearDraft(TOBUY_DRAFT_KEY);
    setAddRestored(false);
    setAdding(false);
  }

  // a search that returns nothing means the typed text is a brand-new SKU code (the code IS the
  // identifier; no name needed). It gets added to the catalogue as a draft on submit.
  const isNewSku = !picked && searched && !searching && skuHits.length === 0 && skuQuery.trim().length > 0;
  const canAdd = !!picked || isNewSku;

  async function runSearch() {
    const _id = ++searchSeq.current;
    const q = skuQuery.trim();
    if (q.length < 2) { setSkuHits([]); setSearched(false); return; }
    setSearching(true);
    let hits: SkuHit[] = [];
    try { hits = await searchSkus(q); } catch { hits = []; }
    if (searchSeq.current !== _id) return; // a newer search superseded this one
    setSkuHits(hits); setSearching(false); setSearched(true);
  }

  // live search — debounce keystrokes; clear below the 2-char floor (no stale results / spinner)
  useEffect(() => {
    const q = skuQuery.trim();
    if (q.length < 2) { setSkuHits([]); setSearched(false); setSearching(false); return; }
    const t = setTimeout(() => { runSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skuQuery]);

  // PR260 — persist the add-overlay draft as fields change (gated during restore; cleared when empty)
  useEffect(() => {
    if (!adding || hydratingRef.current) return;
    const hasContent = !!picked || skuQuery.trim() !== '' || link.trim() !== '' || note.trim() !== '' || addUrgency !== null || qty !== 1;
    if (hasContent) saveDraft<ToBuyDraft>(TOBUY_DRAFT_KEY, { skuQuery, picked, qty, link, note, addUrgency });
    else clearDraft(TOBUY_DRAFT_KEY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding, picked, skuQuery, qty, link, note, addUrgency]);

  async function pick(hit: SkuHit) {
    setPicked({ item_code: hit.item_code, name: hit.name });
    setSkuHits([]); setSearched(false);
    // seed the figures from the hit (no flash), then refine in the background
    setPickedStock({ item_code: hit.item_code, available: hit.available, on_the_way: hit.on_the_way, with_forwarder: hit.with_forwarder });
    try { setPickedStock(await getSkuStock(hit.item_code)); } catch { /* figures are best-effort */ }
  }

  async function submitPlanned() {
    const code = picked ? picked.item_code : skuQuery.trim();
    if (!code) { setError('Search for a SKU, or type a new SKU code.'); return; }
    if (!Number.isFinite(qty) || qty < 0) { setError('Qty must be a number ≥ 0.'); return; }
    setBusy(true); setError(null);
    try {
      // PR231 — a picked SKU FKs via item_code; a brand-new/unknown code is stored as a PLACEHOLDER
      // (item_code_raw, no catalogue row) and matched to a real SKU later at Inbound receive. No draft
      // SKU is created here — new SKUs enter the catalogue only when the goods actually arrive.
      await createPlannedItem({
        item_code: picked ? code : null,
        item_code_raw: picked ? null : code,
        qty,
        product_link: link.trim() || null,
        item_note: note.trim() || null,
        urgency: addUrgency,
      });
      closeAdd(); // PR260 — item saved; drop its draft
      await refresh();
      setTab('manual');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add.');
    } finally {
      setBusy(false);
    }
  }

  // ── manual qty ± stepper: optimistic local update + a guarded server write ──
  // remove the acted row from its list locally (optimistic) — avoids a full 3-list refetch on the hot path.
  function removeRow(s: { kind: SubTab; id: number | string }) {
    if (s.kind === 'manual') setPlanned((prev) => prev.filter((p) => p.po_id !== Number(s.id)));
    else setPreorders((prev) => prev.filter((p) => p.line_id !== String(s.id)));
  }

  // ── Done → To Forwarder (a Processing PO). Manual advances its own PO; a preorder spawns one. ──
  // PR219: the row is removed locally by the caller BEFORE this runs, so we only do the single write
  // here (no heavy 3-list refetch) — the next Done is clickable as soon as that one write returns. On
  // failure we resync so the row reappears.
  async function done(t: BuyTarget, supplierId: number | null) {
    setBusy(true); setError(null);
    try {
      // A manual item is a real PO → advance to Processing (To forwarder); its Source was already saved
      // on pick (setPOSource). A from-sales preorder isn't a PO yet, so it spawns one and carries its
      // Source (PR283). PR304 — if it was flagged out of stock, drop the stale 'Sold out' PO too.
      if (t.kind === 'manual' && t.po_id != null) await setPOStatus(t.po_id, 'Processing');
      else if (t.kind === 'sales') {
        if (t.oos_po_id != null) { try { await deletePO(t.oos_po_id); } catch { /* best-effort */ } }
        await buyPreorder({ item_code: t.item_code, qty: t.qty, customer_id: t.customer_id, supplier_id: supplierId });
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); await refresh(); }
    finally { setBusy(false); }
  }

  // PR283 — pick the Source. A manual PO auto-saves the pick; a from-sales preorder holds it locally
  // (no PO yet) and carries it into buyPreorder at Done.
  async function changeSource(v: string) {
    setBuySource(v);
    const id = v ? Number(v) : null;
    if (detail?.po_id != null) {
      const { error: err } = await setPOSource(detail.po_id, id);
      if (err) { setError(err); return; }
      setPlanned((prev) => prev.map((p) => (p.po_id === detail.po_id ? { ...p, supplier_id: id } : p)));
    }
  }

  // PR304 — toggle out-of-stock inline (checkbox in the detail). Manual: flip the PO's 'Sold out' status.
  // From Sales (no PO yet): checking creates a 'Sold out' PO for the SKU + customer; unchecking deletes it.
  // The item stays in its list either way; the pill reflects the flag.
  async function toggleOOS(checked: boolean) {
    if (!detail) return;
    setBusy(true); setError(null);
    try {
      if (detail.kind === 'manual' && detail.po_id != null) {
        await setSoldOut(detail.po_id, checked, null);
        setPlanned((prev) => prev.map((p) => (p.po_id === detail.po_id ? { ...p, out_of_stock: checked } : p)));
      } else if (detail.kind === 'sales') {
        const lineId = String(sel?.id);
        if (checked) {
          const { po_id } = await markSkuSoldOut({ item_code: detail.target.item_code, customer_id: detail.target.customer_id, qty: detail.target.qty, sales_id: detail.target.sales_id });
          setPreorders((prev) => prev.map((p) => (p.line_id === lineId ? { ...p, out_of_stock: true, oos_po_id: po_id } : p)));
        } else if (detail.oos_po_id != null) {
          await deletePO(detail.oos_po_id);
          setPreorders((prev) => prev.map((p) => (p.line_id === lineId ? { ...p, out_of_stock: false, oos_po_id: null } : p)));
        }
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); await refresh(); }
    finally { setBusy(false); }
  }

  // delete a real PO (manual buy-list item). From-Sales rows aren't POs → no delete.
  // Gated behind the "Cancel this item?" confirm overlay (confirmDelId).
  async function delItem(po_id: number) {
    setBusy(true); setError(null);
    // optimistic remove (no full refetch); resync only if the delete fails.
    setPlanned((prev) => prev.filter((p) => p.po_id !== po_id));
    setConfirmDelId(null);
    try { await deletePO(po_id); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); await refresh(); }
    finally { setBusy(false); }
  }

  // PR168 — normalize the selected row (whatever list it's from) into one shape the action overlay renders
  // from: header context, stock figures, whether qty is editable / the item is deletable, and the
  // BuyTarget for the Buy/Done write-backs. Returns null once the item leaves its list (acted on).
  const detail = useMemo(() => {
    if (!sel) return null;
    if (sel.kind === 'manual') {
      const p = planned.find((x) => x.po_id === sel.id);
      if (!p) return null;
      return { kind: 'manual' as const, po_id: p.po_id, item_code: p.item_code, code: p.item_code ?? p.item_code_raw ?? '', name: p.name, qty: p.qty, urgency: p.urgency, supplier_id: p.supplier_id,
        wf: p.with_forwarder, otw: p.on_the_way, avail: p.available, context: `PO #${p.po_id}`, note: p.item_note,
        qtyEditable: true, canDelete: true, out_of_stock: p.out_of_stock, oos_po_id: null as number | null,
        target: { kind: 'manual' as const, item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: p.po_id, customer_id: null, sales_id: null, product_link: p.product_link, out_of_stock: p.out_of_stock, oos_po_id: null } };
    }
    const p = preorders.find((x) => x.line_id === sel.id);
    if (!p) return null;
    return { kind: 'sales' as const, po_id: null as number | null, item_code: p.item_code, code: p.item_code ?? '', name: p.name, qty: p.qty, urgency: p.urgency, supplier_id: null as number | null,
      wf: 0, otw: 0, avail: p.available, context: `${p.customer_name || 'no customer'} · ${fmtDate(p.order_date)}`, note: p.line_note as string | null,
      qtyEditable: false, canDelete: false, out_of_stock: p.out_of_stock, oos_po_id: p.oos_po_id,
      target: { kind: 'sales' as const, item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: null, customer_id: p.customer_id, sales_id: p.sales_id, product_link: p.product_link, out_of_stock: p.out_of_stock, oos_po_id: p.oos_po_id } };
  }, [sel, planned, preorders]);

  // PR221 — load the catalogue "where to buy" links when the detail overlay opens (keyed on the SKU code,
  // so the fetch runs once per opened item and not on every qty tick).
  const detailCode = detail?.item_code ?? null;
  useEffect(() => {
    if (!detailCode) { setBuySources([]); setBuyLoading(false); return; }
    let alive = true;
    setBuySources([]); setBuyLoading(true);
    getSkuSources(detailCode)
      .then((s) => { if (alive) setBuySources(s); })
      .catch(() => { if (alive) setBuySources([]); })
      .finally(() => { if (alive) setBuyLoading(false); });
    return () => { alive = false; };
  }, [detailCode]);

  // PR283 — seed the Source picker when a new item opens (a manual/oos PO may already carry one).
  useEffect(() => {
    setBuySource(detail?.supplier_id != null ? String(detail.supplier_id) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // a new/unknown manual SKU has no catalogue name (and no image / nothing to edit) — drive the header off this.
  const detailHasName = detail ? isRealName(detail.name, detail.item_code) : false;

  // PR240 — inline edit (all tabs; PR254). Seeds the draft from the current row; saveEdit routes the
  // write by kind (Manual/OOS → the PO; From Sales → its order priority + line note).
  function openEdit() {
    if (!detail) return;
    setESku(detail.code); setEQty(detail.qty); setEPrio(detail.urgency); setENote(detail.note ?? '');
    setEErr(null); setEditing(true);
  }
  function cancelEdit() { setEditing(false); setEErr(null); }
  async function saveEdit() {
    if (!detail) return;
    // From Sales is a preorder (no PO yet): only its order's priority + the line's note are editable.
    if (detail.kind === 'sales') {
      if (!sel) return;
      setEBusy(true); setEErr(null);
      const { error: err } = await updatePreorderLine({ line_id: String(sel.id), sales_id: detail.target.sales_id, urgency: ePrio, line_note: eNote.trim() || null });
      if (err) { setEErr(err); setEBusy(false); return; }
      await refresh();
      setEBusy(false); setEditing(false);
      return;
    }
    // Manual + Out-of-Stock are real POs → full edit (OOS writes the note to sold_out_note).
    if (detail.po_id == null) return;
    const sku = eSku.trim();
    if (!sku) { setEErr('A SKU code is required.'); return; }
    setEBusy(true); setEErr(null);
    const { error: err } = await updatePlannedItem({ po_id: detail.po_id, sku, qty: eQty, urgency: ePrio, item_note: eNote.trim() || null, soldOut: detail.out_of_stock });
    if (err) { setEErr(err); setEBusy(false); return; }
    await refresh();
    setEBusy(false); setEditing(false);
  }
  // leaving the overlay (or switching rows) drops edit mode.
  useEffect(() => { setEditing(false); }, [sel]);


  // sub-tab counts
  const counts = { manual: planned.length, sales: preorders.length };
  const TABS: { key: SubTab; label: string }[] = [
    { key: 'manual', label: 'Manual' },
    { key: 'sales', label: 'From Sales' },
  ];

  // PR307 — Esc / backdrop / × close. The item detail guards while in edit mode; the add-item overlay
  // guards when it has typed content; the delete confirm just closes.
  // PR315 — only guard when the edit draft actually diverges from what was seeded (opening Edit PO then
  // pressing Esc without touching anything shouldn't warn about unsaved changes).
  const editDirty = editing && detail != null && (
    eSku !== detail.code || eQty !== detail.qty || ePrio !== detail.urgency || eNote !== (detail.note ?? '')
  );
  const addDirty = !!(skuQuery.trim() || picked || link.trim() || note.trim() || addUrgency || qty !== 1);
  const detailClose = useOverlayClose({ open: !!sel, onClose: () => setSel(null), dirty: editDirty });
  const addClose = useOverlayClose({ open: adding, onClose: closeAdd, dirty: addDirty });
  useEscToClose(confirmDelId != null, () => setConfirmDelId(null));

  return (
    <div className="purch-tobuy">
      {error && <div className="validation err">{error}</div>}

      {/* three smaller tabs (Sales-Pending style) with live counts */}
      <div className="fq-filters" role="tablist" aria-label="Buy">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`fq-filter ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}<span className="fq-filter-count">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      {/* Manual — PR150 card: l1 SKU + date, l2 name + stock pills, l3 qty/Buy/Done/trash. The old
          "Manual buy-list" header row is gone; "+ add item" is a full-width button at the top. */}
      {tab === 'manual' && (
        <section className="fd-section">
          <button className="btn-brown btn-ico po-add-full" onClick={openAdd}><PackageIcon />Add item</button>
          {planned.length === 0 && <div className="hint">Nothing planned. Use “Add item” to start a buy-list.</div>}
          <ul className="po-cards">
            {planned.map((p) => {
              const code = p.item_code ?? p.item_code_raw ?? '—';
              return (
              <li key={p.po_id}>
                <button className={`po-card po-card-btn po-card-mini${urgClass(p.urgency)}`} onClick={() => setSel({ kind: 'manual', id: p.po_id })}>
                  <SkuImage status={imgMap[p.item_code ?? '']?.status} displayUrl={imgMap[p.item_code ?? '']?.displayUrl} name={p.name} size={SKU_IMG.sm} />
                  <div className="po-card-main">
                    <span className="ff-code">{code}</span>
                    {isRealName(p.name, code) && <span className="ff-name po-card-name">{p.name}</span>}
                  </div>
                  <div className="po-card-side">
                    {/* PR250 — qty sits on the SKU row (top-right), like Inbound's unmatched rows;
                        date + stock pills drop to the row below. PR304 — OOS pill left of qty. */}
                    <span className="po-card-qtyline">
                      {p.out_of_stock && <span className="oos-pill">Out of stock</span>}
                      <span className="po-card-qty po-card-qty-lg">×{p.qty}</span>
                    </span>
                    <div className="po-card-meta">
                      <span className="po-card-date">{fmtDate(p.input_date)}</span>
                      <StockPills wf={p.with_forwarder} otw={p.on_the_way} avail={p.available} combined />
                    </div>
                  </div>
                  <span className="po-chev" aria-hidden>›</span>
                </button>
              </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* From Sales */}
      {tab === 'sales' && (
        <section className="fd-section">
          {preorders.length === 0 && <div className="hint">No preorders — every ordered SKU is in stock.</div>}
          <ul className="po-cards">
            {/* PR150 card: l1 SKU + date, l2 name + customer id (no order id), l3 qty/Buy/Done. */}
            {preorders.map((p) => {
              const code = p.item_code || '—';
              return (
              <li key={p.line_id}>
                <button className={`po-card po-card-btn po-card-mini${urgClass(p.urgency)}`} onClick={() => setSel({ kind: 'sales', id: p.line_id })}>
                  <SkuImage status={imgMap[p.item_code ?? '']?.status} displayUrl={imgMap[p.item_code ?? '']?.displayUrl} name={p.name} size={SKU_IMG.sm} />
                  <div className="po-card-main">
                    <span className="ff-code">{code}</span>
                    {isRealName(p.name, code) && <span className="ff-name po-card-name">{p.name}</span>}
                  </div>
                  <div className="po-card-side">
                    <span className="po-card-qtyline">
                      {p.out_of_stock && <span className="oos-pill">Out of stock</span>}
                      <span className="po-card-qty po-card-qty-lg">×{p.qty}</span>
                    </span>
                    <div className="po-card-meta">
                      <span className="po-card-date">{fmtDate(p.order_date)}</span>
                      <span className="po-card-cust">{p.customer_name || 'no customer'}</span>
                    </div>
                  </div>
                  <span className="po-chev" aria-hidden>›</span>
                </button>
              </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* PR221 — tap-to-act detail overlay. Header: SKU code + Edit (deep-links to the Catalog editor) with
          the item name right below. Body: image on the left; to its right (within the image height) sit the
          priority, qty-to-buy stepper and the three stock statuses. The catalogue "where to buy" links are
          listed inline below (no separate Buy step). Actions: Out of stock / Done / Delete. */}
      {detail && (
        <div className="sc-modal-backdrop" onClick={detailClose.requestClose}>
          {detailClose.confirm}
          <div className="sc-modal tobuy-detail" role="dialog" aria-modal="true" aria-label="Item actions" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head td-head-block">
              <div className="td-head-titles">
                <span className="sc-modal-title">{detail.code || '—'}</span>
                {detailHasName && <div className="ff-name td-name">{detail.name}</div>}
              </div>
              <button className="sc-modal-x" onClick={() => { if (!eBusy) detailClose.requestClose(); }} aria-label="Close">×</button>
            </div>

            {editing ? (
              /* ── edit mode — SKU / qty / priority / note. Manual + OOS write the PO; From Sales edits
                   only its order priority + line note (SKU + qty read-only, mirroring the sale). ── */
              <>
                <div className="sc-modal-body">
                  {eErr && <div className="validation err" style={{ marginBottom: 10 }}>{eErr}</div>}
                  <div className="le-field">
                    <label>SKU code<span className="req" aria-hidden="true">*</span></label>
                    <input type="text" className={detail.item_code != null ? 'le-locked' : undefined} value={eSku} onChange={(e) => setESku(e.target.value)} placeholder="type the SKU code" disabled={eBusy || detail.item_code != null} autoComplete="off" data-1p-ignore="true" data-lpignore="true" />
                  </div>
                  <div className="le-row">
                    <div className="le-field">
                      <label>Qty</label>
                      {detail.kind === 'sales' ? (
                        /* preorder qty mirrors the sale — read-only here (edit it on the order) */
                        <span className="qty-ro" aria-label="quantity">×{eQty}</span>
                      ) : (
                        <span className="qty-step">
                          <button type="button" onClick={() => setEQty((q) => Math.max(0, q - 1))} disabled={eBusy || eQty <= 0} aria-label="decrease">−</button>
                          <input type="number" inputMode="numeric" min={0} value={eQty} onChange={(e) => setEQty(Math.max(0, parseInt(e.target.value, 10) || 0))} disabled={eBusy} />
                          <button type="button" onClick={() => setEQty((q) => q + 1)} disabled={eBusy} aria-label="increase">+</button>
                        </span>
                      )}
                    </div>
                    <div className="le-field grow">
                      <label>Priority</label>
                      <div className="urg-toggle" role="group" aria-label="Priority">
                        {URGENCY_OPTS.map((u) => (
                          <button key={u.key} type="button" className={`urg-btn urg-${u.key} ${ePrio === u.key ? 'active' : ''}`} aria-pressed={ePrio === u.key} onClick={() => setEPrio(ePrio === u.key ? null : u.key)} disabled={eBusy}>{u.label}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="le-field le-note">
                    <label>Notes</label>
                    <input type="text" value={eNote} onChange={(e) => setENote(e.target.value)} placeholder="e.g. buy one set" disabled={eBusy} autoComplete="off" />
                  </div>
                </div>
                {/* PR300 — modal-footer standard: Cancel on the LEFT, primary (Save changes) on the RIGHT. */}
                <div className="sc-modal-foot">
                  <button className="btn-secondary" onClick={cancelEdit} disabled={eBusy}>Cancel</button>
                  <button className="btn-primary" onClick={saveEdit} disabled={eBusy || !eSku.trim()}>{eBusy ? 'Saving…' : 'Save changes'}</button>
                </div>
              </>
            ) : (
              /* ── view mode — image, context (PO#/customer · priority · note), qty+pill, where-to-buy ── */
              <>
                <div className="sc-modal-body">
                  {error && <div className="validation err" style={{ marginBottom: 10 }}>{error}</div>}
                  {/* PR299/PR301 — summary item card: a top row (image · PO#/priority · qty/status) with
                      the qty on line 1 and status on line 2, then Notes on its own full-width third line
                      (kept separate so a longer note wraps cleanly — also better on mobile). */}
                  <div className="td-head-card">
                    <div className="td-head2">
                      <SkuImage status={imgMap[detail.item_code ?? '']?.status} displayUrl={imgMap[detail.item_code ?? '']?.displayUrl} name={detailHasName ? detail.name : detail.code} size={SKU_IMG.smd} />
                      <div className="td-info">
                        <div className="td-ctx">{detail.context}</div>
                        {detail.urgency ? (
                          <div className={`td-prio td-prio-${detail.urgency}`}><span className="td-prio-dot" />{detail.urgency[0].toUpperCase() + detail.urgency.slice(1)} priority</div>
                        ) : (
                          <div className="td-ctx td-prio-none">No priority set</div>
                        )}
                      </div>
                      <div className="td-controls">
                        {/* PR249 — qty is read-only here; edit it via Edit PO. PR299 — plain, no bubble.
                            PR304 — out-of-stock pill sits to the LEFT of the qty. */}
                        <span className="td-qtyline">
                          {detail.out_of_stock && <span className="oos-pill">Out of stock</span>}
                          <span className="td-qty" aria-label="quantity">×{detail.qty}</span>
                        </span>
                        <span className="td-stock"><StockPills wf={detail.wf} otw={detail.otw} avail={detail.avail} combined /></span>
                      </div>
                    </div>
                    <div className="td-card-note td-ctx">{detail.note || 'No notes'}</div>
                  </div>

                  <div className="fd-section-head td-links-head">Where to buy</div>
                  <div className="buy-links">
                    {detail.target.product_link && <BuyLink url={detail.target.product_link} primary />}
                    {buyLoading && <div className="hint">Loading catalogue sources…</div>}
                    {!buyLoading && buySources.map((url) => <BuyLink key={url} url={url} />)}
                    {!buyLoading && !detail.target.product_link && buySources.length === 0 && (
                      <div className="hint">No links on file for this SKU.</div>
                    )}
                  </div>

                  {/* PR283 — Source (mandatory): who we're buying from. Links above = buying directly;
                      a source captures the supplier/agent (or a Taobao-direct reminder). Required at Done.
                      PR304 — an "Out of stock" checkbox sits to the right; ticking it flags the item
                      (red pill) instead of moving it to a separate list. */}
                  <div className="td-source-row" style={{ marginTop: 12 }}>
                    <div className="po-field td-source-grow">
                      <label>Source<span className="req" aria-hidden="true">*</span></label>
                      <DropSearch
                        value={buySource || null}
                        onChange={(v) => changeSource(v)}
                        options={supplierOpts}
                        placeholder="— pick a source —"
                        disabled={busy}
                        ariaLabel="Source"
                      />
                    </div>
                    <label className="td-oos-check">
                      <input type="checkbox" checked={detail.out_of_stock} onChange={(e) => toggleOOS(e.target.checked)} disabled={busy} />
                      <span>Out of stock</span>
                    </label>
                  </div>
                </div>
                {/* Actions — the standard scrollable row: Edit PO · Done buying · Delete PO (last). */}
                <div className="sc-modal-foot td-actions">
                  {/* PR254 — Edit PO on every tab: Manual edits the real PO; From Sales edits only
                      its order priority + line note (SKU + qty mirror the sale and stay locked). */}
                  <button className="btn-secondary btn-ico" onClick={openEdit} disabled={busy}><PencilIcon />Edit PO</button>

                  <button className="btn-primary btn-ico" onClick={() => { const t = detail.target; const s = sel; const src = buySource ? Number(buySource) : null; setSel(null); if (s) removeRow(s); done(t, src); }} disabled={busy || !buySource} title={!buySource ? 'Pick a source first' : undefined}><BagIcon />Done buying</button>
                  {detail.canDelete && detail.po_id != null && (
                    <button className="btn-danger btn-ico td-del" onClick={() => { const id = detail.po_id!; setSel(null); setConfirmDelId(id); }} disabled={busy}><TrashIcon />Delete PO</button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* "+ add item" overlay (Manual only) — dimmed-backdrop modal */}
      {adding && (
        <div className="sc-modal-backdrop" onClick={addClose.requestClose}>
          {addClose.confirm}
          <div className="sc-modal addpo-modal" role="dialog" aria-modal="true" aria-label="Add item" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <div>
                <div className="sc-modal-title">Add item</div>
                <div className="sc-modal-sub">Manually add PO items</div>
              </div>
              <button className="sc-modal-x" onClick={addClose.requestClose} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              {error && <div className="validation err" style={{ marginBottom: 10 }}>{error}</div>}
              {addRestored && (
                <div className="validation ok rcv-restored" style={{ marginBottom: 10 }}>
                  <span>Restored your unsaved item.</span>
                  <button className="btn-link" onClick={() => { clearDraft(TOBUY_DRAFT_KEY); setAddRestored(false); setSkuQuery(''); setPicked(null); setPickedStock(null); setQty(1); setLink(''); setNote(''); setAddUrgency(null); }}>discard</button>
                </div>
              )}

              {/* search — code / name / piece count / brand */}
              <div className="scan-row">
                <SearchInput
                  value={skuQuery}
                  onChange={(v) => { setSkuQuery(v); setSearched(false); setSkuHits([]); if (picked) { setPicked(null); setPickedStock(null); } }}
                  placeholder="search SKU by code / name / piece count / brand"
                />
              </div>
              {/* PR302 — live "Searching…" indicator while a query is in flight */}
              {!picked && searching && (
                <div className="hint td-searching" style={{ marginTop: 8 }}>Searching…</div>
              )}
              {/* search results — PR158 rows: l1 = SKU code; l2 = name (left) + stock pills (right) */}
              {!picked && skuHits.length > 0 && (
                <ul className="result-list" style={{ marginTop: 6 }}>
                  {skuHits.map((h) => (
                    <li key={h.item_code}>
                      <button className="po-pick po-pick-btn" onClick={() => pick(h)}>
                        <SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={SKU_IMG.sm} />
                        <div className="po-pick-main">
                          <div className="po-pick-l1"><span className="ff-code">{h.item_code}</span></div>
                          <div className="po-pick-mid">
                            <span className="ff-name">{h.name}{h.brand ? ` · ${h.brand}` : ''}</span>
                            <StockPills wf={h.with_forwarder} otw={h.on_the_way} avail={h.available} />
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* chosen SKU — same row style; the trash delete stays foremost right (PR158) */}
              {picked && (
                <div className="po-pick" style={{ marginTop: 8 }}>
                  <SkuImage status={imgMap[picked.item_code]?.status} displayUrl={imgMap[picked.item_code]?.displayUrl} name={picked.name} size={SKU_IMG.sm} />
                  <div className="po-pick-main">
                    <div className="po-pick-l1"><span className="ff-code">{picked.item_code}</span></div>
                    <div className="po-pick-mid">
                      <span className="ff-name">{picked.name}</span>
                      {pickedStock
                        ? <StockPills wf={pickedStock.with_forwarder} otw={pickedStock.on_the_way} avail={pickedStock.available} />
                        : <span className="hint">loading…</span>}
                    </div>
                  </div>
                  <TrashButton onClick={() => { setPicked(null); setPickedStock(null); }} ariaLabel="Remove" />
                </div>
              )}
              {isNewSku && (
                <div className="validation warn" style={{ margin: '8px 0' }}>SKU code does not exist in the catalog</div>
              )}

              {/* item fields — always shown, qty defaults to 1. PR158: Qty + Product link share a line
                  (link fills the space to the right) to keep the overlay short. */}
              <div className="po-form" style={{ marginTop: 18 }}>
                <div className="po-field-row">
                  <div className="po-field">
                    <label>Qty</label>
                    <span className="qty-step">
                      <button type="button" onClick={() => setQty((q) => Math.max(0, q - 1))} disabled={qty <= 0} aria-label="decrease">−</button>
                      <input type="number" inputMode="numeric" min={0} value={qty} onChange={(e) => setQty(Math.max(0, parseInt(e.target.value, 10) || 0))} />
                      <button type="button" onClick={() => setQty((q) => q + 1)} aria-label="increase">+</button>
                    </span>
                  </div>
                  <div className="po-field grow">
                    <label>Item link</label>
                    <input type="text" placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} />
                  </div>
                </div>

                <div className="po-field">
                  <label>Short note</label>
                  <input type="text" placeholder="e.g. confirm colour" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>

                <div className="po-field">
                  <label>Urgency</label>
                  <div className="urg-toggle" role="group" aria-label="Urgency">
                    {URGENCY_OPTS.map((u) => (
                      <button
                        key={u.key}
                        type="button"
                        className={`urg-btn urg-${u.key} ${addUrgency === u.key ? 'active' : ''}`}
                        aria-pressed={addUrgency === u.key}
                        onClick={() => setAddUrgency(addUrgency === u.key ? null : u.key)}
                      >
                        {u.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="po-commit po-commit-left">
                  <button className="btn-primary" onClick={submitPlanned} disabled={busy || !canAdd}>{busy ? 'Adding…' : '+ Add item'}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* delete confirm — small centered overlay shared by Manual + Out-of-Stock cards */}
      {confirmDelId != null && (
        <div className="sc-modal-backdrop" onClick={() => setConfirmDelId(null)}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Cancel item" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-body">
              <div className="confirm-q">Cancel this item?</div>
              <div className="confirm-actions">
                <button className="btn-secondary" onClick={() => setConfirmDelId(null)} disabled={busy}>No</button>
                <button className="btn-primary danger" onClick={() => delItem(confirmDelId)} disabled={busy}>{busy ? 'Cancelling…' : 'Yes, cancel'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

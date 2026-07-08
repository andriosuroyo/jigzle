'use client';

// Purchasing → To buy tab (PR73). Three sub-tabs (styled like the Sales Pending readiness filters),
// each a live count:
//  • Manual    — manual buy-list (PO status 'Planned'). Has "+ add item". Qty is editable (± steppers).
//  • From Sales — derived from Sales (read-only): unfulfilled lines for ≤0-available SKUs. No add button;
//                 qty mirrors the order line (uneditable).
//  • Out of Stock — PO status 'Sold out'. Qty uneditable; Restore → back to Manual.
//
// Every card shares one layout (larger image): code + name, then context and stock pills. Tapping a card
// opens a detail overlay (PR221): SKU + Edit (deep-link to the Catalog editor) with the name below; the
// qty-to-buy stepper and stock statuses beside the image; the catalogue "where to buy" links listed inline;
// and Out-of-stock / Done / Delete actions. "Done" sends the item to To Forwarder (a Processing PO).

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
  getSoldOutItems,
  markSkuSoldOut,
  searchSkus,
  setPlannedQty,
  setPOStatus,
  setSoldOut,
  updatePlannedItem,
} from '@/app/purchasing/actions';
import type { PlannedItemRow, PreorderRow, SoldOutRow, SkuStockInfo, Urgency } from '@/app/purchasing/types';
import type { SkuHit } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import StockPills from '@/components/StockPills';
import TrashButton from '@/components/TrashButton';
import SearchInput from '@/components/SearchInput';
import { PackageIcon } from '@/components/AddIcons';
import { isRealName } from '@/components/skuName';

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');

type SubTab = 'manual' | 'sales' | 'oos';

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
const BanIcon = () => (<svg {..._ic}><circle cx="12" cy="12" r="9" /><line x1="5.6" y1="5.6" x2="18.4" y2="18.4" /></svg>);
const BagIcon = () => (<svg {..._ic}><path d="M6 2 3 6v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 0 1-8 0" /></svg>);
const TrashIcon = () => (<svg {..._ic}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>);


// the active "Buy" overlay target — enough to load + render its links and run the right write-backs.
type BuyTarget = {
  kind: SubTab;
  item_code: string;
  name: string;
  qty: number;
  po_id: number | null;        // present for manual / oos (a real PO)
  customer_id: number | null;  // present for a from-sales preorder
  sales_id: string | null;     // the originating sale (from-sales preorder), kept on a sold-out mark
  product_link: string | null; // the card's own link (manual product_link / preorder item_link)
};

export default function ToBuyBoard({
  planned: initialPlanned,
  preorders: initialPreorders,
  soldOut: initialSoldOut,
}: {
  planned: PlannedItemRow[];
  preorders: PreorderRow[];
  soldOut: SoldOutRow[];
}) {
  // PR223 — the sub-tab is mirrored to ?buy= (distinct from Purchasing's ?tab=) so a hard Refresh stays put.
  const [tab, setTab] = useUrlTab<SubTab>('buy', 'manual', ['manual', 'sales', 'oos']);
  const [planned, setPlanned] = useState<PlannedItemRow[]>(initialPlanned);
  const [preorders, setPreorders] = useState<PreorderRow[]>(initialPreorders);
  const [soldOut, setSoldOutList] = useState<SoldOutRow[]>(initialSoldOut);
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

  // PR221 — "where to buy" links now live inline in the detail overlay (the separate Buy step is gone).
  // Loaded lazily when the overlay opens, keyed on the SKU code.
  const [buySources, setBuySources] = useState<string[]>([]);
  const [buyLoading, setBuyLoading] = useState(false);

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
    soldOut.forEach((p) => { if (p.item_code) set.add(p.item_code); });
    preorders.forEach((p) => { if (p.item_code) set.add(p.item_code); });
    skuHits.forEach((h) => set.add(h.item_code));
    return [...set];
  }, [planned, soldOut, preorders, skuHits]);
  const imgMap = useSkuImages(imgCodes);

  async function refresh() {
    try { setPlanned(await getPlannedItems()); } catch { /* keep */ }
    try { setSoldOutList(await getSoldOutItems()); } catch { /* keep */ }
    try { setPreorders(await getPreorders()); } catch { /* keep */ }
  }

  // ── add-item overlay ──
  function openAdd() {
    setAdding(true);
    setSkuQuery(''); setSkuHits([]); setSearched(false); setPicked(null); setPickedStock(null);
    setQty(1); setLink(''); setNote(''); setAddUrgency(null);
    setError(null);
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
      setAdding(false);
      await refresh();
      setTab('manual');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add.');
    } finally {
      setBusy(false);
    }
  }

  // ── manual qty ± stepper: optimistic local update + a guarded server write ──
  async function changeQty(po_id: number, next: number) {
    const q = Math.max(0, next);
    // po_id is unique to one list; updating both keeps the manual + manual-origin OOS steppers live
    setPlanned((prev) => prev.map((p) => (p.po_id === po_id ? { ...p, qty: q } : p)));
    setSoldOutList((prev) => prev.map((p) => (p.po_id === po_id ? { ...p, qty: q } : p)));
    try { await setPlannedQty(po_id, q); } catch (e) { setError(e instanceof Error ? e.message : 'Failed to set qty.'); }
  }

  // remove the acted row from its list locally (optimistic) — avoids a full 3-list refetch on the hot path.
  function removeRow(s: { kind: SubTab; id: number | string }) {
    if (s.kind === 'manual') setPlanned((prev) => prev.filter((p) => p.po_id !== Number(s.id)));
    else if (s.kind === 'sales') setPreorders((prev) => prev.filter((p) => p.line_id !== String(s.id)));
    else setSoldOutList((prev) => prev.filter((p) => p.po_id !== Number(s.id)));
  }

  // ── Done → To Forwarder (a Processing PO). Manual advances its own PO; a preorder spawns one. ──
  // PR219: the row is removed locally by the caller BEFORE this runs, so we only do the single write
  // here (no heavy 3-list refetch) — the next Done is clickable as soon as that one write returns. On
  // failure we resync so the row reappears.
  async function done(t: BuyTarget) {
    setBusy(true); setError(null);
    try {
      // manual + out-of-stock are both real POs → advance to Processing (To forwarder); a from-sales
      // preorder isn't a PO yet, so it spawns one.
      if ((t.kind === 'manual' || t.kind === 'oos') && t.po_id != null) await setPOStatus(t.po_id, 'Processing');
      else if (t.kind === 'sales') await buyPreorder({ item_code: t.item_code, qty: t.qty, customer_id: t.customer_id });
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); await refresh(); }
    finally { setBusy(false); }
  }

  // mark a SKU out of stock (all links sold out) — the row is removed locally first (optimistic), like Done.
  async function markOutOfStock(t: BuyTarget, s: { kind: SubTab; id: number | string } | null) {
    setSel(null);
    if (s) removeRow(s);
    setBusy(true); setError(null);
    try {
      if (t.po_id != null) await setSoldOut(t.po_id, true, null);
      else await markSkuSoldOut({ item_code: t.item_code, customer_id: t.customer_id, qty: t.qty, sales_id: t.sales_id });
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); await refresh(); }
    finally { setBusy(false); }
  }

  // delete a real PO (manual buy-list item, or an out-of-stock row). From-Sales rows aren't POs → no delete.
  // Gated behind the "Cancel this item?" confirm overlay (confirmDelId).
  async function delItem(po_id: number) {
    setBusy(true); setError(null);
    // optimistic remove (no full refetch); resync only if the delete fails.
    setPlanned((prev) => prev.filter((p) => p.po_id !== po_id));
    setSoldOutList((prev) => prev.filter((p) => p.po_id !== po_id));
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
      return { kind: 'manual' as const, po_id: p.po_id, item_code: p.item_code, code: p.item_code ?? p.item_code_raw ?? '', name: p.name, qty: p.qty, urgency: p.urgency,
        wf: p.with_forwarder, otw: p.on_the_way, avail: p.available, context: `PO #${p.po_id}`, note: p.item_note,
        qtyEditable: true, canDelete: true,
        target: { kind: 'manual' as const, item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: p.po_id, customer_id: null, sales_id: null, product_link: p.product_link } };
    }
    if (sel.kind === 'sales') {
      const p = preorders.find((x) => x.line_id === sel.id);
      if (!p) return null;
      return { kind: 'sales' as const, po_id: null as number | null, item_code: p.item_code, code: p.item_code ?? '', name: p.name, qty: p.qty, urgency: p.urgency,
        wf: 0, otw: 0, avail: p.available, context: `${p.customer_name || 'no customer'} · ${fmtDate(p.order_date)}`, note: null as string | null,
        qtyEditable: false, canDelete: false,
        target: { kind: 'sales' as const, item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: null, customer_id: p.customer_id, sales_id: p.sales_id, product_link: p.product_link } };
    }
    const p = soldOut.find((x) => x.po_id === sel.id);
    if (!p) return null;
    return { kind: 'oos' as const, po_id: p.po_id, item_code: p.item_code, code: p.item_code ?? p.item_code_raw ?? '', name: p.name, qty: p.qty, urgency: p.urgency,
      wf: p.with_forwarder, otw: p.on_the_way, avail: p.available,
      context: p.origin === 'sales' ? `${p.customer_name || 'no customer'} · ${fmtDate(p.order_date)}` : `PO #${p.po_id}`, note: p.sold_out_note,
      qtyEditable: p.origin === 'manual', canDelete: true,
      target: { kind: 'oos' as const, item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: p.po_id, customer_id: null, sales_id: p.sales_id, product_link: p.product_link } };
  }, [sel, planned, preorders, soldOut]);

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

  // a new/unknown manual SKU has no catalogue name (and no image / nothing to edit) — drive the header off this.
  const detailHasName = detail ? isRealName(detail.name, detail.item_code) : false;

  // PR240 — inline edit (Manual only). Seeds the draft from the current row; saves to the PO only.
  function openEdit() {
    if (!detail) return;
    setESku(detail.code); setEQty(detail.qty); setEPrio(detail.urgency); setENote(detail.note ?? '');
    setEErr(null); setEditing(true);
  }
  function cancelEdit() { setEditing(false); setEErr(null); }
  async function saveEdit() {
    if (!detail || detail.po_id == null) return;
    const sku = eSku.trim();
    if (!sku) { setEErr('A SKU code is required.'); return; }
    setEBusy(true); setEErr(null);
    const { error: err } = await updatePlannedItem({ po_id: detail.po_id, sku, qty: eQty, urgency: ePrio, item_note: eNote.trim() || null });
    if (err) { setEErr(err); setEBusy(false); return; }
    await refresh();
    setEBusy(false); setEditing(false);
  }
  // leaving the overlay (or switching rows) drops edit mode.
  useEffect(() => { setEditing(false); }, [sel]);

  // overlay qty stepper: optimistic local update in the right list (manual → planned, oos → soldOut)
  function setDetailQty(q: number) {
    if (!detail || detail.po_id == null) return;
    const v = Math.max(0, q);
    if (detail.kind === 'manual') setPlanned((prev) => prev.map((x) => (x.po_id === detail.po_id ? { ...x, qty: v } : x)));
    else setSoldOutList((prev) => prev.map((x) => (x.po_id === detail.po_id ? { ...x, qty: v } : x)));
  }

  // sub-tab counts
  const counts = { manual: planned.length, sales: preorders.length, oos: soldOut.length };
  const TABS: { key: SubTab; label: string }[] = [
    { key: 'manual', label: 'Manual' },
    { key: 'sales', label: 'From Sales' },
    { key: 'oos', label: 'Out of Stock' },
  ];

  return (
    <div className="purch-tobuy">
      {error && <div className="validation err">{error}</div>}

      {/* three smaller tabs (Sales-Pending style) with live counts */}
      <div className="fq-filters" role="tablist" aria-label="To buy">
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
          <button className="btn-brown btn-ico po-add-full" onClick={openAdd}><PackageIcon />add item</button>
          {planned.length === 0 && <div className="hint">Nothing planned. Use “+ add item” to start a buy-list.</div>}
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
                    <span className="po-card-date">{fmtDate(p.input_date)}</span>
                    <div className="po-card-meta">
                      <StockPills wf={p.with_forwarder} otw={p.on_the_way} avail={p.available} combined />
                      <span className="po-card-qty">×{p.qty}</span>
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
                    <span className="po-card-date">{fmtDate(p.order_date)}</span>
                    <div className="po-card-meta">
                      <span className="po-card-cust">{p.customer_name || 'no customer'}</span>
                      <span className="po-card-qty">×{p.qty}</span>
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

      {/* Out of Stock — each card mirrors its origin (manual figures / sales order context) */}
      {tab === 'oos' && (
        <section className="fd-section">
          {soldOut.length === 0 && <div className="hint">Nothing marked out of stock.</div>}
          <ul className="po-cards">
            {soldOut.map((p) => {
              const code = p.item_code ?? p.item_code_raw ?? '—';
              return (
              <li key={p.po_id}>
                <button className={`po-card po-card-btn po-card-mini${urgClass(p.urgency)}`} onClick={() => setSel({ kind: 'oos', id: p.po_id })}>
                  <SkuImage status={imgMap[p.item_code ?? '']?.status} displayUrl={imgMap[p.item_code ?? '']?.displayUrl} name={p.name} size={SKU_IMG.sm} />
                  <div className="po-card-main">
                    <span className="ff-code">{code}</span>
                    {isRealName(p.name, code) && <span className="ff-name po-card-name">{p.name}</span>}
                  </div>
                  <div className="po-card-side">
                    <span className="po-card-date">{fmtDate(p.origin === 'sales' ? p.order_date : p.input_date)}</span>
                    <div className="po-card-meta">
                      {p.origin === 'sales'
                        ? <span className="po-card-cust">{p.customer_name || 'no customer'}</span>
                        : <StockPills wf={p.with_forwarder} otw={p.on_the_way} avail={p.available} combined />}
                      <span className="po-card-qty">×{p.qty}</span>
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
        <div className="sc-modal-backdrop" onClick={() => setSel(null)}>
          <div className="sc-modal tobuy-detail" role="dialog" aria-modal="true" aria-label="Item actions" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head td-head-block">
              <div className="td-head-titles">
                <span className="sc-modal-title">{detail.code || '—'}</span>
                {detailHasName && <div className="ff-name td-name">{detail.name}</div>}
              </div>
              {/* PR240 — Edit is an INLINE editor (Manual only): change SKU / qty / priority / note without
                  ever writing to the catalogue. From-Sales items are read-only (driven by the sale). */}
              {!editing && detail.kind === 'manual' && detail.po_id != null && (
                <button className="td-edit" onClick={openEdit} title="Edit item">Edit</button>
              )}
              <button className="sc-modal-x" onClick={() => { if (!eBusy) setSel(null); }} aria-label="Close">×</button>
            </div>

            {editing ? (
              /* ── edit mode (Manual) — SKU / qty / priority / note; writes to the PO only ── */
              <>
                <div className="sc-modal-body">
                  {eErr && <div className="validation err" style={{ marginBottom: 10 }}>{eErr}</div>}
                  <div className="le-field">
                    <label>SKU code</label>
                    <input type="text" value={eSku} onChange={(e) => setESku(e.target.value)} placeholder="type the SKU code" disabled={eBusy} autoComplete="off" data-1p-ignore="true" data-lpignore="true" />
                    <span className="hint" style={{ marginTop: 4 }}>A new/unknown code is kept as-is and matched to a real SKU at Inbound — no catalogue entry is created here.</span>
                  </div>
                  <div className="le-row">
                    <div className="le-field">
                      <label>Qty</label>
                      <span className="qty-step">
                        <button type="button" onClick={() => setEQty((q) => Math.max(0, q - 1))} disabled={eBusy || eQty <= 0} aria-label="decrease">−</button>
                        <input type="number" inputMode="numeric" min={0} value={eQty} onChange={(e) => setEQty(Math.max(0, parseInt(e.target.value, 10) || 0))} disabled={eBusy} />
                        <button type="button" onClick={() => setEQty((q) => q + 1)} disabled={eBusy} aria-label="increase">+</button>
                      </span>
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
                    <label>Note <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
                    <input type="text" value={eNote} onChange={(e) => setENote(e.target.value)} placeholder="e.g. confirm colour" disabled={eBusy} autoComplete="off" />
                  </div>
                </div>
                <div className="sc-modal-foot le-foot">
                  <button className="btn-primary" onClick={saveEdit} disabled={eBusy || !eSku.trim()}>{eBusy ? 'Saving…' : 'Save'}</button>
                  <button className="btn-secondary" onClick={cancelEdit} disabled={eBusy}>Cancel</button>
                </div>
              </>
            ) : (
              /* ── view mode — image, context (PO#/customer · priority · note), qty+pill, where-to-buy ── */
              <>
                <div className="sc-modal-body">
                  {error && <div className="validation err" style={{ marginBottom: 10 }}>{error}</div>}
                  <div className="td-head2">
                    <SkuImage status={imgMap[detail.item_code ?? '']?.status} displayUrl={imgMap[detail.item_code ?? '']?.displayUrl} name={detailHasName ? detail.name : detail.code} size={SKU_IMG.md} />
                    <div className="td-info">
                      <div className="td-ctx">{detail.context}</div>
                      {detail.urgency && (
                        <div className={`td-prio td-prio-${detail.urgency}`}><span className="td-prio-dot" />{detail.urgency[0].toUpperCase() + detail.urgency.slice(1)} priority</div>
                      )}
                      {detail.note && <div className="td-ctx td-note">{detail.note}</div>}
                    </div>
                    <div className="td-controls">
                      {detail.qtyEditable && detail.po_id != null ? (
                        <span className="qty-step">
                          <button type="button" onClick={() => changeQty(detail.po_id!, detail.qty - 1)} disabled={detail.qty <= 0} aria-label="decrease">−</button>
                          <input
                            type="number" inputMode="numeric" min={0} value={detail.qty}
                            onChange={(e) => setDetailQty(parseInt(e.target.value, 10) || 0)}
                            onBlur={(e) => changeQty(detail.po_id!, Math.max(0, parseInt(e.target.value, 10) || 0))}
                          />
                          <button type="button" onClick={() => changeQty(detail.po_id!, detail.qty + 1)} aria-label="increase">+</button>
                        </span>
                      ) : (
                        <span className="qty-ro" aria-label="quantity">×{detail.qty}</span>
                      )}
                      <span className="td-stock"><StockPills wf={detail.wf} otw={detail.otw} avail={detail.avail} combined /></span>
                    </div>
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
                </div>
                {/* Actions — the standard scrollable row: out of stock · done buying · delete PO (last). */}
                <div className="sc-modal-foot td-actions">
                  {detail.kind !== 'oos' && (
                    <button className="btn-secondary danger btn-ico" onClick={() => { const t = detail.target; const s = sel; markOutOfStock(t, s); }} disabled={busy}><BanIcon />Mark as out of stock</button>
                  )}
                  <button className="btn-primary btn-ico" onClick={() => { const t = detail.target; const s = sel; setSel(null); if (s) removeRow(s); done(t); }} disabled={busy}><BagIcon />Done buying</button>
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
        <div className="sc-modal-backdrop" onClick={() => setAdding(false)}>
          <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Add planned item" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">Add planned item</span>
              <button className="sc-modal-x" onClick={() => setAdding(false)} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              {error && <div className="validation err" style={{ marginBottom: 10 }}>{error}</div>}

              {/* search — code / name / piece count / brand */}
              <div className="scan-row">
                <SearchInput
                  value={skuQuery}
                  onChange={(v) => { setSkuQuery(v); setSearched(false); setSkuHits([]); if (picked) { setPicked(null); setPickedStock(null); } }}
                  placeholder="search SKU by code / name / piece count / brand"
                />
              </div>
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
                <div className="validation ok" style={{ margin: '8px 0' }}>New code — kept as a placeholder; you’ll match it to a real SKU when it arrives at Inbound.</div>
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
                    <label>Product link <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
                    <input type="text" placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} />
                  </div>
                </div>

                <div className="po-field">
                  <label>Short note <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
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

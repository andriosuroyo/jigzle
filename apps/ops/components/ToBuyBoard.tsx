'use client';

// Purchasing → To buy tab (PR73). Three sub-tabs (styled like the Sales Pending readiness filters),
// each a live count:
//  • Manual    — manual buy-list (PO status 'Planned'). Has "+ add item". Qty is editable (± steppers).
//  • From Sales — derived from Sales (read-only): unfulfilled lines for ≤0-available SKUs. No add button;
//                 qty mirrors the order line (uneditable).
//  • Out of Stock — PO status 'Sold out'. Qty uneditable; Restore → back to Manual.
//
// Every card shares one 3-line layout (larger image): line 1 = code + name + urgency (right);
// line 2 = context (manual: stock figures / note · sales: order id + customer + date); line 3 = qty +
// Buy + Done. "Buy" opens an overlay listing the product link (if attached) + the catalogue's stored
// supplier sources, with a "Mark as Out of Stock" fallback. "Done" sends the item to To Forwarder
// (a Processing PO).

import { useMemo, useState } from 'react';
import {
  buyPreorder,
  createDraftSku,
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
} from '@/app/purchasing/actions';
import type { PlannedItemRow, PreorderRow, SoldOutRow, SkuStockInfo, Urgency } from '@/app/purchasing/types';
import type { SkuHit } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');

type SubTab = 'manual' | 'sales' | 'oos';

const URGENCY_OPTS: { key: Urgency; label: string }[] = [
  { key: 'low', label: 'Low' },
  { key: 'mid', label: 'Mid' },
  { key: 'high', label: 'High' },
];

// little coloured priority chip (right side of a card's line 1)
function UrgencyChip({ urgency }: { urgency: Urgency | null }) {
  if (!urgency) return null;
  return <span className={`urg-chip urg-${urgency}`}>{urgency}</span>;
}

// pipeline figures in the canonical order — forwarder → shipped → warehouse. A non-zero number reads
// green; a zero stays muted.
function StockFigs({ wf, otw, avail }: { wf: number; otw: number; avail: number }) {
  const fig = (n: number) => <b className={n > 0 ? 'fig-pos' : 'fig-zero'}>{n}</b>;
  return <>at forwarder {fig(wf)} · shipped {fig(otw)} · warehouse {fig(avail)}</>;
}

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
  const [tab, setTab] = useState<SubTab>('manual');
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
  const [picked, setPicked] = useState<{ item_code: string; name: string } | null>(null);
  const [pickedStock, setPickedStock] = useState<SkuStockInfo | null>(null);
  const [qty, setQty] = useState(1);
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const [addUrgency, setAddUrgency] = useState<Urgency | null>(null);

  // buy overlay
  const [buyTarget, setBuyTarget] = useState<BuyTarget | null>(null);
  const [buySources, setBuySources] = useState<string[]>([]);
  const [buyLoading, setBuyLoading] = useState(false);

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
    const q = skuQuery.trim();
    if (q.length < 2) { setSkuHits([]); setSearched(false); return; }
    setSearching(true);
    try { setSkuHits(await searchSkus(q)); } catch { setSkuHits([]); } finally { setSearching(false); setSearched(true); }
  }

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
      // a brand-new code is stubbed into the catalogue (draft) so the buy-list item can reference it
      if (!picked) await createDraftSku({ item_code: code });
      await createPlannedItem({
        item_code: code,
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

  // ── Done → To Forwarder (a Processing PO). Manual advances its own PO; a preorder spawns one. ──
  async function done(t: BuyTarget) {
    setBusy(true); setError(null);
    try {
      if (t.kind === 'manual' && t.po_id != null) await setPOStatus(t.po_id, 'Processing');
      else if (t.kind === 'sales') await buyPreorder({ item_code: t.item_code, qty: t.qty, customer_id: t.customer_id });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); }
    finally { setBusy(false); }
  }

  // ── buy overlay ──
  async function openBuy(t: BuyTarget) {
    setBuyTarget(t); setBuySources([]); setBuyLoading(true); setError(null);
    try { setBuySources(await getSkuSources(t.item_code)); } catch { setBuySources([]); } finally { setBuyLoading(false); }
  }

  // mark the buy-overlay's SKU out of stock (all links sold out)
  async function markOutOfStock() {
    if (!buyTarget) return;
    const t = buyTarget;
    setBusy(true); setError(null);
    try {
      if (t.po_id != null) await setSoldOut(t.po_id, true, null);
      else await markSkuSoldOut({ item_code: t.item_code, customer_id: t.customer_id, qty: t.qty, sales_id: t.sales_id });
      setBuyTarget(null);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); }
    finally { setBusy(false); }
  }

  // delete a real PO (manual buy-list item, or an out-of-stock row). From-Sales rows aren't POs → no delete.
  async function delItem(po_id: number) {
    setBusy(true); setError(null);
    try { await deletePO(po_id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); }
    finally { setBusy(false); }
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

      {/* Manual */}
      {tab === 'manual' && (
        <section className="fd-section">
          <div className="po-tobuy-head">
            <div className="fd-section-head" style={{ marginBottom: 0 }}>Manual buy-list</div>
            <button className="btn-secondary" onClick={openAdd}>+ add item</button>
          </div>
          {planned.length === 0 && <div className="hint">Nothing planned. Use “+ add item” to start a buy-list.</div>}
          <ul className="po-cards">
            {planned.map((p) => (
              <li key={p.po_id} className="po-card">
                <SkuImage status={imgMap[p.item_code ?? '']?.status} displayUrl={imgMap[p.item_code ?? '']?.displayUrl} name={p.name} size={SKU_IMG.md} />
                <div className="po-card-main">
                  <div className="po-card-l1">
                    <span className="ff-code">{p.item_code || '—'}</span>
                    <span className="ff-name">{p.name}</span>
                    <UrgencyChip urgency={p.urgency} />
                  </div>
                  <div className="po-card-l2 hint">
                    <StockFigs wf={p.with_forwarder} otw={p.on_the_way} avail={p.available} />
                    {p.item_note ? ` · ${p.item_note}` : ''}
                  </div>
                  <div className="po-card-l3">
                    <span className="qty-step">
                      <button type="button" onClick={() => changeQty(p.po_id, p.qty - 1)} disabled={p.qty <= 0} aria-label="decrease">−</button>
                      <input
                        type="number" inputMode="numeric" min={0} value={p.qty}
                        onChange={(e) => setPlanned((prev) => prev.map((x) => (x.po_id === p.po_id ? { ...x, qty: Math.max(0, parseInt(e.target.value, 10) || 0) } : x)))}
                        onBlur={(e) => changeQty(p.po_id, Math.max(0, parseInt(e.target.value, 10) || 0))}
                      />
                      <button type="button" onClick={() => changeQty(p.po_id, p.qty + 1)} aria-label="increase">+</button>
                    </span>
                    <div className="po-card-actions">
                      <button className="btn-secondary" onClick={() => openBuy({ kind: 'manual', item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: p.po_id, customer_id: null, sales_id: null, product_link: p.product_link })}>Buy</button>
                      <button className="btn-primary" onClick={() => done({ kind: 'manual', item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: p.po_id, customer_id: null, sales_id: null, product_link: p.product_link })} disabled={busy}>Done →</button>
                      <button className="po-del" onClick={() => delItem(p.po_id)} disabled={busy} aria-label="Delete">×</button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* From Sales */}
      {tab === 'sales' && (
        <section className="fd-section">
          {preorders.length === 0 && <div className="hint">No preorders — every ordered SKU is in stock.</div>}
          <ul className="po-cards">
            {preorders.map((p) => (
              <li key={p.line_id} className="po-card">
                <SkuImage status={imgMap[p.item_code ?? '']?.status} displayUrl={imgMap[p.item_code ?? '']?.displayUrl} name={p.name} size={SKU_IMG.md} />
                <div className="po-card-main">
                  <div className="po-card-l1">
                    <span className="ff-code">{p.item_code || '—'}</span>
                    <span className="ff-name">{p.name}</span>
                    <UrgencyChip urgency={p.urgency} />
                  </div>
                  <div className="po-card-l2 hint">{p.sales_id} · {p.customer_name || 'no customer'} · {fmtDate(p.order_date)}</div>
                  <div className="po-card-l3">
                    <span className="qty-ro" aria-label="quantity">{p.qty}</span>
                    <div className="po-card-actions">
                      <button className="btn-secondary" onClick={() => openBuy({ kind: 'sales', item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: null, customer_id: p.customer_id, sales_id: p.sales_id, product_link: p.product_link })}>Buy</button>
                      <button className="btn-primary" onClick={() => done({ kind: 'sales', item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: null, customer_id: p.customer_id, sales_id: p.sales_id, product_link: p.product_link })} disabled={busy}>Done →</button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Out of Stock — each card mirrors its origin (manual figures / sales order context) */}
      {tab === 'oos' && (
        <section className="fd-section">
          {soldOut.length === 0 && <div className="hint">Nothing marked out of stock.</div>}
          <ul className="po-cards">
            {soldOut.map((p) => (
              <li key={p.po_id} className="po-card">
                <SkuImage status={imgMap[p.item_code ?? '']?.status} displayUrl={imgMap[p.item_code ?? '']?.displayUrl} name={p.name} size={SKU_IMG.md} />
                <div className="po-card-main">
                  <div className="po-card-l1">
                    <span className="ff-code">{p.item_code || '—'}</span>
                    <span className="ff-name">{p.name}</span>
                    <UrgencyChip urgency={p.urgency} />
                  </div>
                  <div className="po-card-l2 hint">
                    {p.origin === 'sales'
                      ? <>{p.sales_id} · {p.customer_name || 'no customer'} · {fmtDate(p.order_date)}</>
                      : <StockFigs wf={p.with_forwarder} otw={p.on_the_way} avail={p.available} />}
                  </div>
                  <div className="po-card-l3">
                    {p.origin === 'manual'
                      ? (
                        <span className="qty-step">
                          <button type="button" onClick={() => changeQty(p.po_id, p.qty - 1)} disabled={p.qty <= 0} aria-label="decrease">−</button>
                          <input
                            type="number" inputMode="numeric" min={0} value={p.qty}
                            onChange={(e) => setSoldOutList((prev) => prev.map((x) => (x.po_id === p.po_id ? { ...x, qty: Math.max(0, parseInt(e.target.value, 10) || 0) } : x)))}
                            onBlur={(e) => changeQty(p.po_id, Math.max(0, parseInt(e.target.value, 10) || 0))}
                          />
                          <button type="button" onClick={() => changeQty(p.po_id, p.qty + 1)} aria-label="increase">+</button>
                        </span>
                      )
                      : <span className="qty-ro" aria-label="quantity">{p.qty}</span>}
                    <div className="po-card-actions">
                      <button className="btn-secondary" onClick={() => openBuy({ kind: 'oos', item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: p.po_id, customer_id: null, sales_id: p.sales_id, product_link: p.product_link })}>Buy</button>
                      <button className="btn-primary" onClick={() => done({ kind: 'oos', item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: p.po_id, customer_id: null, sales_id: p.sales_id, product_link: p.product_link })} disabled={busy}>Done →</button>
                      <button className="po-del" onClick={() => delItem(p.po_id)} disabled={busy} aria-label="Delete">×</button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
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
                <input
                  type="text"
                  autoFocus
                  placeholder="search SKU by code / name / piece count / brand"
                  value={skuQuery}
                  onChange={(e) => { setSkuQuery(e.target.value); setSearched(false); setSkuHits([]); if (picked) { setPicked(null); setPickedStock(null); } }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
                />
                <button className="btn-secondary" onClick={runSearch} disabled={searching}>{searching ? '…' : 'search'}</button>
              </div>
              {/* search results — quick-view rows (small picture, code + name, availability line) */}
              {!picked && skuHits.length > 0 && (
                <ul className="result-list" style={{ marginTop: 6 }}>
                  {skuHits.map((h) => (
                    <li key={h.item_code}>
                      <button className="po-pick po-pick-btn" onClick={() => pick(h)}>
                        <SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={SKU_IMG.sm} />
                        <div className="po-pick-main">
                          <div className="po-pick-l1"><span className="ff-code">{h.item_code}</span><span className="ff-name">{h.name}{h.brand ? ` · ${h.brand}` : ''}</span></div>
                          <div className="po-pick-l2"><StockFigs wf={h.with_forwarder} otw={h.on_the_way} avail={h.available} /></div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* chosen SKU — same quick-view row, with a red × to remove */}
              {picked && (
                <div className="po-pick" style={{ marginTop: 8 }}>
                  <SkuImage status={imgMap[picked.item_code]?.status} displayUrl={imgMap[picked.item_code]?.displayUrl} name={picked.name} size={SKU_IMG.sm} />
                  <div className="po-pick-main">
                    <div className="po-pick-l1"><span className="ff-code">{picked.item_code}</span><span className="ff-name">{picked.name}</span></div>
                    <div className="po-pick-l2">
                      {pickedStock
                        ? <StockFigs wf={pickedStock.with_forwarder} otw={pickedStock.on_the_way} avail={pickedStock.available} />
                        : 'loading…'}
                    </div>
                  </div>
                  <button className="po-pick-x" onClick={() => { setPicked(null); setPickedStock(null); }} aria-label="Remove">×</button>
                </div>
              )}
              {isNewSku && (
                <div className="validation ok" style={{ margin: '8px 0' }}>New SKU: it will be added to the catalog.</div>
              )}

              {/* item fields — always shown, qty defaults to 1 */}
              <div className="po-form" style={{ marginTop: 4 }}>
                <div className="po-field">
                  <label>Qty</label>
                  <span className="qty-step">
                    <button type="button" onClick={() => setQty((q) => Math.max(0, q - 1))} disabled={qty <= 0} aria-label="decrease">−</button>
                    <input type="number" inputMode="numeric" min={0} value={qty} onChange={(e) => setQty(Math.max(0, parseInt(e.target.value, 10) || 0))} />
                    <button type="button" onClick={() => setQty((q) => q + 1)} aria-label="increase">+</button>
                  </span>
                </div>

                <div className="po-field">
                  <label>Product link <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
                  <input type="text" placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} />
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

                <div className="po-commit">
                  <span className="fd-commit-info">{!canAdd ? 'Search a SKU, or type a new SKU code and search.' : ''}</span>
                  <button className="btn-primary" onClick={submitPlanned} disabled={busy || !canAdd}>{busy ? 'Adding…' : 'Add item'}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* "Buy" overlay — dimmed-backdrop modal: product link + catalogue sources + mark-out-of-stock */}
      {buyTarget && (
        <div className="sc-modal-backdrop" onClick={() => setBuyTarget(null)}>
          <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Buy item" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">Buy this item</span>
              <button className="sc-modal-x" onClick={() => setBuyTarget(null)} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              {error && <div className="validation err" style={{ marginBottom: 10 }}>{error}</div>}
              <div className="po-pick" style={{ marginBottom: 12 }}>
                <SkuImage status={imgMap[buyTarget.item_code]?.status} displayUrl={imgMap[buyTarget.item_code]?.displayUrl} name={buyTarget.name} size={SKU_IMG.sm} />
                <div className="po-pick-main">
                  <div className="po-pick-l1"><span className="ff-code">{buyTarget.item_code || '—'}</span></div>
                  <div className="po-pick-l2"><span className="ff-name">{buyTarget.name}</span></div>
                </div>
              </div>

              <div className="fd-section-head">Where to buy</div>
              <div className="buy-links">
                {buyTarget.product_link && <BuyLink url={buyTarget.product_link} primary />}
                {buyLoading && <div className="hint">Loading catalogue sources…</div>}
                {!buyLoading && buySources.map((url) => <BuyLink key={url} url={url} />)}
                {!buyLoading && !buyTarget.product_link && buySources.length === 0 && (
                  <div className="hint">No links on file for this SKU.</div>
                )}
              </div>

              <div className="buy-oos">
                <div className="hint">All links sold out?</div>
                <button className="btn-primary danger" onClick={markOutOfStock} disabled={busy}>Mark as Out of Stock</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

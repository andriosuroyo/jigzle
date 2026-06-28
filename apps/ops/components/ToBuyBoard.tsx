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

// the active "Buy" overlay target — enough to load + render its links and run the right write-backs.
type BuyTarget = {
  kind: SubTab;
  item_code: string;
  name: string;
  qty: number;
  po_id: number | null;        // present for manual / oos (a real PO)
  customer_id: number | null;  // present for a from-sales preorder
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
  // new-SKU "first step" draft (shown when the search finds nothing)
  const [newSkuMode, setNewSkuMode] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');

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
    setNewSkuMode(false); setNewCode(''); setNewName('');
    setError(null);
  }

  // open the new-SKU "first step" draft form, prefilled with the unmatched search text
  function startNewSku() {
    setNewSkuMode(true);
    setNewCode(skuQuery.trim());
    setNewName('');
    setError(null);
  }

  // save the draft SKU (a real catalogue row flagged is_draft) then drop into the normal item form
  async function continueNewSku() {
    const code = newCode.trim();
    const nm = newName.trim();
    if (!code) { setError('Enter a SKU code.'); return; }
    if (!nm) { setError('Enter a name.'); return; }
    setBusy(true); setError(null);
    try {
      const draft = await createDraftSku({ item_code: code, name: nm });
      setPicked(draft);
      setPickedStock(null);
      setNewSkuMode(false);
      try { setPickedStock(await getSkuStock(draft.item_code)); } catch { /* best-effort */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add SKU.');
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    const q = skuQuery.trim();
    if (q.length < 2) { setSkuHits([]); setSearched(false); return; }
    setSearching(true);
    try { setSkuHits(await searchSkus(q)); } catch { setSkuHits([]); } finally { setSearching(false); setSearched(true); }
  }

  async function pick(hit: SkuHit) {
    setPicked({ item_code: hit.item_code, name: hit.name });
    setSkuHits([]); setSkuQuery(''); setSearched(false);
    setPickedStock(null);
    try { setPickedStock(await getSkuStock(hit.item_code)); } catch { /* figures are best-effort */ }
  }

  async function submitPlanned() {
    if (!picked) return;
    if (!Number.isFinite(qty) || qty < 0) { setError('Qty must be a number ≥ 0.'); return; }
    setBusy(true); setError(null);
    try {
      await createPlannedItem({
        item_code: picked.item_code,
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
    setPlanned((prev) => prev.map((p) => (p.po_id === po_id ? { ...p, qty: q } : p)));
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
      else await markSkuSoldOut({ item_code: t.item_code, customer_id: t.customer_id, qty: t.qty });
      setBuyTarget(null);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); }
    finally { setBusy(false); }
  }

  async function restore(po_id: number) {
    setBusy(true); setError(null);
    try { await setSoldOut(po_id, false); await refresh(); }
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
                    warehouse {p.available} · forwarder {p.with_forwarder} · shipped {p.on_the_way}
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
                      <button className="btn-secondary" onClick={() => openBuy({ kind: 'manual', item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: p.po_id, customer_id: null, product_link: p.product_link })}>Buy</button>
                      <button className="btn-primary" onClick={() => done({ kind: 'manual', item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: p.po_id, customer_id: null, product_link: p.product_link })} disabled={busy}>Done →</button>
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
                      <button className="btn-secondary" onClick={() => openBuy({ kind: 'sales', item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: null, customer_id: p.customer_id, product_link: p.product_link })}>Buy</button>
                      <button className="btn-primary" onClick={() => done({ kind: 'sales', item_code: p.item_code ?? '', name: p.name, qty: p.qty, po_id: null, customer_id: p.customer_id, product_link: p.product_link })} disabled={busy}>Done →</button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Out of Stock */}
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
                  <div className="po-card-l2 hint">out of stock {fmtDate(p.sold_out_date)}{p.sold_out_note ? ` · ${p.sold_out_note}` : ''}</div>
                  <div className="po-card-l3">
                    <span className="qty-ro" aria-label="quantity">{p.qty}</span>
                    <div className="po-card-actions">
                      <button className="btn-link" onClick={() => restore(p.po_id)} disabled={busy}>↩ Restore to manual</button>
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

              {/* (a) search */}
              {!picked && !newSkuMode && (
                <>
                  <div className="scan-row">
                    <input
                      type="text"
                      autoFocus
                      placeholder="search SKU by code / name / piece count / brand"
                      value={skuQuery}
                      onChange={(e) => { setSkuQuery(e.target.value); setSearched(false); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
                    />
                    <button className="btn-secondary" onClick={runSearch} disabled={searching}>{searching ? '…' : 'search'}</button>
                  </div>
                  {skuHits.length > 0 && (
                    <ul className="result-list" style={{ marginTop: 6 }}>
                      {skuHits.map((h) => (
                        <li key={h.item_code}>
                          <button className="result-item po-sku-hit" onClick={() => pick(h)}>
                            <span className="ri-name"><SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={SKU_IMG.sm} /> {h.item_code} · {h.name}{h.brand ? ` · ${h.brand}` : ''}</span>
                            <span className="po-sku-meta">avail <b>{h.available}</b> · on the way <b>{h.on_the_way}</b></span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {/* no match → start the new-SKU "first step" draft */}
                  {searched && !searching && skuHits.length === 0 && (
                    <div className="po-nosku">
                      <div className="hint">No SKU found for “{skuQuery.trim()}”.</div>
                      <button className="btn-secondary" onClick={startNewSku}>+ Add new SKU (Catalog)</button>
                    </div>
                  )}
                </>
              )}

              {/* (b) new-SKU first step — a draft saved to Catalog (is_draft), enriched there later */}
              {!picked && newSkuMode && (
                <div className="po-form">
                  <div className="hint" style={{ marginBottom: 10 }}>
                    New SKU — a Catalog draft. It’s saved so you can buy it now; finish its details in Catalog later (it stays a draft until then).
                  </div>
                  <div className="po-field">
                    <label>SKU code</label>
                    <input type="text" autoFocus value={newCode} onChange={(e) => setNewCode(e.target.value)} />
                  </div>
                  <div className="po-field">
                    <label>Name</label>
                    <input type="text" placeholder="short name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                  </div>
                  <div className="fd-commit">
                    <button className="btn-link" onClick={() => { setNewSkuMode(false); setError(null); }}>← back to search</button>
                    <button className="btn-primary" onClick={continueNewSku} disabled={busy}>{busy ? 'Saving…' : 'Continue'}</button>
                  </div>
                </div>
              )}

              {/* (c) item details */}
              {picked && (
                <div className="po-form">
                  <div className="po-current">
                    <span className="ff-code">{picked.item_code}</span>
                    <span className="ff-name">{picked.name}</span>
                    <button className="btn-link po-detach" onClick={() => { setPicked(null); setPickedStock(null); }}>change</button>
                  </div>
                  <div className="hint" style={{ margin: '6px 0' }}>
                    {pickedStock
                      ? <>warehouse <b>{pickedStock.available}</b> · in forwarder <b>{pickedStock.with_forwarder}</b> · shipped <b>{pickedStock.on_the_way}</b></>
                      : 'loading stock figures…'}
                  </div>

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

                  <div className="fd-commit">
                    <div className="fd-commit-info">Adds to the Manual buy-list.</div>
                    <button className="btn-primary" onClick={submitPlanned} disabled={busy}>{busy ? 'Adding…' : 'Add to manual'}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* "Buy" overlay — dimmed-backdrop modal: product link + catalogue sources + mark-out-of-stock */}
      {buyTarget && (
        <div className="sc-modal-backdrop" onClick={() => setBuyTarget(null)}>
          <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Buy item" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">Buy · {buyTarget.item_code || buyTarget.name}</span>
              <button className="sc-modal-x" onClick={() => setBuyTarget(null)} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              {error && <div className="validation err" style={{ marginBottom: 10 }}>{error}</div>}
              <div className="po-current" style={{ marginBottom: 10 }}>
                <span className="ff-code">{buyTarget.item_code || '—'}</span>
                <span className="ff-name">{buyTarget.name}</span>
              </div>

              <div className="fd-section-head">Where to buy</div>
              <div className="buy-links">
                {buyTarget.product_link && (
                  <a className="buy-link primary" href={buyTarget.product_link} target="_blank" rel="noreferrer">Open product link ↗</a>
                )}
                {buyLoading && <div className="hint">Loading catalogue sources…</div>}
                {!buyLoading && buySources.map((url, i) => (
                  <a key={url} className="buy-link" href={url} target="_blank" rel="noreferrer">Catalogue source {i + 1} ↗</a>
                ))}
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

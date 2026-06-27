'use client';

// Purchasing → To buy tab. Three lists:
//  • Planned  — manual buy-list (PO status 'Planned'). "+ add item" overlay: SKU search showing live
//    warehouse / forwarder / shipped figures, set qty + product link. Per row: Buy (→ Processing, moves
//    to To forwarder) and Mark sold out.
//  • Preorder — derived from Sales (read-only): unfulfilled lines for ≤0-available SKUs.
//  • Sold out — PO status 'Sold out' (auto-dated + optional reason). Per row: Restore (→ Planned).

import { useMemo, useState } from 'react';
import {
  createPlannedItem,
  getPlannedItems,
  getSkuStock,
  getSoldOutItems,
  searchSkus,
  setPOStatus,
  setSoldOut,
} from '@/app/purchasing/actions';
import type { PlannedItemRow, PreorderRow, SoldOutRow, SkuStockInfo } from '@/app/purchasing/types';
import type { SkuHit } from '@/app/purchasing/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');

export default function ToBuyBoard({
  planned: initialPlanned,
  preorders,
  soldOut: initialSoldOut,
}: {
  planned: PlannedItemRow[];
  preorders: PreorderRow[];
  soldOut: SoldOutRow[];
}) {
  const [planned, setPlanned] = useState<PlannedItemRow[]>(initialPlanned);
  const [soldOut, setSoldOutList] = useState<SoldOutRow[]>(initialSoldOut);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // add-item overlay
  const [adding, setAdding] = useState(false);
  const [skuQuery, setSkuQuery] = useState('');
  const [skuHits, setSkuHits] = useState<SkuHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<{ item_code: string; name: string } | null>(null);
  const [pickedStock, setPickedStock] = useState<SkuStockInfo | null>(null);
  const [qty, setQty] = useState('1');
  const [link, setLink] = useState('');

  // per-row mark-sold-out (inline reason)
  const [soldOutFor, setSoldOutFor] = useState<number | null>(null);
  const [soldOutNote, setSoldOutNote] = useState('');

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
  }

  function openAdd() {
    setAdding(true);
    setSkuQuery(''); setSkuHits([]); setPicked(null); setPickedStock(null); setQty('1'); setLink('');
    setError(null);
  }

  async function runSearch() {
    const q = skuQuery.trim();
    if (q.length < 2) { setSkuHits([]); return; }
    setSearching(true);
    try { setSkuHits(await searchSkus(q)); } catch { setSkuHits([]); } finally { setSearching(false); }
  }

  async function pick(hit: SkuHit) {
    setPicked({ item_code: hit.item_code, name: hit.name });
    setSkuHits([]); setSkuQuery('');
    setPickedStock(null);
    try { setPickedStock(await getSkuStock(hit.item_code)); } catch { /* figures are best-effort */ }
  }

  async function submitPlanned() {
    if (!picked) return;
    const n = parseInt(qty, 10);
    if (!Number.isFinite(n) || n < 0) { setError('Qty must be a number ≥ 0.'); return; }
    setBusy(true); setError(null);
    try {
      await createPlannedItem({ item_code: picked.item_code, qty: n, product_link: link.trim() || null });
      setAdding(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add.');
    } finally {
      setBusy(false);
    }
  }

  // Buy a planned item → Processing (moves to To forwarder)
  async function buy(po_id: number) {
    setBusy(true); setError(null);
    try { await setPOStatus(po_id, 'Processing'); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed.'); }
    finally { setBusy(false); }
  }

  async function markSoldOut(po_id: number) {
    setBusy(true); setError(null);
    try {
      await setSoldOut(po_id, true, soldOutNote.trim() || null);
      setSoldOutFor(null); setSoldOutNote('');
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

  return (
    <div className="purch-tobuy">
      {error && <div className="validation err">{error}</div>}

      {/* Planned — manual buy-list */}
      <section className="fd-section">
        <div className="po-tobuy-head">
          <div className="fd-section-head" style={{ marginBottom: 0 }}>Planned ({planned.length})</div>
          <button className="btn-secondary" onClick={openAdd}>+ add item</button>
        </div>
        {planned.length === 0 && <div className="hint">Nothing planned. Use “+ add item” to start a buy-list.</div>}
        <ul className="ff-lines">
          {planned.map((p) => (
            <li key={p.po_id} className="ff-line">
              <div className="pend-line">
                <SkuImage status={imgMap[p.item_code ?? '']?.status} displayUrl={imgMap[p.item_code ?? '']?.displayUrl} name={p.name} size={SKU_IMG.sm} />
                <div className="pend-line-main">
                  <span className="ff-code">{p.item_code || '—'}</span>
                  <span className="ff-name">{p.name}</span>
                  <span className="hint">
                    warehouse {p.available} · forwarder {p.with_forwarder} · shipped {p.on_the_way}
                    {p.product_link ? <> · <a href={p.product_link} target="_blank" rel="noreferrer" className="btn-link">link ↗</a></> : null}
                  </span>
                </div>
                <span className="ff-qty">×{p.qty}</span>
              </div>
              <div className="rcv-controls">
                <button className="btn-secondary" onClick={() => buy(p.po_id)} disabled={busy}>Buy →</button>
                {soldOutFor === p.po_id ? (
                  <span className="rcv-reverse-ask">
                    <input type="text" className="rcv-dim" placeholder="reason (optional)" value={soldOutNote} onChange={(e) => setSoldOutNote(e.target.value)} />
                    <button className="btn-link" onClick={() => { setSoldOutFor(null); setSoldOutNote(''); }} disabled={busy}>cancel</button>
                    <button className="btn-primary danger" onClick={() => markSoldOut(p.po_id)} disabled={busy}>Mark sold out</button>
                  </span>
                ) : (
                  <button className="btn-link danger" onClick={() => { setSoldOutFor(p.po_id); setSoldOutNote(''); }} disabled={busy}>Mark sold out</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Preorder — derived from Sales (read-only) */}
      <section className="fd-section">
        <div className="fd-section-head">Preorder · from Sales ({preorders.length})</div>
        {preorders.length === 0 && <div className="hint">No preorders — every ordered SKU is in stock.</div>}
        <ul className="ff-lines">
          {preorders.map((p) => (
            <li key={p.line_id} className="ff-line pend-line">
              <SkuImage status={imgMap[p.item_code ?? '']?.status} displayUrl={imgMap[p.item_code ?? '']?.displayUrl} name={p.name} size={SKU_IMG.sm} />
              <div className="pend-line-main">
                <span className="ff-code">{p.item_code || '—'}</span>
                <span className="ff-name">{p.name}</span>
                <span className="hint">{p.sales_id} · {p.customer_name || 'no customer'} · {fmtDate(p.order_date)}</span>
              </div>
              <span className="ff-qty">×{p.qty}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Sold out */}
      <section className="fd-section">
        <div className="fd-section-head">Sold out ({soldOut.length})</div>
        {soldOut.length === 0 && <div className="hint">Nothing marked sold out.</div>}
        <ul className="ff-lines">
          {soldOut.map((p) => (
            <li key={p.po_id} className="ff-line">
              <div className="pend-line">
                <SkuImage status={imgMap[p.item_code ?? '']?.status} displayUrl={imgMap[p.item_code ?? '']?.displayUrl} name={p.name} size={SKU_IMG.sm} />
                <div className="pend-line-main">
                  <span className="ff-code">{p.item_code || '—'}</span>
                  <span className="ff-name">{p.name}</span>
                  <span className="hint">seen sold out {fmtDate(p.sold_out_date)}{p.sold_out_note ? ` · ${p.sold_out_note}` : ''}</span>
                </div>
                <span className="ff-qty">×{p.qty}</span>
              </div>
              <div className="rcv-controls">
                <button className="btn-link" onClick={() => restore(p.po_id)} disabled={busy}>↩ Restore to planned</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* "+ add item" overlay */}
      {adding && (
        <div className="orders-overlay" role="dialog" aria-modal="true" aria-label="Add planned item">
          <div className="orders-overlay-bar">
            <span className="orders-overlay-title">Add planned item</span>
            <button className="orders-overlay-close" onClick={() => setAdding(false)} aria-label="Close">×</button>
          </div>
          <div className="orders-overlay-body" style={{ padding: '14px 16px' }}>
            {!picked ? (
              <>
                <div className="scan-row">
                  <input
                    type="text"
                    autoFocus
                    placeholder="search SKU by code / name / piece count"
                    value={skuQuery}
                    onChange={(e) => setSkuQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
                  />
                  <button className="btn-secondary" onClick={runSearch} disabled={searching}>{searching ? '…' : 'search'}</button>
                </div>
                {skuHits.length > 0 && (
                  <ul className="result-list" style={{ marginTop: 6 }}>
                    {skuHits.map((h) => (
                      <li key={h.item_code}>
                        <button className="result-item po-sku-hit" onClick={() => pick(h)}>
                          <span className="ri-name"><SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={SKU_IMG.sm} /> {h.item_code} · {h.name}</span>
                          <span className="po-sku-meta">avail <b>{h.available}</b> · on the way <b>{h.on_the_way}</b></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
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
                <div className="po-inline">
                  <div className="po-field">
                    <label>Qty</label>
                    <input type="number" inputMode="numeric" min={0} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
                  </div>
                  <div className="po-field">
                    <label>Product link <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
                    <input type="text" placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} />
                  </div>
                </div>
                <div className="fd-commit">
                  <div className="fd-commit-info">Adds to the Planned buy-list.</div>
                  <button className="btn-primary" onClick={submitPlanned} disabled={busy}>{busy ? 'Adding…' : 'Add to planned'}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

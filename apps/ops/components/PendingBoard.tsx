'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { getPending, sendReadyItems, deleteOrder, markOrderPaid, addOrderLine, updateOrderLine, deleteOrderLine } from '@/app/pending/actions';
import DeleteOrderConfirm from '@/components/DeleteOrderConfirm';
import TrashButton from '@/components/TrashButton';
import SearchInput from '@/components/SearchInput';
import SkuSearchAdd from '@/components/SkuSearchAdd';
import type { OrderDot, PendingOrder, PendingLine } from '@/app/pending/types';
import type { CommonNote } from '@/app/settings/types';
import NoteEditor from '@/components/NoteEditor';
import SkuImage from '@/components/SkuImage';
import StatusCircles, { payTone } from '@/components/StatusCircles';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

type DotFilter = 'all' | OrderDot;
const FILTERS: { key: DotFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'red', label: 'To order' },
  { key: 'yellow', label: 'On the way' },
  { key: 'green', label: 'Ready' },
];
const STATUS_LABEL: Record<string, string> = { available: 'available', on_the_way: 'on the way', to_order: 'to order' };
const fmtIDR = (n: number | null | undefined): string => 'Rp ' + (n ?? 0).toLocaleString('id-ID');
// thousands-group a digit string for the price field (state stores digits only)
const fmtThousands = (d: string) => d.replace(/\D/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export default function PendingBoard({
  initialOrders,
  userEmail,
  commonNotes = [],
  embedded = false,
  onCountChange,
  onAdvance,
  reloadKey = 0,
}: {
  initialOrders: PendingOrder[];
  userEmail: string;
  commonNotes?: CommonNote[];
  // JZ-001: when mounted inside the Orders pipeline window, drop the page chrome (the shell owns the
  // AppHeader + tab bar) and report list count / stage advances up to the shell. Optional → the
  // standalone /pending deep-link still renders unchanged.
  embedded?: boolean;
  onCountChange?: (n: number) => void;
  onAdvance?: (salesId: string, toStage: string) => void;
  reloadKey?: number;
}) {
  const [orders, setOrders] = useState<PendingOrder[]>(initialOrders);
  const [filter, setFilter] = useState<DotFilter>('all');
  const [search, setSearch] = useState(''); // PR149: filter the queue by customer, order id, or SKU
  const [loadingList, setLoadingList] = useState(false);

  const [selId, setSelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // PR148: delete goes through the overlay confirm (no bare window.confirm); its error stays in the modal.
  const [confirmDel, setConfirmDel] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  // PR215: edit-items OVERLAY — per-line qty/price drafts, immediate trashcan remove, and an add-item
  // panel. Edits commit per-line as you make them (Save just closes).
  const [editItems, setEditItems] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { qty: string; price: string }>>({});
  const [rowBusy, setRowBusy] = useState<string | null>(null); // line_id (or '+add') mid-write
  const [rowErr, setRowErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);                 // the add-item panel is open
  const [addPick, setAddPick] = useState<string | null>(null); // chosen item_code awaiting qty/price
  const [addQty, setAddQty] = useState('1');
  const [addPrice, setAddPrice] = useState('');
  const reqRef = useRef(0);

  // PR149: readiness-tab filter + free-text search (customer name, order id, or a SKU on the order)
  // over the loaded queue — History went terminal-only, so in-flight orders are found HERE.
  const visible = useMemo(() => {
    const byDot = filter === 'all' ? orders : orders.filter((o) => o.dot === filter);
    const q = search.trim().toLowerCase();
    if (!q) return byDot;
    return byDot.filter(
      (o) =>
        (o.customer_name ?? '').toLowerCase().includes(q) ||
        o.sales_id.toLowerCase().includes(q) ||
        o.lines.some((l) => (l.item_code ?? '').toLowerCase().includes(q))
    );
  }, [orders, filter, search]);

  // Per-filter counts for the readiness tabs (red+yellow+green sum to the All total — every order has
  // exactly one dot).
  const dotCounts = useMemo(() => {
    const c: Record<OrderDot, number> = { red: 0, yellow: 0, green: 0 };
    for (const o of orders) c[o.dot]++;
    return c;
  }, [orders]);
  const filterCount = (k: DotFilter) => (k === 'all' ? orders.length : dotCounts[k]);
  const sel = useMemo(() => orders.find((o) => o.sales_id === selId) ?? null, [orders, selId]);

  const imgCodes = useMemo(
    () => (sel?.lines ?? []).map((l) => l.item_code).filter((c): c is string => !!c),
    [sel]
  );
  const imgMap = useSkuImages(imgCodes);

  async function refresh() {
    setLoadingList(true);
    try {
      setOrders(await getPending());
    } catch {
      /* keep current on transient error */
    } finally {
      setLoadingList(false);
    }
  }

  // JZ-001: live count badge — report the queue size to the shell whenever it changes.
  useEffect(() => { onCountChange?.(orders.length); }, [orders, onCountChange]);
  // JZ-001: refetch when the shell bumps reloadKey (e.g. a new order was just created in the overlay).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) refresh(); }, [reloadKey]);

  function openOrder(o: PendingOrder) {
    setError(null);
    setSuccess(null);
    setSelId(o.sales_id);
  }

  // reflect a saved per-line note in local state so it survives re-renders without a refetch.
  function applyLineNote(salesId: string, lineId: string, note: string | null) {
    setOrders((prev) =>
      prev.map((o) =>
        o.sales_id === salesId
          ? { ...o, lines: o.lines.map((l) => (l.line_id === lineId ? { ...l, line_note: note } : l)) }
          : o
      )
    );
  }

  // FP-6: cut the ready lines (available ≥ qty). Short lines stay in Pending; the cut lines move to Fulfill.
  async function doSendReady() {
    if (!sel) return;
    const readyIds = sel.lines.filter((l) => l.ready).map((l) => l.line_id);
    if (!readyIds.length) return;
    setBusy(true);
    setError(null);
    try {
      const { error: sendErr } = await sendReadyItems(sel.sales_id, readyIds);
      if (sendErr) { setError(sendErr); return; }
      setSuccess(`${sel.sales_id}: sent ${readyIds.length} ready item${readyIds.length === 1 ? '' : 's'} to Fulfill.`);
      onAdvance?.(sel.sales_id, 'Fulfill'); // JZ-001: pipeline toast — order advanced a stage
      setSelId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send ready items failed.');
    } finally {
      setBusy(false);
    }
  }

  // One-tap settle: pay off the whole remaining balance, method recorded as 'manual' (no amount/method
  // entry — that detail isn't tracked here). Pending is the single gateway for settling payment.
  async function doMarkPaid() {
    if (!sel || sel.balance <= 0) return;
    const myReq = ++reqRef.current;
    setBusy(true);
    setError(null);
    try {
      const { error: payErr, result: res } = await markOrderPaid(sel.sales_id, sel.balance, 'manual');
      if (reqRef.current !== myReq) return;
      if (payErr || !res) { setError(payErr ?? 'Mark paid failed.'); return; }
      setSuccess(`${sel.sales_id}: ${res.balance <= 0 ? 'fully paid' : 'partially paid'}.`);
      await refresh();
    } catch (e) {
      if (reqRef.current === myReq) setError(e instanceof Error ? e.message : 'Mark paid failed.');
    } finally {
      if (reqRef.current === myReq) setBusy(false);
    }
  }

  // FP-4 / PR148: hard delete via delete_order (any stage; snapshotted into order_delete_log).
  // Runs from the overlay confirm; errors render inside the modal.
  async function doDelete() {
    if (!sel) return;
    setBusy(true);
    setDelErr(null);
    try {
      const { error: err } = await deleteOrder(sel.sales_id);
      if (err) { setDelErr(err); return; }
      setConfirmDel(false);
      setSuccess(`${sel.sales_id} deleted.`);
      setSelId(null);
      await refresh();
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  // PR196 — edit items on a pending order. Every line shown here is UNCUT, so these ops move no stock
  // (stock_check counts only fulfilled/shipped rows); each RPC recomputes the total + payment status.
  function setDraft(lineId: string, field: 'qty' | 'price', value: string) {
    setDrafts((d) => {
      const cur = d[lineId] ?? { qty: '', price: '' };
      return { ...d, [lineId]: { ...cur, [field]: value } };
    });
  }
  function beginEdit() {
    if (!sel) return;
    const d: Record<string, { qty: string; price: string }> = {};
    for (const l of sel.lines) d[l.line_id] = { qty: String(l.qty), price: String(l.unit_price_idr ?? 0) };
    setDrafts(d);
    setRowErr(null); setAdding(false); setAddPick(null);
    setEditItems(true);
  }
  function endEdit() {
    setEditItems(false); setAdding(false); setAddPick(null); setRowErr(null);
  }
  async function saveLine(l: PendingLine) {
    const d = drafts[l.line_id];
    if (!sel || !d) return;
    const qty = parseInt(d.qty, 10);
    const price = parseInt(d.price, 10);
    if (!Number.isFinite(qty) || qty < 1) { setRowErr('Quantity must be at least 1.'); return; }
    const nextPrice = Number.isFinite(price) ? price : 0;
    if (qty === l.qty && nextPrice === (l.unit_price_idr ?? 0)) return; // unchanged → no write
    setRowBusy(l.line_id); setRowErr(null);
    const { error: e } = await updateOrderLine(l.line_id, qty, nextPrice);
    if (e) { setRowErr(e); setRowBusy(null); return; }
    await refresh();
    setRowBusy(null);
  }
  // qty easy-adjust (± stepper in the edit-items overlay) — bumps the draft and commits immediately.
  async function stepQty(l: PendingLine, delta: number) {
    const cur = parseInt(drafts[l.line_id]?.qty ?? String(l.qty), 10) || l.qty;
    const next = Math.max(1, cur + delta);
    setDraft(l.line_id, 'qty', String(next));
    const price = parseInt(drafts[l.line_id]?.price ?? String(l.unit_price_idr ?? 0), 10);
    setRowBusy(l.line_id); setRowErr(null);
    const { error: e } = await updateOrderLine(l.line_id, next, Number.isFinite(price) ? price : 0);
    if (e) { setRowErr(e); setRowBusy(null); return; }
    await refresh();
    setRowBusy(null);
  }
  async function removeLine(lineId: string) {
    setRowBusy(lineId); setRowErr(null);
    const { error: e } = await deleteOrderLine(lineId);
    if (e) { setRowErr(e); setRowBusy(null); return; }
    await refresh();
    setRowBusy(null);
  }
  async function commitAdd() {
    if (!sel || !addPick) return;
    const qty = parseInt(addQty, 10);
    const price = parseInt(addPrice, 10);
    if (!Number.isFinite(qty) || qty < 1) { setRowErr('Quantity must be at least 1.'); return; }
    setRowBusy('+add'); setRowErr(null);
    const { error: e } = await addOrderLine(sel.sales_id, addPick, qty, Number.isFinite(price) ? price : 0, null);
    if (e) { setRowErr(e); setRowBusy(null); return; }
    await refresh();
    setAddPick(null); setAddQty('1'); setAddPrice(''); setAdding(false); setRowBusy(null);
  }

  // reset edit mode when the selected order changes (mirrors the delete-confirm reset).
  useEffect(() => { endEdit(); setConfirmDel(false); }, [selId]);
  // keep drafts in sync with the (possibly refreshed) line set while editing — preserve half-typed
  // values, seed newly-added lines, drop removed ones.
  useEffect(() => {
    if (!editItems || !sel) return;
    setDrafts((prev) => {
      const next: Record<string, { qty: string; price: string }> = {};
      for (const l of sel.lines) next[l.line_id] = prev[l.line_id] ?? { qty: String(l.qty), price: String(l.unit_price_idr ?? 0) };
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, editItems]);

  // PR147 — bodyview: the body shows EITHER the filter tabs + full-width queue OR the tapped order's
  // detail with a ← back button (the Purchasing-History pattern); breadcrumb + pipeline tabs stay put.
  const body = (
    <div className="bodyview">
      {/* success / error pinned to the top for both actions (mark paid + send ready) */}
      {error && <div className="validation err">{error}</div>}
      {success && <div className="validation ok">{success}</div>}

      {/* ── Queue ── */}
      {!sel && (
        <>
          {/* PR149: free-text search over the queue (in-flight orders no longer appear in History). */}
          <div className="search-row" style={{ padding: '0 0 8px' }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search by customer ID or SKU…" />
          </div>
          {/* Readiness filter — underline tabs at the top of the queue, each with a live count badge. */}
          <div className="fq-filters" role="tablist" aria-label="Filter by stock readiness">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={filter === f.key}
                className={`fq-filter ${filter === f.key ? 'active' : ''}`}
                onClick={() => setFilter(f.key)}
                disabled={loadingList}
              >
                {f.label}
                <span className="fq-filter-count">{filterCount(f.key)}</span>
              </button>
            ))}
          </div>
          {visible.length === 0 && (
            <div className="hint fq-empty">{loadingList ? 'Loading…' : search.trim() ? 'No match.' : 'Nothing waiting in Pending.'}</div>
          )}
          <ul className="fq-list">
            {visible.map((o) => (
              <li key={o.sales_id}>
                {/* PR146 row: customer id + date on top; items/ready left, dual status circles
                    (box = readiness dot, $ = payment) bottom-right. */}
                <button className="fq-row" onClick={() => openOrder(o)}>
                  <div className="fq-row-top">
                    <span className="fq-headline">{o.customer_name || '—'}</span>
                    <span className="ord-date">{o.order_date ? o.order_date.slice(0, 10) : '—'}</span>
                  </div>
                  <div className="fq-row-bot">
                    <span>{o.lines.length} {o.lines.length === 1 ? 'item' : 'items'}</span>
                    {o.ready_count > 0 && <span className="pend-ready">{o.ready_count} ready</span>}
                    <StatusCircles box={o.dot === 'red' ? 'red' : o.dot === 'yellow' ? 'yellow' : 'green'} pay={payTone(o.payment_status)} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── Detail ── */}
      {sel && (
        <>
          <button className="btn-link bv-back" onClick={() => setSelId(null)}>← back</button>
          <div className="bv-detail">
            <>
              {/* PR144 header: customer id left, order date right; the sales id moved to the bottom. */}
              <div className="fd-head">
                <div className="fd-head-row">
                  <div className="fd-title fd-title-plain">{sel.customer_name || '—'}</div>
                  {sel.order_date && <span className="fd-date">{sel.order_date.slice(0, 10)}</span>}
                </div>
              </div>

              {/* Lines — compact row: image left, code / name / qty / status to its right. PR196: "Edit
                  items" swaps qty/status for qty + price inputs and a remove ✕, and reveals Add item. */}
              <section className="fd-section">
                <div className="fd-section-head">Items</div>
                <ul className="ff-lines">
                  {sel.lines.map((l) => (
                    <li key={l.line_id} className="ff-line pend-line-card">
                      <div className="pend-line">
                        <SkuImage status={imgMap[l.item_code ?? '']?.status} displayUrl={imgMap[l.item_code ?? '']?.displayUrl} name={l.name} size={SKU_IMG.sm} />
                        <div className="pend-line-main">
                          <span className="ff-code">{l.item_code || '—'}</span>
                          <span className="ff-name">{l.name}</span>
                        </div>
                        <span className="ff-qty">×{l.qty}</span>
                        <span className={`pend-status ${l.status}`}>{STATUS_LABEL[l.status] ?? l.status}</span>
                      </div>
                      <NoteEditor lineId={l.line_id} value={l.line_note} commonNotes={commonNotes} onSaved={(note) => applyLineNote(sel.sales_id, l.line_id, note)} />
                    </li>
                  ))}
                </ul>
              </section>

              {/* Payment — totals only; balance right-aligned, green when clear. Settling is the single
                  "Mark as paid" button below (pays the full balance, method 'manual'). */}
              <section className="fd-section">
                <div className="ord-pay-grid">
                  <div><span className="ord-pay-k">Total</span><span className="ord-pay-v">{fmtIDR(sel.sales_total_idr)}</span></div>
                  <div><span className="ord-pay-k">Paid</span><span className="ord-pay-v">{fmtIDR(sel.paid_idr)}</span></div>
                  <div className="ord-pay-bal-col">
                    <span className="ord-pay-k">Balance</span>
                    <span className={`ord-pay-v ord-pay-bal ${sel.balance > 0 ? 'bal-due' : 'bal-clear'}`}>{fmtIDR(sel.balance)}</span>
                  </div>
                </div>
              </section>

              {/* Actions — Mark as paid · Edit items · Send ready items (left) + delete trashcan (right).
                  PR215: Edit items sits to the left of Send ready; Delete is the standard red trashcan. */}
              <div className="fd-commit fd-commit-row">
                {sel.balance > 0 && (
                  <button className="btn-secondary" onClick={doMarkPaid} disabled={busy}>{busy ? 'Saving…' : 'Mark as paid'}</button>
                )}
                <button className="btn-secondary" onClick={beginEdit} disabled={busy}>Edit items</button>
                <button className="btn-primary" onClick={doSendReady} disabled={busy || sel.ready_count === 0 || sel.balance > 0}>
                  {busy ? 'Working…' : `Send ready items${sel.ready_count ? ` (${sel.ready_count})` : ''}`}
                </button>
                <TrashButton onClick={() => { setDelErr(null); setConfirmDel(true); }} disabled={busy} ariaLabel="Delete order" className="fd-del-right" />
              </div>
              {sel.balance > 0 && sel.ready_count > 0 && !busy && (
                <div className="warn-text" style={{ marginTop: 6 }}>settle payment before sending</div>
              )}

              <div className="fd-orderid">{sel.sales_id}</div>

              {/* PR215 — Edit items overlay: qty ± stepper, plain price field, red trashcan remove, a
                  full-width add-item, the total/paid/balance, and Save (edits commit immediately). */}
              {editItems && sel && (
                <div className="sc-modal-backdrop" onClick={rowBusy ? undefined : endEdit}>
                  <div className="sc-modal sc-modal-lg" role="dialog" aria-modal="true" aria-label="Edit items" onClick={(e) => e.stopPropagation()}>
                    <div className="sc-modal-head sc-modal-head-row">
                      <span className="sc-modal-title">Edit items · {sel.customer_name || sel.sales_id}</span>
                      <button className="sc-modal-x" onClick={endEdit} aria-label="Close" disabled={!!rowBusy}>×</button>
                    </div>
                    <div className="sc-modal-body">
                      {rowErr && <div className="validation err" style={{ marginBottom: 10 }}>{rowErr}</div>}
                      <ul className="edit-lines">
                        {sel.lines.map((l) => {
                          const qv = parseInt(drafts[l.line_id]?.qty ?? String(l.qty), 10) || 1;
                          return (
                            <li key={l.line_id} className="edit-line">
                              <div className="edit-line-main">
                                <span className="ff-code">{l.item_code || '—'}</span>
                                <span className="ff-name">{l.name}</span>
                              </div>
                              <span className="qty-step">
                                <button type="button" aria-label="decrease" onClick={() => stepQty(l, -1)} disabled={rowBusy === l.line_id || qv <= 1}>−</button>
                                <input type="number" inputMode="numeric" min={1} aria-label="Quantity"
                                  value={drafts[l.line_id]?.qty ?? String(l.qty)}
                                  onChange={(e) => setDraft(l.line_id, 'qty', e.target.value)}
                                  onBlur={() => saveLine(l)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                  disabled={rowBusy === l.line_id} />
                                <button type="button" aria-label="increase" onClick={() => stepQty(l, 1)} disabled={rowBusy === l.line_id}>+</button>
                              </span>
                              <input className="edit-price" type="text" inputMode="numeric" aria-label="Unit price (Rp)" placeholder="price"
                                value={fmtThousands(drafts[l.line_id]?.price ?? String(l.unit_price_idr ?? 0))}
                                onChange={(e) => setDraft(l.line_id, 'price', e.target.value.replace(/\D/g, ''))}
                                onBlur={() => saveLine(l)}
                                disabled={rowBusy === l.line_id} />
                              <TrashButton onClick={() => removeLine(l.line_id)} disabled={rowBusy === l.line_id} ariaLabel="Remove item" />
                            </li>
                          );
                        })}
                      </ul>

                      {addPick ? (
                        <div className="edit-addrow">
                          <span className="ff-code">{addPick}</span>
                          <span className="qty-step">
                            <button type="button" aria-label="decrease" onClick={() => setAddQty(String(Math.max(1, (parseInt(addQty, 10) || 1) - 1)))} disabled={(parseInt(addQty, 10) || 1) <= 1}>−</button>
                            <input type="number" inputMode="numeric" min={1} aria-label="Quantity" value={addQty} onChange={(e) => setAddQty(e.target.value)} />
                            <button type="button" aria-label="increase" onClick={() => setAddQty(String((parseInt(addQty, 10) || 1) + 1))}>+</button>
                          </span>
                          <input className="edit-price" type="text" inputMode="numeric" placeholder="price" value={fmtThousands(addPrice)} onChange={(e) => setAddPrice(e.target.value.replace(/\D/g, ''))} />
                          <button className="btn-primary" onClick={commitAdd} disabled={rowBusy === '+add'}>{rowBusy === '+add' ? 'Adding…' : 'Add'}</button>
                          <button className="btn-secondary" onClick={() => { setAddPick(null); setAdding(false); }} disabled={rowBusy === '+add'}>cancel</button>
                        </div>
                      ) : adding ? (
                        <div style={{ marginTop: 10 }}>
                          <SkuSearchAdd
                            listed={new Set(sel.lines.map((l) => l.item_code).filter((c): c is string => !!c))}
                            placeholder="Add item: search by code or name"
                            onSelect={(code) => { setAddPick(code); setAddQty('1'); setAddPrice(''); }}
                          />
                        </div>
                      ) : (
                        <button className="btn-secondary edit-additem" onClick={() => setAdding(true)} disabled={!!rowBusy}>+ Add item</button>
                      )}

                      <div className="ord-pay-grid edit-pay">
                        <div><span className="ord-pay-k">Total</span><span className="ord-pay-v">{fmtIDR(sel.sales_total_idr)}</span></div>
                        <div><span className="ord-pay-k">Paid</span><span className="ord-pay-v">{fmtIDR(sel.paid_idr)}</span></div>
                        <div className="ord-pay-bal-col">
                          <span className="ord-pay-k">Balance</span>
                          <span className={`ord-pay-v ord-pay-bal ${sel.balance > 0 ? 'bal-due' : 'bal-clear'}`}>{fmtIDR(sel.balance)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="sc-modal-foot">
                      <button className="btn-primary" onClick={endEdit} disabled={!!rowBusy}>Save</button>
                    </div>
                  </div>
                </div>
              )}

              {confirmDel && (
                <DeleteOrderConfirm
                  salesId={sel.sales_id}
                  lines={[
                    `${sel.lines.length} pending item${sel.lines.length === 1 ? '' : 's'} removed with the order.`,
                    sel.paid_idr > 0
                      ? `${fmtIDR(sel.paid_idr)} in recorded payments is erased.`
                      : 'No payments recorded on this order.',
                  ]}
                  busy={busy}
                  error={delErr}
                  onConfirm={doDelete}
                  onCancel={() => setConfirmDel(false)}
                />
              )}
            </>
          </div>
        </>
      )}
    </div>
  );

  if (embedded) return body;
  return (
    <div className="ops">
      <AppHeader active="orders" userEmail={userEmail} />
      {body}
    </div>
  );
}

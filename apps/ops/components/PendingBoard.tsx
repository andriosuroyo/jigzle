'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import { getPending, sendReadyItems, deleteOrder, markOrderPaid, replaceOrderLines } from '@/app/pending/actions';
import DeleteOrderConfirm from '@/components/DeleteOrderConfirm';
import ConfirmModal from '@/components/ConfirmModal';
import SearchInput from '@/components/SearchInput';
import SkuSearchAdd from '@/components/SkuSearchAdd';
import type { OrderDot, PendingOrder } from '@/app/pending/types';
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
// PR199: thousands grouping for the price field (display only; state stores digits). Matches OrderEntry.
const fmtThousands = (digits: string): string => (digits ? Number(digits).toLocaleString('id-ID') : '');

// A line in the edit modal's buffered working copy. line_id null = a newly-added line. price is the raw
// digit string ('' = unpriced → counts as 0 in the total).
type DraftLine = { key: number; line_id: string | null; item_code: string | null; name: string; qty: number; price: string };

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
  // PR196/PR199: edit-items MODAL — a buffered working copy of the order's uncut lines; Done applies the
  // whole set (replaceOrderLines), Cancel discards. Each draft line carries a stable key for React.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false); // the add-item search is open inside the modal
  const reqRef = useRef(0);
  const draftKey = useRef(0);

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

  // PR199 — edit items MODAL. Every line here is UNCUT, so nothing moves stock; the working copy is
  // buffered and written in one call on Done (replaceOrderLines), which recomputes total + payment.
  function openEdit() {
    if (!sel) return;
    setDraft(sel.lines.map((l) => ({
      key: ++draftKey.current,
      line_id: l.line_id,
      item_code: l.item_code,
      name: l.name,
      qty: l.qty,
      price: l.unit_price_idr != null ? String(l.unit_price_idr) : '',
    })));
    setEditErr(null); setAdding(false); setEditing(true);
  }
  function patchDraft(key: number, patch: Partial<DraftLine>) {
    setDraft((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }
  function removeDraft(key: number) {
    setDraft((prev) => prev.filter((d) => d.key !== key));
  }
  function addDraft(code: string) {
    setDraft((prev) => [...prev, { key: ++draftKey.current, line_id: null, item_code: code, name: code, qty: 1, price: '' }]);
    setAdding(false);
  }
  // live total of the working copy (blank price = 0) — shown so a legacy order's total change is visible.
  const draftTotal = useMemo(() => draft.reduce((s, d) => s + d.qty * (parseInt(d.price, 10) || 0), 0), [draft]);

  async function saveEdit() {
    if (!sel) return;
    if (draft.length === 0) { setEditErr('An order must keep at least one item — use Delete order to remove it entirely.'); return; }
    if (draft.some((d) => !Number.isFinite(d.qty) || d.qty < 1)) { setEditErr('Every item needs a quantity of at least 1.'); return; }
    setEditBusy(true); setEditErr(null);
    const { error: e } = await replaceOrderLines(
      sel.sales_id,
      draft.map((d) => ({ line_id: d.line_id, item_code: d.item_code, qty: d.qty, unit_price_idr: d.price === '' ? null : (parseInt(d.price, 10) || 0) }))
    );
    if (e) { setEditErr(e); setEditBusy(false); return; }
    setEditing(false); setEditBusy(false);
    await refresh();
  }

  // reset the modal + delete-confirm when the selected order changes.
  useEffect(() => { setEditing(false); setAdding(false); setConfirmDel(false); }, [selId]);

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

              {/* Lines — compact row: image left, code / name / qty / status to its right. PR199: "Edit
                  items" opens a modal (add / remove / change qty & price) that applies on Done. */}
              <section className="fd-section">
                <div className="fd-section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Items</span>
                  <button className="btn-link" onClick={openEdit} disabled={busy}>Edit items</button>
                </div>
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

              {/* Actions — Mark as paid + Send ready items, left-aligned at the bottom. PR144: Fulfill =
                  ready AND paid, so Send ready gates on a settled balance (green-but-unpaid stays here). */}
              <div className="fd-commit">
                <div className="fd-commit-actions">
                  {sel.balance > 0 && (
                    <button className="btn-secondary" onClick={doMarkPaid} disabled={busy}>{busy ? 'Saving…' : 'Mark as paid'}</button>
                  )}
                  <button className="btn-primary" onClick={doSendReady} disabled={busy || sel.ready_count === 0 || sel.balance > 0}>
                    {busy ? 'Working…' : `Send ready items${sel.ready_count ? ` (${sel.ready_count})` : ''}`}
                  </button>
                </div>
                {sel.balance > 0 && sel.ready_count > 0 && !busy && (
                  <span className="warn-text">settle payment before sending</span>
                )}
              </div>

              {/* Delete (FP-4 / PR148 — overlay confirm) */}
              <div className="ob-return">
                <button className="btn-link pend-delete" onClick={() => { setDelErr(null); setConfirmDel(true); }} disabled={busy}>Delete order</button>
              </div>

              <div className="fd-orderid">{sel.sales_id}</div>

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

              {/* PR199 — Edit items modal (buffered; Done applies, Cancel discards). qty stepper +/−,
                  price as a plain text field, red trash per item, + Add item, live total. */}
              {editing && (
                <ConfirmModal
                  title="Edit items"
                  subtitle={`${sel.customer_name || sel.sales_id} · total updates from the item prices below`}
                  error={editErr}
                  busy={editBusy}
                  cancelLabel="Cancel"
                  confirmLabel={editBusy ? 'Saving…' : 'Done'}
                  confirmDisabled={draft.length === 0}
                  onConfirm={saveEdit}
                  onCancel={() => setEditing(false)}
                >
                  <ul className="ff-lines">
                    {draft.map((d) => (
                      <li key={d.key} className="ff-line pend-line-card">
                        <div className="pend-line" style={{ alignItems: 'center', gap: 8 }}>
                          <div className="pend-line-main" style={{ minWidth: 0, flex: 1 }}>
                            <span className="ff-code">{d.item_code || '—'}</span>
                            <span className="ff-name">{d.name}</span>
                          </div>
                          <span className="qty-step">
                            <button type="button" onClick={() => patchDraft(d.key, { qty: Math.max(1, d.qty - 1) })} disabled={d.qty <= 1} aria-label="decrease">−</button>
                            <input type="number" inputMode="numeric" min={1} value={d.qty}
                              onChange={(e) => patchDraft(d.key, { qty: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
                            <button type="button" onClick={() => patchDraft(d.key, { qty: d.qty + 1 })} aria-label="increase">+</button>
                          </span>
                          <input className="price" type="text" inputMode="numeric" placeholder="Rp price" style={{ width: 110 }}
                            value={fmtThousands(d.price)}
                            onChange={(e) => patchDraft(d.key, { price: e.target.value.replace(/\D/g, '') })} />
                          <button
                            type="button"
                            onClick={() => removeDraft(d.key)}
                            disabled={draft.length <= 1}
                            aria-label="Remove item"
                            title={draft.length <= 1 ? 'Use Delete order to remove the last item' : 'Remove item'}
                            style={{ background: '#c0392b', color: '#fff', border: 'none', borderRadius: 6, width: 30, height: 30, cursor: draft.length <= 1 ? 'not-allowed' : 'pointer', opacity: draft.length <= 1 ? 0.4 : 1, flexShrink: 0 }}
                          >🗑</button>
                        </div>
                      </li>
                    ))}
                  </ul>

                  {/* + Add item — search reuses SkuSearchAdd; a pick appends an editable row */}
                  <div style={{ marginTop: 8 }}>
                    {!adding ? (
                      <button className="btn-link" onClick={() => setAdding(true)}>+ Add item</button>
                    ) : (
                      <SkuSearchAdd
                        listed={new Set(draft.map((d) => d.item_code).filter((c): c is string => !!c))}
                        placeholder="Add item: search by code or name"
                        onSelect={addDraft}
                      />
                    )}
                  </div>

                  {/* live total of the working copy */}
                  <div className="ord-pay-grid" style={{ marginTop: 12 }}>
                    <div><span className="ord-pay-k">New total</span><span className="ord-pay-v">{fmtIDR(draftTotal)}</span></div>
                    <div><span className="ord-pay-k">Paid</span><span className="ord-pay-v">{fmtIDR(sel.paid_idr)}</span></div>
                    <div className="ord-pay-bal-col">
                      <span className="ord-pay-k">Balance</span>
                      <span className={`ord-pay-v ord-pay-bal ${Math.max(draftTotal - sel.paid_idr, 0) > 0 ? 'bal-due' : 'bal-clear'}`}>{fmtIDR(Math.max(draftTotal - sel.paid_idr, 0))}</span>
                    </div>
                  </div>
                </ConfirmModal>
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

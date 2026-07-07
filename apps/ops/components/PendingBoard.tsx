'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useUrlTab } from '@/components/useUrlTab';
import AppHeader from '@/components/AppHeader';
import { getPending, sendReadyItems, deleteOrder, markOrderPaid, addOrderLine, updateOrderLine, deleteOrderLine, setLineNote } from '@/app/pending/actions';
import DeleteOrderConfirm from '@/components/DeleteOrderConfirm';
import SearchInput from '@/components/SearchInput';
import SkuSearchAdd from '@/components/SkuSearchAdd';
import type { OrderDot, PendingOrder, PendingLine } from '@/app/pending/types';
import type { CommonNote } from '@/app/settings/types';
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

// PR224 — small inline icons for the action buttons (kept local; the codebase inlines its SVGs).
const svg = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const CoinIcon = () => (<svg {...svg}><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" /><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" /></svg>);
const ArrowIcon = () => (<svg {...svg}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>);
const TrashIcon = () => (<svg {...svg}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>);
const PencilIcon = () => (<svg {...svg}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);
const CopyIcon = () => (<svg {...svg} width={14} height={14}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>);
const CheckIcon = () => (<svg {...svg} width={14} height={14}><polyline points="20 6 9 17 4 12" /></svg>);

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
  // PR223 — the readiness sub-filter is mirrored to ?pf= so a hard Refresh keeps e.g. "To order" open.
  const [filter, setFilter] = useUrlTab<DotFilter>('pf', 'all', ['all', 'red', 'yellow', 'green']);
  const [search, setSearch] = useState(''); // PR149: filter the queue by customer, order id, or SKU
  const [loadingList, setLoadingList] = useState(false);

  const [selId, setSelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // PR148: delete goes through the overlay confirm (no bare window.confirm); its error stays in the modal.
  const [confirmDel, setConfirmDel] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  // PR224 — per-line editor OVERLAY (replaces the bulk "Edit items"): a square pencil on each row opens
  // it to change SKU / qty / price / note or delete that one line; "+ Add item" opens it in add mode.
  // All fields are drafts, committed together on Save.
  type LineEdit = { mode: 'edit'; line: PendingLine } | { mode: 'add' };
  const [lineEdit, setLineEdit] = useState<LineEdit | null>(null);
  const [leCode, setLeCode] = useState<string | null>(null); // draft item_code (edit: seeded; add: picked)
  const [leName, setLeName] = useState('');                  // display name for the current code
  const [leQty, setLeQty] = useState('1');
  const [lePrice, setLePrice] = useState('');
  const [leNote, setLeNote] = useState('');
  const [leChanging, setLeChanging] = useState(false);       // the SKU search (pick/replace) is open
  const [leBusy, setLeBusy] = useState(false);
  const [leErr, setLeErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);               // order-id copy feedback
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

  // PR224 — per-line editor. Every line shown here is UNCUT, so these ops move no stock (stock_check
  // counts only fulfilled/shipped rows); each RPC recomputes the total + payment status.
  function openLineEdit(l: PendingLine) {
    setLineEdit({ mode: 'edit', line: l });
    setLeCode(l.item_code); setLeName(l.name);
    setLeQty(String(l.qty)); setLePrice(String(l.unit_price_idr ?? 0)); setLeNote(l.line_note ?? '');
    setLeChanging(false); setLeErr(null);
  }
  function openLineAdd() {
    setLineEdit({ mode: 'add' });
    setLeCode(null); setLeName('');
    setLeQty('1'); setLePrice(''); setLeNote('');
    setLeChanging(true); setLeErr(null); // start with the SKU picker open
  }
  function closeLineEdit() { setLineEdit(null); setLeChanging(false); setLeErr(null); }

  // commit all drafted changes at once. Changing the SKU of an existing line = add the new line first
  // (so the order always keeps ≥1 active line and the old delete never hits the last-line guard), then
  // remove the old — carrying qty/price/note across.
  async function saveLineEdit() {
    if (!sel || !lineEdit) return;
    const qty = parseInt(leQty, 10);
    if (!Number.isFinite(qty) || qty < 1) { setLeErr('Quantity must be at least 1.'); return; }
    const priceN = parseInt(lePrice, 10);
    const price = Number.isFinite(priceN) ? priceN : 0;
    const note = leNote.trim() || null;
    setLeBusy(true); setLeErr(null);
    try {
      if (lineEdit.mode === 'add') {
        if (!leCode) { setLeErr('Pick a SKU first.'); setLeBusy(false); return; }
        const { error } = await addOrderLine(sel.sales_id, leCode, qty, price, note);
        if (error) { setLeErr(error); setLeBusy(false); return; }
      } else {
        const l = lineEdit.line;
        if (leCode && leCode !== l.item_code) {
          const { error: addErr } = await addOrderLine(sel.sales_id, leCode, qty, price, note);
          if (addErr) { setLeErr(addErr); setLeBusy(false); return; }
          const { error: delErr } = await deleteOrderLine(l.line_id);
          if (delErr) { setLeErr(delErr); setLeBusy(false); return; }
        } else {
          if (qty !== l.qty || price !== (l.unit_price_idr ?? 0)) {
            const { error } = await updateOrderLine(l.line_id, qty, price);
            if (error) { setLeErr(error); setLeBusy(false); return; }
          }
          if (note !== (l.line_note ?? null)) {
            try { await setLineNote(l.line_id, note); } catch { setLeErr("Couldn't save the note."); setLeBusy(false); return; }
          }
        }
      }
      await refresh();
      setLineEdit(null); setLeChanging(false);
    } finally {
      setLeBusy(false);
    }
  }

  // delete the one line being edited (guarded server-side: it refuses the order's last active line —
  // use "Delete order" for that).
  async function deleteEditedLine() {
    if (!lineEdit || lineEdit.mode !== 'edit') return;
    setLeBusy(true); setLeErr(null);
    const { error } = await deleteOrderLine(lineEdit.line.line_id);
    if (error) { setLeErr(error); setLeBusy(false); return; }
    await refresh();
    setLeBusy(false); setLineEdit(null); setLeChanging(false);
  }

  // easy-copy the order id (header chip). Best-effort — falls back silently if clipboard is blocked.
  async function copyOrderId() {
    if (!sel) return;
    try { await navigator.clipboard.writeText(sel.sales_id); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* clipboard unavailable */ }
  }

  // reset edit / delete-confirm state when the selected order changes.
  useEffect(() => { setLineEdit(null); setLeChanging(false); setConfirmDel(false); setCopied(false); }, [selId]);

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
              {/* PR224 header: customer name left, date right; the order id sits just below as a copyable chip. */}
              <div className="fd-head">
                <div className="fd-head-row">
                  <div className="fd-title fd-title-plain">{sel.customer_name || '—'}</div>
                  {sel.order_date && <span className="fd-date">{sel.order_date.slice(0, 10)}</span>}
                </div>
                <button className="fd-orderid-chip" onClick={copyOrderId} aria-label={copied ? 'Order ID copied' : 'Copy order ID'} title="Copy order ID">
                  <span className="fd-orderid-code">{sel.sales_id}</span>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
              </div>

              {/* Lines — compact row: image left, code / name / (note) / qty / status, and a square pencil
                  that opens the per-line editor (PR224). "+ Add item" below opens the same editor in add mode. */}
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
                          {l.line_note && <span className="pend-line-note">✎ {l.line_note}</span>}
                        </div>
                        <span className="ff-qty">×{l.qty}</span>
                        <span className={`pend-status ${l.status}`}>{STATUS_LABEL[l.status] ?? l.status}</span>
                        <button className="btn-edit" onClick={() => openLineEdit(l)} aria-label="Edit item" title="Edit item"><PencilIcon /></button>
                      </div>
                    </li>
                  ))}
                </ul>
                <button className="btn-secondary edit-additem" onClick={openLineAdd} disabled={busy}>+ Add item</button>
              </section>

              {/* Payment — totals only; balance right-aligned, green when clear. The settle reminder lives
                  here (next to the balance) rather than beside the send button (PR224). */}
              <section className="fd-section">
                <div className="ord-pay-grid">
                  <div><span className="ord-pay-k">Total</span><span className="ord-pay-v">{fmtIDR(sel.sales_total_idr)}</span></div>
                  <div><span className="ord-pay-k">Paid</span><span className="ord-pay-v">{fmtIDR(sel.paid_idr)}</span></div>
                  <div className="ord-pay-bal-col">
                    <span className="ord-pay-k">Balance</span>
                    <span className={`ord-pay-v ord-pay-bal ${sel.balance > 0 ? 'bal-due' : 'bal-clear'}`}>{fmtIDR(sel.balance)}</span>
                  </div>
                </div>
                {sel.balance > 0 && sel.ready_count > 0 && (
                  <div className="warn-text pay-hint">Settle the balance to send ready items.</div>
                )}
              </section>

              {/* Actions — all left-aligned with a leading icon, on one horizontally-scrollable row (PR224). */}
              <div className="fd-actions">
                {sel.balance > 0 && (
                  <button className="btn-secondary btn-ico" onClick={doMarkPaid} disabled={busy}><CoinIcon />{busy ? 'Saving…' : 'Mark as paid'}</button>
                )}
                <button className="btn-primary btn-ico" onClick={doSendReady} disabled={busy || sel.ready_count === 0 || sel.balance > 0}>
                  <ArrowIcon />{busy ? 'Working…' : `Send ready items${sel.ready_count ? ` (${sel.ready_count})` : ''}`}
                </button>
                <button className="btn-danger btn-ico" onClick={() => { setDelErr(null); setConfirmDel(true); }} disabled={busy}><TrashIcon />Delete order</button>
              </div>

              {/* PR224 — per-line editor overlay: change SKU / qty / price / note, or delete this one line. */}
              {lineEdit && sel && (
                <div className="sc-modal-backdrop" onClick={leBusy ? undefined : closeLineEdit}>
                  <div className="sc-modal" role="dialog" aria-modal="true" aria-label={lineEdit.mode === 'add' ? 'Add item' : 'Edit item'} onClick={(e) => e.stopPropagation()}>
                    <div className="sc-modal-head sc-modal-head-row">
                      <span className="sc-modal-title">{lineEdit.mode === 'add' ? 'Add item' : 'Edit item'}</span>
                      <button className="sc-modal-x" onClick={closeLineEdit} aria-label="Close" disabled={leBusy}>×</button>
                    </div>
                    <div className="sc-modal-body">
                      {leErr && <div className="validation err" style={{ marginBottom: 10 }}>{leErr}</div>}

                      <div className="fd-section-head">SKU</div>
                      {leChanging ? (
                        <SkuSearchAdd
                          listed={new Set(sel.lines.map((l) => l.item_code).filter((c): c is string => !!c && !(lineEdit.mode === 'edit' && c === lineEdit.line.item_code)))}
                          placeholder="Search by code or name"
                          onSelect={(code) => { setLeCode(code); setLeName(code); setLeChanging(false); }}
                        />
                      ) : (
                        <div className="le-sku">
                          <SkuImage status={imgMap[leCode ?? '']?.status} displayUrl={imgMap[leCode ?? '']?.displayUrl} name={leName} size={SKU_IMG.sm} />
                          <div className="le-sku-main">
                            <span className="ff-code">{leCode || '—'}</span>
                            <span className="ff-name">{leName}</span>
                          </div>
                          <button type="button" className="btn-link" onClick={() => setLeChanging(true)} disabled={leBusy}>Change</button>
                        </div>
                      )}

                      <div className="le-row">
                        <div className="le-field">
                          <label>Qty</label>
                          <span className="qty-step">
                            <button type="button" aria-label="decrease" onClick={() => setLeQty(String(Math.max(1, (parseInt(leQty, 10) || 1) - 1)))} disabled={leBusy || (parseInt(leQty, 10) || 1) <= 1}>−</button>
                            <input type="number" inputMode="numeric" min={1} aria-label="Quantity" value={leQty} onChange={(e) => setLeQty(e.target.value)} disabled={leBusy} />
                            <button type="button" aria-label="increase" onClick={() => setLeQty(String((parseInt(leQty, 10) || 1) + 1))} disabled={leBusy}>+</button>
                          </span>
                        </div>
                        <div className="le-field grow">
                          <label>Unit price (Rp)</label>
                          <input className="edit-price" type="text" inputMode="numeric" placeholder="price" value={fmtThousands(lePrice)} onChange={(e) => setLePrice(e.target.value.replace(/\D/g, ''))} disabled={leBusy} />
                        </div>
                      </div>

                      <div className="le-field le-note">
                        <label>Note <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label>
                        <input type="text" list="le-notes" placeholder="Add a note…" value={leNote} onChange={(e) => setLeNote(e.target.value)} disabled={leBusy} />
                        <datalist id="le-notes">{commonNotes.map((n) => <option key={n.id} value={n.label} />)}</datalist>
                      </div>
                    </div>
                    <div className="sc-modal-foot le-foot">
                      <button className="btn-primary" onClick={saveLineEdit} disabled={leBusy || (lineEdit.mode === 'add' && !leCode)}>{leBusy ? 'Saving…' : 'Save'}</button>
                      {lineEdit.mode === 'edit' && (
                        <button className="btn-danger btn-ico le-del" onClick={deleteEditedLine} disabled={leBusy}><TrashIcon />Delete item</button>
                      )}
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

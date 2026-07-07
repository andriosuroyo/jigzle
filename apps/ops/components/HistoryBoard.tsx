'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { volWeight } from '@jigzle/lib';
import AppHeader from '@/components/AppHeader';
import { getHistory, getHistoryYears, setOrderNote } from '@/app/history/actions';
import { getOrderSummary, deleteOrder } from '@/app/pending/actions';
import DeleteOrderConfirm from '@/components/DeleteOrderConfirm';
import type { HistoryRow, HistoryState } from '@/app/history/types';
import type { OrderSummary, BoxSummary } from '@/app/pending/types';
import type { BoxPreset } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import SearchInput from '@/components/SearchInput';
import StatusCircles, { payTone, type CircleTone } from '@/components/StatusCircles';

const STATE_LABEL: Record<HistoryState, string> = {
  cancelled: 'Cancelled',
  need_payment: 'Need payment',
  need_send: 'Need send',
  ready_to_ship: 'Ready to ship',
  complete: 'Complete',
};
const fmtIDR = (n: number | null | undefined): string => 'Rp ' + (n ?? 0).toLocaleString('id-ID');

// PR146 — the box circle's tone from the lifecycle state. History is terminal-only (PR149:
// Complete + Cancelled), so in practice: complete green, cancelled grey.
function boxToneOf(state: HistoryState): CircleTone {
  if (state === 'complete') return 'green';
  if (state === 'ready_to_ship') return 'yellow';
  return 'grey';
}

export default function HistoryBoard({
  initialOrders,
  boxPresets,
  userEmail,
  embedded = false,
  active = true,
  onCountChange,
  reloadKey = 0,
}: {
  initialOrders: HistoryRow[];
  boxPresets: BoxPreset[];
  userEmail: string;
  // JZ-001: Orders pipeline window. History is a read-only log → no onAdvance, just count + reload.
  // Settling payment is intentionally NOT here — Pending is the single gateway for that (avoids two
  // places that can drift out of sync).
  embedded?: boolean;
  // PR179: whether the History tab is the one on screen. The Sales shell no longer preloads the (huge)
  // history server-side; when this first turns true we fetch it once, so Sales opens fast on Pending.
  active?: boolean;
  onCountChange?: (n: number) => void;
  reloadKey?: number;
}) {
  // PR224 — lazy load by year: the year sub-tabs come from getHistoryYears() (cheap counts); only ONE
  // year's rows are fetched at a time (default: the current year), and other years load when their tab is
  // clicked. The search bar queries the whole log (all years) and shows a flat result list.
  const currentYear = String(new Date().getFullYear());
  const [byYear, setByYear] = useState<Record<string, HistoryRow[]>>({});
  const [loadedYears, setLoadedYears] = useState<Set<string>>(new Set());
  const [yearMeta, setYearMeta] = useState<{ year: string; count: number }[]>([]);
  const [searchRows, setSearchRows] = useState<HistoryRow[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [yearFilter, setYearFilter] = useState<string | null>(null); // the selected year sub-tab

  const [selRow, setSelRow] = useState<HistoryRow | null>(null); // the clicked row → date + derived status
  const [summary, setSummary] = useState<OrderSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // PR148: delete goes through the overlay confirm; its error stays in the modal.
  const [confirmDel, setConfirmDel] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [copiedId, setCopiedId] = useState(false); // PR165: order-number copy feedback
  const sumReqRef = useRef(0);
  const searchSeq = useRef(0);   // stale-response guard for the live search
  const firstRun = useRef(true); // skip the debounced search on mount
  const loadedRef = useRef(initialOrders.length > 0); // PR179/PR224: false until the deferred first load lands
  const selId = selRow?.sales_id ?? null;

  // Reverse-map a shipped box's stored dims → a SETTINGS preset code (XS/M2/…); 'Custom' if no exact
  // match. The box table only stores dims, not the preset, so this is a best-effort label.
  function boxType(b: BoxSummary): string {
    if (b.dim_p == null || b.dim_l == null || b.dim_t == null) return 'Custom';
    const m = boxPresets.find((p) => p.dim_p === b.dim_p && p.dim_l === b.dim_l && p.dim_t === b.dim_t);
    return m ? m.code : 'Custom';
  }

  const imgCodes = useMemo(
    () => (summary?.lines ?? []).map((l) => l.item_code).filter((c): c is string => !!c),
    [summary]
  );
  const imgMap = useSkuImages(imgCodes);

  // PR166 — courier + tracking shown as part of the ADDRESS block (as it prints during Outbound), not on
  // each item card. Collapse the per-line couriers to the distinct set (usually one) so the block reads
  // "COURIER: tracking" under the address; multiple couriers each get their own line.
  const couriers = useMemo(() => {
    const seen = new Set<string>();
    const out: { label: string | null; tracking: string | null }[] = [];
    for (const l of summary?.lines ?? []) {
      if (!l.courier_label && !l.courier_tracking) continue;
      const key = `${l.courier_label ?? ''}|${l.courier_tracking ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label: l.courier_label, tracking: l.courier_tracking });
    }
    return out;
  }, [summary]);
  const fmtCourier = (c: { label: string | null; tracking: string | null }): string =>
    c.label && c.tracking ? `${c.label}: ${c.tracking}` : c.label || c.tracking || '';

  // PR224 — year sub-tabs come from the cheap counts (getHistoryYears); the loaded/selected year is
  // always included even if the metadata lagged (e.g. only the current year has orders). Newest first.
  const isSearch = query.trim() !== '';
  const years = useMemo(() => {
    const m = new Map<string, number>();
    for (const { year, count } of yearMeta) m.set(year, count);
    for (const y of loadedYears) if (!m.has(y)) m.set(y, (byYear[y] ?? []).length);
    return [...m.entries()].sort((a, b) => {
      if (a[0] === '—') return 1;
      if (b[0] === '—') return -1;
      return a[0] < b[0] ? 1 : -1;
    });
  }, [yearMeta, loadedYears, byYear]);
  // in search mode show the flat result list (all years); otherwise the selected year's loaded rows.
  const visibleRows = useMemo(
    () => (isSearch ? searchRows : (yearFilter ? byYear[yearFilter] ?? [] : [])),
    [isSearch, searchRows, yearFilter, byYear]
  );

  // fetch one year's terminal orders (a YYYY query = a whole-year range in getHistory). Cached by year;
  // `force` refetches (used after a delete / external reload).
  async function loadYear(y: string, force = false) {
    if (!force && loadedYears.has(y)) return;
    setSearching(true);
    try {
      const rows = await getHistory(y);
      setByYear((m) => ({ ...m, [y]: rows }));
      setLoadedYears((s) => new Set(s).add(y));
    } catch {
      /* keep current on transient error */
    } finally {
      setSearching(false);
    }
  }

  // live search across the WHOLE log (all years), debounced. Empty query → back to year mode.
  async function runSearch() {
    const q = query.trim();
    if (!q) { setSearchRows([]); return; }
    const _id = ++searchSeq.current;
    setSearching(true);
    try {
      const rows = await getHistory(q);
      if (searchSeq.current === _id) setSearchRows(rows);
    } catch {
      /* keep current on transient error */
    } finally {
      if (searchSeq.current === _id) setSearching(false);
    }
  }

  // refresh whatever's on screen (year counts + the current year's rows, or the current search).
  async function reloadCurrent() {
    getHistoryYears().then(setYearMeta).catch(() => {});
    if (isSearch) await runSearch();
    else if (yearFilter) await loadYear(yearFilter, true);
  }

  // PR179/PR224: deferred first load — when the History tab first shows, pull the year list (for the
  // tabs) and load only the current year's rows (or the newest year that has any).
  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      setSearching(true);
      const meta = await getHistoryYears().catch(() => [] as { year: string; count: number }[]);
      setYearMeta(meta);
      const initYear = meta.some((m) => m.year === currentYear) ? currentYear : (meta[0]?.year ?? currentYear);
      setYearFilter(initYear);
      await loadYear(initYear, true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // JZ-001: keep the (optional) count contract; History has no shell badge but report what's shown.
  useEffect(() => { onCountChange?.(visibleRows.length); }, [visibleRows, onCountChange]);
  // external reload (e.g. a new order created in the shell): refresh the on-screen view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey && loadedRef.current) reloadCurrent(); }, [reloadKey]);
  // live search: re-query as you type, debounced. Skip the mount run.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => { runSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function startEditNote() {
    setNoteDraft(summary?.order_note ?? '');
    setEditingNote(true);
  }

  // PR165: one-tap copy of the order number, with a brief ✓ confirmation.
  async function copyOrderId() {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary.sales_id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    } catch {
      setError('Copy failed — select the order number and copy manually.');
    }
  }

  async function doSaveNote() {
    if (!summary) return;
    setSavingNote(true);
    setError(null);
    try {
      const saved = await setOrderNote(summary.sales_id, noteDraft);
      setSummary({ ...summary, order_note: saved });
      setEditingNote(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save note failed.');
    } finally {
      setSavingNote(false);
    }
  }

  // PR148: delete via delete_order — payments + shipping records go with the order; shipped units
  // stay deducted from stock (the RPC logs a compensating adjustment). Snapshot in order_delete_log.
  async function doDelete() {
    if (!summary) return;
    setDeleting(true);
    setDelErr(null);
    try {
      const { error: err } = await deleteOrder(summary.sales_id);
      if (err) { setDelErr(err); return; }
      setConfirmDel(false);
      setSuccess(`${summary.sales_id} deleted.`);
      setSelRow(null);
      setSummary(null);
      await reloadCurrent();
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  }

  async function openOrder(row: HistoryRow) {
    setError(null);
    setSuccess(null);
    setEditingNote(false);
    setSelRow(row);
    setSummary(null);
    const myReq = ++sumReqRef.current;
    setLoadingSummary(true);
    try {
      const s = await getOrderSummary(row.sales_id);
      if (sumReqRef.current === myReq) setSummary(s);
    } catch (e) {
      if (sumReqRef.current === myReq) setError(e instanceof Error ? e.message : 'Failed to load summary.');
    } finally {
      if (sumReqRef.current === myReq) setLoadingSummary(false);
    }
  }

  // PR147 — bodyview: the body shows EITHER the full-width list OR the tapped order's detail with a
  // ← back button (the Purchasing-History pattern); breadcrumb + pipeline tabs stay put above.
  const body = (
    <div className="bodyview">
      {error && <div className="validation err">{error}</div>}
      {success && <div className="validation ok">{success}</div>}

      {/* ── List ── */}
      {!selId && (
        <>
          <div className="search-row" style={{ padding: '0 0 8px' }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Search by customer ID, order ID, or SKU…" />
          </div>
          {/* Year sub-tabs (newest first, each with a count). Only the selected year's rows are loaded;
              clicking another year fetches it on demand (PR224). Hidden while searching — a search spans
              every year and shows a flat result list. */}
          {!isSearch && years.length > 0 && (
            <div className="fq-filters" role="tablist" aria-label="Filter by year">
              {years.map(([y, n]) => (
                <button
                  key={y}
                  role="tab"
                  aria-selected={yearFilter === y}
                  className={`fq-filter ${yearFilter === y ? 'active' : ''}`}
                  onClick={() => { setYearFilter(y); loadYear(y); }}
                >
                  {y}<span className="fq-filter-count">{n}</span>
                </button>
              ))}
            </div>
          )}
          {visibleRows.length === 0 && <div className="hint fq-empty">{searching ? (isSearch ? 'Searching…' : 'Loading history…') : (isSearch ? 'No match.' : 'No orders.')}</div>}
          <ul className="fq-list">
            {visibleRows.map((o) => (
              <li key={o.sales_id}>
                {/* PR146 row: customer id + date on top; state (Complete implied → no pill) + item
                    count left, dual status circles bottom-right. */}
                <button className="fq-row" onClick={() => openOrder(o)}>
                  <div className="fq-row-top">
                    <span className="fq-headline">{o.customer_name || '—'}</span>
                    <span className="ord-date">{o.order_date ? o.order_date.slice(0, 10) : '—'}</span>
                  </div>
                  <div className="fq-row-bot">
                    {o.state !== 'complete' && <span className={`ord-state ${o.state}`}>{STATE_LABEL[o.state]}</span>}
                    <span>{o.item_count} {o.item_count === 1 ? 'item' : 'items'}</span>
                    <StatusCircles box={boxToneOf(o.state)} pay={payTone(o.payment_status)} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── Detail (read-only summary + note) ── */}
      {selId && (
        <>
          <button className="btn-link bv-back" onClick={() => { setSelRow(null); setSummary(null); }}>← back</button>
          <div className="bv-detail">
          {loadingSummary && <div className="hint">Loading summary…</div>}
          {!loadingSummary && summary && (
            <>
              {/* PR144 header: customer id left, order date right; the sales id moved to the bottom. */}
              <div className="fd-head">
                <div className="fd-head-row">
                  <div className="fd-title fd-title-plain">{summary.customer_name || '—'}</div>
                  {selRow?.order_date && <span className="fd-date">{selRow.order_date.slice(0, 10)}</span>}
                </div>
              </div>

              <section className="fd-section">
                <div className="fd-section-head">Shipped items</div>
                <ul className="ff-lines">
                  {summary.lines.map((l) => (
                    <li key={l.line_id} className="ff-line pend-line">
                      <SkuImage status={imgMap[l.item_code ?? '']?.status} displayUrl={imgMap[l.item_code ?? '']?.displayUrl} name={l.name} size={SKU_IMG.sm} />
                      <div className="pend-line-main">
                        <span className="ff-code">{l.item_code || '—'}</span>
                        <span className="ff-name">{l.name}</span>
                      </div>
                      <span className="ff-qty">×{l.qty}</span>
                    </li>
                  ))}
                  {summary.lines.length === 0 && <li className="hint">No shipped lines yet.</li>}
                </ul>

                {/* Total / Paid / Status — below the shipped items, mirroring the Pending detail (PR224). */}
                <div className="ord-pay-grid" style={{ marginTop: 12 }}>
                  <div><span className="ord-pay-k">Total</span><span className="ord-pay-v">{fmtIDR(summary.sales_total_idr)}</span></div>
                  <div><span className="ord-pay-k">Paid</span><span className="ord-pay-v">{fmtIDR(summary.paid_idr)}</span></div>
                  <div className="ord-pay-status-col">
                    <span className="ord-pay-k">Status</span>
                    {selRow && <span className={`ord-state ${selRow.state}`}>{STATE_LABEL[selRow.state]}</span>}
                  </div>
                </div>

                {summary.boxes.length > 0 && (
                  <>
                    <div className="fd-section-head" style={{ marginTop: 12 }}>Boxes</div>
                    <ul className="ff-lines">
                      {summary.boxes.map((b, i) => {
                        const dims = b.dim_p != null && b.dim_l != null && b.dim_t != null
                          ? `${b.dim_p} x ${b.dim_l} x ${b.dim_t} cm`
                          : '— cm';
                        const vol = b.dim_p != null && b.dim_l != null && b.dim_t != null
                          ? Math.round(volWeight(b.dim_p, b.dim_l, b.dim_t))
                          : null;
                        return (
                          <li key={b.box_id} className="box-sum">
                            <span className="box-idx" aria-label={`Box ${i + 1}`}>{i + 1}</span>
                            <div className="box-sum-main">
                              <span className="box-sum-l1">{boxType(b)} · {dims}</span>
                              <span className="box-sum-l2">vol: {vol != null ? `${vol} g` : '—'} · real: {b.real_weight != null ? `${b.real_weight} g` : '—'}</span>
                            </div>
                            <span className="ff-qty">{b.chargeable_weight != null ? `${Math.round(b.chargeable_weight)} g` : '—'}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>

              {/* Address (PR144) — the selected address in full format: recipient, address, phone.
                  "No address selected yet" when the order has none (SA-1 deferred). */}
              <section className="fd-section">
                <div className="fd-section-head">Address</div>
                {summary.ship_address || summary.ship_recipient ? (
                  <div className="fd-addr">
                    {summary.ship_recipient && <b>{summary.ship_recipient}</b>}
                    {summary.ship_address}
                    {summary.ship_phone ? `\n${summary.ship_phone}` : ''}
                    {/* PR166: courier + tracking, blank-line spaced, as it prints during Outbound */}
                    {couriers.length > 0 ? `\n\n${couriers.map(fmtCourier).join('\n')}` : ''}
                  </div>
                ) : couriers.length > 0 ? (
                  <div className="fd-addr">{couriers.map(fmtCourier).join('\n')}</div>
                ) : (
                  <div className="hint">No address selected yet.</div>
                )}
              </section>

              {/* Note — the one editable thing on History (free text on the order). Add / edit / clear. */}
              <section className="fd-section">
                <div className="fd-section-head">Note</div>
                {!editingNote ? (
                  summary.order_note ? (
                    <p className="order-note">{summary.order_note}</p>
                  ) : (
                    <div className="hint">No note yet.</div>
                  )
                ) : (
                  <>
                    <textarea
                      className="note-input"
                      rows={3}
                      placeholder="Add a note for this order…"
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                    />
                    <div className="fd-commit-actions" style={{ marginTop: 8 }}>
                      <button className="btn-secondary" onClick={() => setEditingNote(false)} disabled={savingNote}>Cancel</button>
                      <button className="btn-primary" onClick={doSaveNote} disabled={savingNote}>{savingNote ? 'Saving…' : 'Save note'}</button>
                    </div>
                  </>
                )}
              </section>

              {/* Add/Edit note (left, brown to match "+ New order") + "Delete order" (right, text button).
                  PR224: the note button is brown and the delete carries its label. */}
              <div className="ob-return" style={{ justifyContent: 'space-between' }}>
                {!editingNote ? (
                  <button className="btn-brown btn-ico" onClick={startEditNote}>
                    {summary.order_note ? (
                      <>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                        </svg>
                        Edit note
                      </>
                    ) : '+ Add note'}
                  </button>
                ) : <span />}
                <button className="btn-danger btn-ico" onClick={() => { setDelErr(null); setConfirmDel(true); }} disabled={deleting} aria-label="Delete order">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                  Delete order
                </button>
              </div>

              {/* PR165: order number at the bottom right with a one-tap copy icon */}
              <div className="fd-orderid">
                <span>{summary.sales_id}</span>
                <button className="fd-orderid-copy" onClick={copyOrderId} aria-label="Copy order number" title="Copy order number">
                  {copiedId ? '✓ Copied' : '⧉'}
                </button>
              </div>

              {confirmDel && (
                <DeleteOrderConfirm
                  salesId={summary.sales_id}
                  lines={[
                    'The order, its payments and its shipping records are removed.',
                    'Shipped units stay deducted from stock (a compensating adjustment is logged).',
                  ]}
                  busy={deleting}
                  error={delErr}
                  onConfirm={doDelete}
                  onCancel={() => setConfirmDel(false)}
                />
              )}
            </>
          )}
          {!loadingSummary && !summary && <div className="hint">Summary not available.</div>}
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

'use client';

import { useMemo, useRef, useState } from 'react';
import { fmtRp } from '@jigzle/lib';
import type { CustomerAddress } from '@jigzle/db/types';
import AppHeader from '@/components/AppHeader';
import {
  searchCustomers,
  createCustomer,
  getLoyalty,
  getCustomerAddresses,
  createAddress,
  searchSkus,
  submitOrder,
} from '@/app/sales/actions';
import type { CustomerHit, LoyaltyReadout, SkuHit } from '@/app/sales/types';
import type { PaymentMethod } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import { addressLine } from '@/components/addressLine';

const CHANNELS = ['WHATSAPP', 'TOKOPEDIA', 'SHOPEE', 'INSTAGRAM', 'TIKTOK', 'WEBSITE', 'LINE', 'OTHER'];

type Line = { item_code: string; name: string; qty: number; unit_price_idr: number; available: number; on_the_way: number };

// Payment label (Paid/Partial/Unpaid) for the rail's Payment row. (SA-9: the dead `status` field that
// deriveStatus used to also return was dropped — only this payment label remains.)
function payLabel(total: number, paid: number): string {
  if (total > 0 && paid >= total) return 'Paid';
  if (paid > 0) return 'Partial';
  return 'Unpaid';
}

// Live, DISPLAY-ONLY readiness preview (the rail). Payment gate first, then the weakest line wins. The
// real routing (Fulfill vs Pending) is decided server-side at save by submitOrder's live re-check.
function deriveReadiness(lines: Line[], subtotal: number, paid: number): string {
  if (subtotal <= 0) return '—';
  if (paid < subtotal) return 'Need payment';
  if (lines.every((l) => l.available >= l.qty)) return 'Ready to send';
  if (lines.every((l) => l.available + l.on_the_way >= l.qty)) return 'On the way';
  return 'Need to order';
}

// Thousands separators for the price / DP inputs (display only; the state stores digits). PR24 §4.
const fmtThousands = (d: string) => d.replace(/\D/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Tint class for the rail's Status pill (mirrors the green/yellow/red pills used across Sales).
function readinessClass(r: string): string {
  switch (r) {
    case 'Ready to send': return 'ok';
    case 'On the way': return 'warn';
    case 'Need payment':
    case 'Need to order': return 'bad';
    default: return 'neutral';
  }
}

export default function OrderEntry({
  userEmail,
  paymentMethods,
  embedded = false,
  onSaved,
}: {
  userEmail: string;
  paymentMethods: PaymentMethod[];
  // JZ-001: when opened from the Orders window's "+ New order" overlay, drop the page chrome and let the
  // shell know an order was saved (so it can toast + refresh the pipeline counts).
  embedded?: boolean;
  onSaved?: (salesId: string, routed: 'fulfill' | 'pending') => void;
}) {
  // Panel 1 — customer
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [loyalty, setLoyalty] = useState<LoyaltyReadout | null>(null);
  const [custQuery, setCustQuery] = useState('');
  const [custResults, setCustResults] = useState<CustomerHit[]>([]);
  const [custSearching, setCustSearching] = useState(false);
  const [custSearched, setCustSearched] = useState(false); // a search settled → gates the "No matches" line (SA-7)
  const [showNewCust, setShowNewCust] = useState(false);
  const [ncName, setNcName] = useState('');
  const [ncPhone, setNcPhone] = useState('');
  const [ncChannel, setNcChannel] = useState(CHANNELS[0]);
  const [ncRecipient, setNcRecipient] = useState('');
  const [ncContact, setNcContact] = useState('');
  const [ncAddr, setNcAddr] = useState('');
  const [savingCust, setSavingCust] = useState(false);

  // Panel 2 — address
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [addressId, setAddressId] = useState<number | null>(null);
  const [confirmLater, setConfirmLater] = useState(false); // SA-1: defer the address to Fulfill
  const [showNewAddr, setShowNewAddr] = useState(false);
  const [naRecipient, setNaRecipient] = useState('');
  const [naContact, setNaContact] = useState('');
  const [naAddr, setNaAddr] = useState('');
  const [savingAddr, setSavingAddr] = useState(false);

  // Panel 3 — items
  const [skuQuery, setSkuQuery] = useState('');
  const [skuResults, setSkuResults] = useState<SkuHit[]>([]);
  const [skuSearching, setSkuSearching] = useState(false);
  const [skuSearched, setSkuSearched] = useState(false); // a search has settled → gates the "No results" line
  const skuInputRef = useRef<HTMLInputElement>(null);
  const [draftQty, setDraftQty] = useState<Record<string, string>>({});
  const [draftPrice, setDraftPrice] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<Line[]>([]);

  // Panel 4 — payment
  const [payMode, setPayMode] = useState<'none' | 'full' | 'dp'>('none');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState(paymentMethods[0]?.label ?? '');

  // save
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ sales_id: string; total: number; routed: 'fulfill' | 'pending'; pay: string } | null>(null);

  // ── derived totals ──
  const subtotal = useMemo(() => lines.reduce((s, l) => s + l.qty * l.unit_price_idr, 0), [lines]);
  const dpRaw = Math.max(0, parseInt(payAmount, 10) || 0);
  // SA-8: a DP is clamped to the subtotal so an over-typed DP can't inflate paid / read as overpaid.
  const paid = payMode === 'full' ? subtotal : payMode === 'dp' ? Math.min(subtotal, dpRaw) : 0;
  const dpOver = payMode === 'dp' && subtotal > 0 && dpRaw > subtotal;
  const payStatus = payLabel(subtotal, paid);
  const readiness = deriveReadiness(lines, subtotal, paid);
  const canSave = !!customer && lines.length > 0 && (addressId != null || confirmLater) && !saving;

  // SKU images for the visible items (picker results + order lines) — one batch read, lazy.
  const imgCodes = useMemo(() => [...skuResults.map((s) => s.item_code), ...lines.map((l) => l.item_code)], [skuResults, lines]);
  const imgMap = useSkuImages(imgCodes);

  // ── on-demand searches (Enter or the search button) ──
  async function runCustSearch() {
    const q = custQuery.trim();
    if (q.length < 2) { setCustResults([]); setCustSearched(false); return; }
    setCustSearching(true);
    try { setCustResults(await searchCustomers(q)); }
    catch { setCustResults([]); }
    finally { setCustSearching(false); setCustSearched(true); }
  }

  async function runSkuSearch() {
    const q = skuQuery.trim();
    // <3 matches searchSkus' real floor (the 0025 pg_trgm index needs ≥3) — short-circuit here
    // instead of round-tripping to a guaranteed [] and falsely showing "No results".
    if (q.length < 3) { setSkuResults([]); setSkuSearched(false); return; }
    setSkuSearching(true);
    try { setSkuResults(await searchSkus(q)); }
    catch { setSkuResults([]); }
    finally { setSkuSearching(false); setSkuSearched(true); }
  }

  function clearSkuSearch() {
    setSkuResults([]); setSkuQuery(''); setSkuSearched(false);
    skuInputRef.current?.focus();
  }

  // ── customer selection (SA-9: set customer ONCE, after loyalty + addresses load → no double render) ──
  async function selectCustomer(hit: CustomerHit) {
    setCustResults([]);
    setCustQuery('');
    setCustSearched(false);
    setShowNewCust(false);
    setAddressId(null);
    setConfirmLater(false);
    const [loy, addrs] = await Promise.all([getLoyalty(hit.id), getCustomerAddresses(hit.id)]);
    setLoyalty(loy);
    setCustomer({ ...hit, tier: loy.tier, lifetime_spend: loy.lifetime_spend });
    setAddresses(addrs);
    if (addrs.length === 1) setAddressId(addrs[0].address_id);
  }

  async function handleCreateCustomer() {
    if (!ncName.trim() && !ncPhone.trim()) { setError('New customer needs a name or phone.'); return; }
    if (!ncAddr.trim()) { setError('New customer needs one address.'); return; }
    setSavingCust(true);
    setError(null);
    try {
      const { customer: cust } = await createCustomer({ name: ncName, phone: ncPhone, channel: ncChannel });
      await createAddress(cust.customer_id, {
        recipient_name: ncRecipient || ncName,
        contact_phone: ncContact || ncPhone,
        raw_address: ncAddr,
      });
      const [loy, addrs] = await Promise.all([
        getLoyalty(cust.customer_id),
        getCustomerAddresses(cust.customer_id),
      ]);
      setCustomer({ id: cust.customer_id, name: cust.name, phone: cust.phone, tier: loy.tier, lifetime_spend: loy.lifetime_spend });
      setLoyalty(loy);
      setAddresses(addrs);
      setAddressId(addrs[0]?.address_id ?? null);
      setConfirmLater(false);
      setShowNewCust(false);
      setNcName(''); setNcPhone(''); setNcRecipient(''); setNcContact(''); setNcAddr('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create customer.');
    } finally {
      setSavingCust(false);
    }
  }

  // ── address ──
  async function handleCreateAddress() {
    if (!customer) return;
    if (!naAddr.trim()) { setError('Address text is required.'); return; }
    setSavingAddr(true);
    setError(null);
    try {
      const addr = await createAddress(customer.id, {
        recipient_name: naRecipient || customer.name || undefined,
        contact_phone: naContact || customer.phone || undefined,
        raw_address: naAddr,
      });
      setAddresses((prev) => [addr, ...prev]);
      setAddressId(addr.address_id);
      setConfirmLater(false);
      setShowNewAddr(false);
      setNaRecipient(''); setNaContact(''); setNaAddr('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add address.');
    } finally {
      setSavingAddr(false);
    }
  }

  // ── items ──
  function addLine(sku: SkuHit) {
    const qty = Math.max(1, parseInt(draftQty[sku.item_code] || '1', 10) || 1);
    const price = Math.max(0, parseInt(draftPrice[sku.item_code] || '', 10) || 0);
    if (price <= 0) { setError(`Enter a price for ${sku.item_code}.`); return; }
    setError(null);
    setLines((prev) => {
      const i = prev.findIndex((l) => l.item_code === sku.item_code && l.unit_price_idr === price);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + qty };
        return next;
      }
      return [...prev, { item_code: sku.item_code, name: sku.name, qty, unit_price_idr: price, available: sku.available, on_the_way: sku.on_the_way }];
    });
    setDraftQty((d) => ({ ...d, [sku.item_code]: '' }));
    setDraftPrice((d) => ({ ...d, [sku.item_code]: '' }));
    clearSkuSearch();
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  // ── save + route (SA-3): submitOrder cuts at save when everything's in stock (→ Fulfill), else the
  //    order waits in Pending. Address may be deferred (SA-1, confirmLater → address_id null). ──
  async function handleSave() {
    if (!customer || lines.length === 0 || (addressId == null && !confirmLater)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await submitOrder({
        customer_id: customer.id,
        address_id: confirmLater ? null : addressId,
        lines: lines.map((l) => ({ item_code: l.item_code, qty: l.qty, unit_price_idr: l.unit_price_idr })),
        payment: paid > 0 ? { amount_idr: paid, method: payMethod || null } : null,
      });
      setResult({ sales_id: res.sales_id, total: subtotal, routed: res.routed, pay: payStatus });
      onSaved?.(res.sales_id, res.routed); // JZ-001: notify the Orders shell (toast + count refresh)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save order.');
    } finally {
      setSaving(false);
    }
  }

  function resetAll() {
    setCustomer(null); setLoyalty(null); setCustQuery(''); setCustResults([]); setCustSearched(false); setShowNewCust(false);
    setNcName(''); setNcPhone(''); setNcChannel(CHANNELS[0]); setNcRecipient(''); setNcContact(''); setNcAddr('');
    setAddresses([]); setAddressId(null); setConfirmLater(false); setShowNewAddr(false);
    setNaRecipient(''); setNaContact(''); setNaAddr('');
    setSkuQuery(''); setSkuResults([]); setSkuSearched(false); setDraftQty({}); setDraftPrice({}); setLines([]);
    setPayMode('none'); setPayAmount(''); setPayMethod(paymentMethods[0]?.label ?? '');
    setError(null); setResult(null);
  }

  // ── success screen (SA-3: shows where the order went) ──
  if (result) {
    const routedLabel = result.routed === 'fulfill' ? 'Sent to Fulfill' : 'Waiting in Pending';
    const successBody = (
      <div className="success-wrap">
        <div className="success-card">
          <div className="success-check">✓</div>
          <h2>Order saved</h2>
          <div className="success-id">{result.sales_id}</div>
          <div className="success-rows">
            <div><span>Total</span><b>{fmtRp(result.total)}</b></div>
            <div><span>Routed</span><b>{routedLabel}</b></div>
            <div><span>Payment</span><b>{result.pay}</b></div>
          </div>
          <button className="btn-primary" onClick={resetAll}>New order</button>
        </div>
      </div>
    );
    if (embedded) return successBody;
    return (
      <div className="ops">
        <AppHeader active="orders" userEmail={userEmail} />
        {successBody}
      </div>
    );
  }

  const body = (
    <>
      <div className="ops-layout">
        <main className="ops-main">
          {error && <div className="validation err">{error}</div>}

          {/* Panel 1 — Customer */}
          <section className="panel">
            <div className="panel-head"><span className="panel-num">1</span> Customer</div>
            <div className="panel-body">
              {!customer && (
                <>
                  <div className="search-row">
                    <input
                      type="text"
                      inputMode="search"
                      placeholder="Search phone or name…"
                      value={custQuery}
                      onChange={(e) => { setCustQuery(e.target.value); setCustSearched(false); if (!e.target.value.trim()) setCustResults([]); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runCustSearch(); } }}
                    />
                    <button className="btn-secondary" onClick={runCustSearch} disabled={custSearching}>{custSearching ? '…' : 'Search'}</button>
                  </div>
                  {custSearching && <div className="hint">Searching…</div>}
                  {!custSearching && custSearched && custResults.length === 0 && (
                    <div className="hint"><em>No matches</em></div>
                  )}
                  {custResults.length > 0 && (
                    <ul className="result-list">
                      {custResults.map((c) => (
                        <li key={c.id}>
                          <button className="result-item" onClick={() => selectCustomer(c)}>
                            <span className="ri-name">{c.name || '(no name)'}</span>
                            <span className="ri-meta">
                              {c.phone || '—'}
                              {c.tier ? ` · ${c.tier}` : ''}
                              {c.lifetime_spend > 0 ? ` · ${fmtRp(c.lifetime_spend)}` : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!showNewCust && (
                    <button className="btn-secondary" onClick={() => setShowNewCust(true)}>+ New customer</button>
                  )}
                  {showNewCust && (
                    <div className="subform">
                      <input type="text" placeholder="Name" value={ncName} onChange={(e) => setNcName(e.target.value)} />
                      <input type="text" placeholder="Phone (08… / 62…)" value={ncPhone} onChange={(e) => setNcPhone(e.target.value)} />
                      <select value={ncChannel} onChange={(e) => setNcChannel(e.target.value)}>
                        {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <div className="subform-label">First address</div>
                      <input type="text" placeholder="Recipient name (leave blank if same as customer)" value={ncRecipient} onChange={(e) => setNcRecipient(e.target.value)} />
                      <input type="text" placeholder="Contact phone (leave blank if same as customer)" value={ncContact} onChange={(e) => setNcContact(e.target.value)} />
                      <textarea placeholder="Address" value={ncAddr} onChange={(e) => setNcAddr(e.target.value)} />
                      <div className="subform-actions">
                        <button className="btn-secondary" onClick={() => setShowNewCust(false)} disabled={savingCust}>Cancel</button>
                        <button className="btn-primary" onClick={handleCreateCustomer} disabled={savingCust}>
                          {savingCust ? 'Saving…' : 'Create customer'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {customer && (
                <div className="selected-customer">
                  <div className="sc-main">
                    <b>{customer.name || '(no name)'}</b>
                    <span>{customer.phone || '—'}</span>
                  </div>
                  <div className="loyalty-chip">
                    {customer.tier ? <span className={`tier tier-${customer.tier.toLowerCase()}`}>{customer.tier}</span> : <span className="tier tier-none">No tier</span>}
                    <span className="ls">{fmtRp(customer.lifetime_spend)}</span>
                    {loyalty?.to_next_tier && (
                      <span className="next">{fmtRp(loyalty.to_next_tier.remaining)} → {loyalty.to_next_tier.tier}</span>
                    )}
                  </div>
                  <button className="btn-link" onClick={() => { setCustomer(null); setLoyalty(null); setAddresses([]); setAddressId(null); setConfirmLater(false); }}>Change</button>
                </div>
              )}
            </div>
          </section>

          {/* Panel 2 — Address (SA-2 reorder: address before items) */}
          <section className={`panel ${!customer ? 'panel-locked' : ''}`}>
            <div className="panel-head"><span className="panel-num">2</span> Address</div>
            <div className="panel-body">
              <label className="addr-later">
                <input type="checkbox" checked={confirmLater} onChange={(e) => { setConfirmLater(e.target.checked); if (e.target.checked) setAddressId(null); }} disabled={!customer} />
                <span>Confirm address later (set it in Fulfill)</span>
              </label>
              {!confirmLater && (
                <>
                  {addresses.length === 0 && !showNewAddr && <div className="hint">No saved addresses — add one, or tick “confirm later”.</div>}
                  {addresses.length > 0 && (
                    <ul className="addr-list">
                      {addresses.map((a) => (
                        <li key={a.address_id}>
                          <label className={`addr-opt ${addressId === a.address_id ? 'active' : ''}`}>
                            <input type="radio" name="address" checked={addressId === a.address_id} onChange={() => setAddressId(a.address_id)} />
                            <span className="addr-text">{addressLine(a)}{a.raw_address ? <em>{a.raw_address}</em> : null}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!showNewAddr ? (
                    <button className="btn-secondary" onClick={() => setShowNewAddr(true)} disabled={!customer}>+ New address</button>
                  ) : (
                    <div className="subform">
                      <input type="text" placeholder="Recipient name (leave blank if same as customer)" value={naRecipient} onChange={(e) => setNaRecipient(e.target.value)} />
                      <input type="text" placeholder="Contact phone (leave blank if same as customer)" value={naContact} onChange={(e) => setNaContact(e.target.value)} />
                      <textarea placeholder="Address" value={naAddr} onChange={(e) => setNaAddr(e.target.value)} />
                      <div className="subform-actions">
                        <button className="btn-secondary" onClick={() => setShowNewAddr(false)} disabled={savingAddr}>Cancel</button>
                        <button className="btn-primary" onClick={handleCreateAddress} disabled={savingAddr}>{savingAddr ? 'Saving…' : 'Add address'}</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          {/* Panel 3 — Items */}
          <section className={`panel ${!customer ? 'panel-locked' : ''}`}>
            <div className="panel-head"><span className="panel-num">3</span> Items</div>
            <div className="panel-body">
              <div className="search-row">
                <input
                  ref={skuInputRef}
                  type="text"
                  inputMode="search"
                  placeholder="Code, name, or piece count…"
                  value={skuQuery}
                  onChange={(e) => { setSkuQuery(e.target.value); setSkuSearched(false); if (!e.target.value.trim()) setSkuResults([]); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSkuSearch(); } }}
                  disabled={!customer}
                />
                <button className="btn-secondary" onClick={runSkuSearch} disabled={!customer || skuSearching}>{skuSearching ? '…' : 'Search'}</button>
                {(skuQuery || skuResults.length > 0) && (
                  <button className="btn-link sku-clear" onClick={clearSkuSearch}>Clear</button>
                )}
              </div>
              {skuSearching && <div className="hint">Searching…</div>}
              {!skuSearching && skuSearched && skuResults.length === 0 && (
                <div className="hint"><em>No results</em></div>
              )}
              {skuResults.length > 0 && (
                <ul className="result-list">
                  {skuResults.map((s) => (
                    <li key={s.item_code} className="sku-result">
                      {/* Line 1: image + code + name */}
                      <div className="sku-line">
                        <SkuImage status={imgMap[s.item_code]?.status} displayUrl={imgMap[s.item_code]?.displayUrl} name={s.name} size={SKU_IMG.sm} />
                        <span className="sku-code">{s.item_code}</span>
                        <span className="sku-name">{s.name}</span>
                      </div>
                      {/* Line 2: qty × price × add — free numeric qty on every viewport (SA-6, no 50 cap) */}
                      <div className="sku-add">
                        <input className="qty" type="number" inputMode="numeric" min={1} placeholder="qty"
                          value={draftQty[s.item_code] ?? ''}
                          onChange={(e) => setDraftQty((d) => ({ ...d, [s.item_code]: e.target.value }))} />
                        {/* price: text + thousands grouping; state stores digits only (PR24 §4) */}
                        <input className="price" type="text" inputMode="numeric" placeholder="Rp price"
                          value={fmtThousands(draftPrice[s.item_code] ?? '')}
                          onChange={(e) => setDraftPrice((d) => ({ ...d, [s.item_code]: e.target.value.replace(/\D/g, '') }))} />
                        <button className="btn-secondary" onClick={() => addLine(s)}>add</button>
                      </div>
                      {/* Line 3: availability only */}
                      <span className="sku-avail">avail {s.available}</span>
                    </li>
                  ))}
                </ul>
              )}

              {lines.length > 0 && (
                <ul className="lines-list">
                  {lines.map((l, i) => (
                    <li key={`${l.item_code}-${i}`} className="line-item">
                      <SkuImage status={imgMap[l.item_code]?.status} displayUrl={imgMap[l.item_code]?.displayUrl} name={l.name} size={SKU_IMG.sm} />
                      <div className="li-main">
                        <span className="li-code">{l.item_code}</span>
                        <span className="li-name">{l.name}</span>
                        <span className={`li-avail ${l.available > 0 ? '' : 'li-avail-zero'}`}>available {l.available}</span>
                      </div>
                      <div className="li-right">
                        <span className="li-qty">{l.qty}×</span>
                        <span className="li-total">{fmtRp(l.qty * l.unit_price_idr)}</span>
                        <button className="li-remove-text" onClick={() => removeLine(i)}>remove</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* Panel 4 — Payment */}
          <section className={`panel ${!customer ? 'panel-locked' : ''}`}>
            <div className="panel-head"><span className="panel-num">4</span> Payment</div>
            <div className="panel-body">
              <div className="pay-toggle">
                <button className={payMode === 'none' ? 'active' : ''} onClick={() => setPayMode('none')}>None</button>
                <button className={payMode === 'full' ? 'active' : ''} onClick={() => setPayMode('full')}>Full</button>
                <button className={payMode === 'dp' ? 'active' : ''} onClick={() => setPayMode('dp')}>DP</button>
              </div>
              {payMode === 'dp' && (
                <>
                  <input className="pay-amount" type="text" inputMode="numeric" placeholder="DP amount (Rp)" value={fmtThousands(payAmount)} onChange={(e) => setPayAmount(e.target.value.replace(/\D/g, ''))} />
                  {dpOver && <div className="hint">DP capped at the subtotal ({fmtRp(subtotal)}) — use Full for a full payment.</div>}
                </>
              )}
              {payMode === 'full' && <div className="hint">Full payment: {fmtRp(subtotal)}</div>}
              {payMode !== 'none' && (
                paymentMethods.length === 0 ? (
                  <div className="hint">No payment methods — add them in Settings.</div>
                ) : (
                  <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                    {paymentMethods.map((m) => <option key={m.id} value={m.label}>{m.label}</option>)}
                  </select>
                )
              )}
            </div>
          </section>
        </main>

        {/* Sticky summary rail */}
        <aside className="ops-rail">
          <div className="rail-card">
            <div className="rail-title">Order summary</div>
            <div className="rail-row"><span>Customer</span><b>{customer?.name || '—'}</b></div>
            <div className="rail-sep" />
            <div className="rail-row"><span>Subtotal</span><b>{fmtRp(subtotal)}</b></div>
            <div className="rail-row"><span>Paid</span><b>{fmtRp(paid)}</b></div>
            <div className="rail-sep" />
            <div className="rail-row"><span>Status</span><span className={`rail-pill ${readinessClass(readiness)}`}>{readiness}</span></div>
            <div className="rail-row"><span>Payment</span><span className={`pay pay-${payStatus.toLowerCase()}`}>{payStatus}</span></div>
            <button className="btn-primary rail-save" onClick={handleSave} disabled={!canSave}>
              {saving ? 'Saving…' : 'Save order'}
            </button>
            {!canSave && !saving && (
              <div className="rail-hint">
                {!customer ? 'Pick a customer' : lines.length === 0 ? 'Add at least one line' : (addressId == null && !confirmLater) ? 'Pick an address or tick “confirm later”' : ''}
              </div>
            )}
          </div>
        </aside>
      </div>
    </>
  );

  if (embedded) return body;
  return (
    <div className="ops">
      <AppHeader active="orders" userEmail={userEmail} />
      {body}
    </div>
  );
}

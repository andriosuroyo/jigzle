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
  createOrder,
} from '@/app/sales/actions';
import type { CustomerHit, LoyaltyReadout, SkuHit } from '@/app/sales/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const CHANNELS = ['WHATSAPP', 'TOKOPEDIA', 'SHOPEE', 'INSTAGRAM', 'TIKTOK', 'WEBSITE', 'LINE', 'OTHER'];
const METHODS = ['BCA', 'Shopee', 'Tokopedia', 'Mandiri', 'Deposit', 'Website', 'Cash', 'Socmed'];
const QTY_OPTIONS = Array.from({ length: 50 }, (_, i) => i + 1); // mobile qty dropdown

type Line = { item_code: string; name: string; qty: number; unit_price_idr: number; available: number; on_the_way: number };

// Payment state (Paid/Partial/Unpaid) for the rail's Payment row. The status field is the legacy D5
// preview; the rail/success Status row now uses deriveReadiness() instead (PR24 §1.9).
function deriveStatus(total: number, paid: number): { status: string; pay: string } {
  if (total > 0 && paid >= total) return { status: 'Need send', pay: 'Paid' };
  if (paid > 0) return { status: 'Need payment', pay: 'Partial' };
  return { status: 'Need payment', pay: 'Unpaid' };
}

// Live, DISPLAY-ONLY readiness label (PR24 §1.9). Payment gate first, then the weakest line wins.
// Never stored — create_order's orders.status is untouched.
function deriveReadiness(lines: Line[], subtotal: number, paid: number): string {
  if (subtotal <= 0) return '—';
  if (paid < subtotal) return 'Need payment';
  if (lines.every((l) => l.available >= l.qty)) return 'Ready to send';
  if (lines.every((l) => l.available + l.on_the_way >= l.qty)) return 'On the way';
  return 'Need to order';
}

// Thousands separators for the price / DP inputs (display only; the state stores digits). PR24 §4.
const fmtThousands = (d: string) => d.replace(/\D/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function addressLine(a: CustomerAddress): string {
  return (
    a.recipient_name ||
    a.address_label ||
    [a.raw_address, a.kota].filter(Boolean).join(' · ') ||
    `Address #${a.address_id}`
  );
}

export default function OrderEntry({ userEmail }: { userEmail: string }) {
  // Panel 1 — customer
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [loyalty, setLoyalty] = useState<LoyaltyReadout | null>(null);
  const [custQuery, setCustQuery] = useState('');
  const [custResults, setCustResults] = useState<CustomerHit[]>([]);
  const [custSearching, setCustSearching] = useState(false);
  const [showNewCust, setShowNewCust] = useState(false);
  const [ncName, setNcName] = useState('');
  const [ncPhone, setNcPhone] = useState('');
  const [ncChannel, setNcChannel] = useState(CHANNELS[0]);
  const [ncRecipient, setNcRecipient] = useState('');
  const [ncContact, setNcContact] = useState('');
  const [ncAddr, setNcAddr] = useState('');
  const [savingCust, setSavingCust] = useState(false);

  // Panel 3 — address
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [addressId, setAddressId] = useState<number | null>(null);
  const [showNewAddr, setShowNewAddr] = useState(false);
  const [naRecipient, setNaRecipient] = useState('');
  const [naContact, setNaContact] = useState('');
  const [naAddr, setNaAddr] = useState('');
  const [savingAddr, setSavingAddr] = useState(false);

  // Panel 2 — items
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
  const [payMethod, setPayMethod] = useState(METHODS[0]);

  // Panel 5 — save
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ sales_id: string; total: number; status: string; pay: string } | null>(null);

  // ── derived totals ──
  const subtotal = useMemo(() => lines.reduce((s, l) => s + l.qty * l.unit_price_idr, 0), [lines]);
  const paid = payMode === 'full' ? subtotal : payMode === 'dp' ? Math.max(0, parseInt(payAmount, 10) || 0) : 0;
  const status = deriveStatus(subtotal, paid);          // .pay → the rail's Payment row
  const readiness = deriveReadiness(lines, subtotal, paid); // → the rail/success Status row (PR24 §1.9)
  const canSave = !!customer && lines.length > 0 && addressId != null && !saving;

  // SKU images for the visible items (picker results + order lines) — one batch read, lazy.
  const imgCodes = useMemo(() => [...skuResults.map((s) => s.item_code), ...lines.map((l) => l.item_code)], [skuResults, lines]);
  const imgMap = useSkuImages(imgCodes);

  // ── on-demand searches (Enter or the search button) — no live debounce, so results only
  //    refresh when asked. searchSkus/searchCustomers rank an exact match to the very top. ──
  async function runCustSearch() {
    const q = custQuery.trim();
    if (q.length < 2) { setCustResults([]); return; }
    setCustSearching(true);
    try { setCustResults(await searchCustomers(q)); }
    catch { setCustResults([]); }
    finally { setCustSearching(false); }
  }

  async function runSkuSearch() {
    const q = skuQuery.trim();
    // <3 matches searchSkus' real floor (the 0025 pg_trgm index needs ≥3) — so a 2-char query
    // short-circuits here instead of round-tripping to a guaranteed [] and falsely showing "No results".
    if (q.length < 3) { setSkuResults([]); setSkuSearched(false); return; }
    setSkuSearching(true);
    try { setSkuResults(await searchSkus(q)); }
    catch { setSkuResults([]); }
    finally { setSkuSearching(false); setSkuSearched(true); }
  }

  // Reset the Items search to a blank, focused field (after an add, or the manual Clear link). PR24 §5.
  function clearSkuSearch() {
    setSkuResults([]); setSkuQuery(''); setSkuSearched(false);
    skuInputRef.current?.focus();
  }

  // ── customer selection ──
  async function selectCustomer(hit: CustomerHit) {
    setCustomer(hit);
    setCustResults([]);
    setCustQuery('');
    setShowNewCust(false);
    setAddressId(null);
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
      // Merge only when the SAME item is re-added at the SAME price (just bump qty). A
      // different price becomes its own line — never silently re-price already-added units.
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
    clearSkuSearch(); // start the next SKU from a blank, focused search (Andrio's request, PR24 §5)
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  // ── save ──
  async function handleSave() {
    if (!customer || !addressId || lines.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const { sales_id } = await createOrder({
        customer_id: customer.id,
        address_id: addressId,
        lines: lines.map((l) => ({ item_code: l.item_code, qty: l.qty, unit_price_idr: l.unit_price_idr })),
        payment: paid > 0 ? { amount_idr: paid, method: payMethod } : null,
      });
      setResult({ sales_id, total: subtotal, status: readiness, pay: status.pay });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save order.');
    } finally {
      setSaving(false);
    }
  }

  function resetAll() {
    setCustomer(null); setLoyalty(null); setCustQuery(''); setCustResults([]); setShowNewCust(false);
    setNcName(''); setNcPhone(''); setNcChannel(CHANNELS[0]); setNcRecipient(''); setNcContact(''); setNcAddr('');
    setAddresses([]); setAddressId(null); setShowNewAddr(false);
    setNaRecipient(''); setNaContact(''); setNaAddr('');
    setSkuQuery(''); setSkuResults([]); setSkuSearched(false); setDraftQty({}); setDraftPrice({}); setLines([]);
    setPayMode('none'); setPayAmount(''); setPayMethod(METHODS[0]);
    setError(null); setResult(null);
  }

  // ── success screen ──
  if (result) {
    return (
      <div className="ops">
        <AppHeader active="sales" userEmail={userEmail} />
        <div className="success-wrap">
          <div className="success-card">
            <div className="success-check">✓</div>
            <h2>Order saved</h2>
            <div className="success-id">{result.sales_id}</div>
            <div className="success-rows">
              <div><span>Total</span><b>{fmtRp(result.total)}</b></div>
              <div><span>Status</span><b>{result.status}</b></div>
              <div><span>Payment</span><b>{result.pay}</b></div>
            </div>
            <button className="btn-primary" onClick={resetAll}>New order</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ops">
      <AppHeader active="sales" userEmail={userEmail} />

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
                      onChange={(e) => { setCustQuery(e.target.value); if (!e.target.value.trim()) setCustResults([]); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runCustSearch(); } }}
                    />
                    <button className="btn-secondary" onClick={runCustSearch} disabled={custSearching}>{custSearching ? '…' : 'Search'}</button>
                  </div>
                  {custSearching && <div className="hint">Searching…</div>}
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
                  <button className="btn-link" onClick={() => { setCustomer(null); setLoyalty(null); setAddresses([]); setAddressId(null); }}>Change</button>
                </div>
              )}
            </div>
          </section>

          {/* Panel 2 — Items */}
          <section className={`panel ${!customer ? 'panel-locked' : ''}`}>
            <div className="panel-head"><span className="panel-num">2</span> Items</div>
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
                      {/* Line 2: qty × price × add */}
                      <div className="sku-add">
                        {/* qty: dropdown on mobile, freestyle on desktop (same draftQty state) */}
                        <select className="qty qty-mobile"
                          value={draftQty[s.item_code] ?? ''}
                          onChange={(e) => setDraftQty((d) => ({ ...d, [s.item_code]: e.target.value }))}>
                          <option value="">qty</option>
                          {QTY_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <input className="qty qty-desktop" type="number" inputMode="numeric" min={1} placeholder="qty"
                          value={draftQty[s.item_code] ?? ''}
                          onChange={(e) => setDraftQty((d) => ({ ...d, [s.item_code]: e.target.value }))} />
                        {/* price: text + thousands grouping; state stores digits only (PR24 §4) */}
                        <input className="price" type="text" inputMode="numeric" placeholder="Rp price"
                          value={fmtThousands(draftPrice[s.item_code] ?? '')}
                          onChange={(e) => setDraftPrice((d) => ({ ...d, [s.item_code]: e.target.value.replace(/\D/g, '') }))} />
                        <button className="btn-secondary" onClick={() => addLine(s)}>add</button>
                      </div>
                      {/* Line 3: availability only (no "low" amber). Future: "preorder OK" once the auto-scrape lands. */}
                      <span className="sku-avail">avail {s.available}</span>
                    </li>
                  ))}
                </ul>
              )}

              {lines.length > 0 && (
                <ul className="lines-list">
                  {lines.map((l, i) => (
                    <li key={`${l.item_code}-${i}`} className="line-item">
                      <SkuImage status={imgMap[l.item_code]?.status} displayUrl={imgMap[l.item_code]?.displayUrl} name={l.name} size={SKU_IMG.md} />
                      <div className="li-main">
                        <span className="li-code">{l.item_code}</span>
                        <span className="li-name">{l.name}</span>
                        {/* per-line "low" amber dropped (PR24 §3) — the rail Status readiness label is the short-stock signal now */}
                        <span className="li-avail">avail {l.available}</span>
                      </div>
                      <div className="li-right">
                        <span className="li-qty">{l.qty}×</span>
                        <span className="li-total">{fmtRp(l.qty * l.unit_price_idr)}</span>
                      </div>
                      <button className="li-remove" onClick={() => removeLine(i)} aria-label="remove">×</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* Panel 3 — Address */}
          <section className={`panel ${!customer ? 'panel-locked' : ''}`}>
            <div className="panel-head"><span className="panel-num">3</span> Address</div>
            <div className="panel-body">
              {addresses.length === 0 && !showNewAddr && <div className="hint">No saved addresses — add one.</div>}
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
                <input className="pay-amount" type="text" inputMode="numeric" placeholder="DP amount (Rp)" value={fmtThousands(payAmount)} onChange={(e) => setPayAmount(e.target.value.replace(/\D/g, ''))} />
              )}
              {payMode === 'full' && <div className="hint">Full payment: {fmtRp(subtotal)}</div>}
              {payMode !== 'none' && (
                <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                  {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              )}
            </div>
          </section>
        </main>

        {/* Sticky summary rail */}
        <aside className="ops-rail">
          <div className="rail-card">
            <div className="rail-title">Order summary</div>
            <div className="rail-row"><span>Customer</span><b>{customer?.name || '—'}</b></div>
            <div className="rail-row"><span>Tier</span><b>{customer?.tier || '—'}</b></div>
            <div className="rail-sep" />
            <div className="rail-row"><span>Subtotal</span><b>{fmtRp(subtotal)}</b></div>
            <div className="rail-row"><span>Paid</span><b>{fmtRp(paid)}</b></div>
            <div className="rail-sep" />
            <div className="rail-row"><span>Status</span><b>{readiness}</b></div>
            <div className="rail-row"><span>Payment</span><b>{status.pay}</b></div>
            <button className="btn-primary rail-save" onClick={handleSave} disabled={!canSave}>
              {saving ? 'Saving…' : 'Save order'}
            </button>
            {!canSave && !saving && (
              <div className="rail-hint">
                {!customer ? 'Pick a customer' : lines.length === 0 ? 'Add at least one line' : addressId == null ? 'Pick an address' : ''}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

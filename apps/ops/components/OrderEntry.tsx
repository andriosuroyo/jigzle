'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { customerLabel, fmtRp, fmtRpCompact, formatPhoneDisplay } from '@jigzle/lib';
import type { CustomerAddress } from '@jigzle/db/types';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import {
  searchCustomers,
  createCustomer,
  getLoyalty,
  getCustomerAddresses,
  createAddress,
  searchSkus,
  submitOrder,
} from '@/app/sales/actions';
import type { CustomerHit, LoyaltyReadout, SkuHit, Urgency } from '@/app/sales/types';
import type { PaymentMethod, ChannelOption } from '@/app/settings/types';
import SkuImage from '@/components/SkuImage';
import { UserIcon, MapPinIcon } from '@/components/AddIcons';
import IconSelect from '@/components/IconSelect';
import PhoneCountrySelect from '@/components/PhoneCountrySelect';
import CountrySelect from '@/components/CountrySelect';
import { dialOf } from '@/components/countries';
import { useSkuImages } from '@/components/useSkuImages';
import { saveDraft, loadDraft, clearDraft } from '@/components/draftStore';
import { SKU_IMG } from '@/components/skuImageSizes';
import { addressLine } from '@/components/addressLine';
import PostcodeAutofill from '@/components/PostcodeAutofill';
import SearchInput from '@/components/SearchInput';
import StockStats from '@/components/StockStats';
import { loadPostal, type PostalData } from '@/lib/idPostal';
import { collapseRegionDuplicates, normalizeProvince } from '@/app/customers/types';
import { locationWarning, previewRawAddress } from '@/components/addressForm';
import { tidyAddress, validateAddress, type TidyResult } from '@/lib/tidyAddress';

// PR73: buy-priority options — low / mid / high → green / yellow / red. Shared visual language with the
// Purchasing To-buy cards. Optional (an order may carry no urgency).
const URGENCY_OPTS: { key: Urgency; label: string }[] = [
  { key: 'low', label: 'Low' },
  { key: 'mid', label: 'Mid' },
  { key: 'high', label: 'High' },
];

type Line = { item_code: string; name: string; qty: number; unit_price_idr: number; available: number; on_the_way: number };

// PR260 — the persisted "new order" draft: the typed/selected content only (server-loaded loyalty +
// addresses are re-fetched from the customer id on restore). One draft per operator (create-only, no
// order id exists until save), namespaced by email so a shared browser profile doesn't collide.
type OrderDraft = {
  customer: CustomerHit | null;
  addressId: number | null;
  confirmLater: boolean;
  lines: Line[];
  payMode: 'none' | 'full' | 'dp';
  payAmount: string;
  payMethod: string;
  urgency: Urgency | null;
};

// PR194: the ID-specific geo fields (autofill / kecamatan / kelurahan) only apply to Indonesian
// addresses — hidden for an international ship-to, whose negara then drives the export flow (Fulfill).
const isIndonesia = (c: string | null | undefined) => (c ?? '').trim().toLowerCase() === 'indonesia';

// Payment label (Paid/Partial/Unpaid) for the rail's Payment row. (SA-9: the dead `status` field that
// deriveStatus used to also return was dropped — only this payment label remains.)
function payLabel(total: number, paid: number): string {
  if (total > 0 && paid >= total) return 'Paid';
  if (paid > 0) return 'Partial';
  return 'Unpaid';
}

// Live, DISPLAY-ONLY readiness preview (the rail). PR144: item readiness first (mirrors the Pending
// dot — the weakest line wins), then the payment gate. The real routing (Fulfill vs Pending) is
// decided server-side at save by submitOrder's live re-check.
function deriveReadiness(lines: Line[], subtotal: number, paid: number): string {
  if (subtotal <= 0) return '—';
  if (!lines.every((l) => l.available + l.on_the_way >= l.qty)) return 'Need to order';
  if (!lines.every((l) => l.available >= l.qty)) return 'On the way';
  if (paid < subtotal) return 'Need payment';
  return 'Ready to send';
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
  channelOptions,
  embedded = false,
  onSaved,
  onDirtyChange,
}: {
  userEmail: string;
  paymentMethods: PaymentMethod[];
  // PR159 — Settings-driven contact-channel pick-list (same source as the Customer detail's Channels).
  channelOptions: ChannelOption[];
  // JZ-001: when opened from the Orders window's "+ New order" bodyview, drop the page chrome and let
  // the shell know an order was saved (so it can toast + refresh the pipeline counts).
  embedded?: boolean;
  onSaved?: (salesId: string, routed: 'fulfill' | 'pending') => void;
  // PR147: report whether un-saved input exists (customer picked / lines added) so the shell's ← back
  // can confirm before discarding a draft. A saved order (result screen) is not dirty.
  onDirtyChange?: (dirty: boolean) => void;
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
  const [ncCountry, setNcCountry] = useState('ID'); // PR159 — phone country (flag + dial code); default Indonesia
  const [ncPhone, setNcPhone] = useState('');        // local number as typed (leading 0 dropped at save)
  const [ncChannel, setNcChannel] = useState('');    // channel platform (— pick —), from channelOptions
  const [ncHandle, setNcHandle] = useState('');      // channel handle (username / number)
  const [savingCust, setSavingCust] = useState(false);
  // PR339 — the New-customer overlay: a form step, or a "Customer ID already exists" step listing the
  // existing record(s) (pick one, or ← back to enter a different ID). `ncError` is scoped to the overlay.
  const [ncStep, setNcStep] = useState<'form' | 'conflict'>('form');
  const [ncConflicts, setNcConflicts] = useState<CustomerHit[]>([]);
  const [ncError, setNcError] = useState<string | null>(null);

  function openNewCust() { setNcStep('form'); setNcError(null); setShowNewCust(true); }
  function closeNewCust() {
    setShowNewCust(false); setNcStep('form'); setNcConflicts([]); setNcError(null);
    setNcName(''); setNcPhone(''); setNcCountry('ID'); setNcChannel(''); setNcHandle('');
  }

  // channel platform options for the new-customer picker (icon + label), from Settings → Customer → Channel
  const channelSelectOptions = channelOptions.map((c) => ({ value: c.label, label: c.label, icon: c.icon }));

  // Panel 2 — address
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [addressId, setAddressId] = useState<number | null>(null);
  const [confirmLater, setConfirmLater] = useState(false); // SA-1: defer the address to Fulfill
  const [showNewAddr, setShowNewAddr] = useState(false);
  const [naRecipient, setNaRecipient] = useState('');
  const [naContact, setNaContact] = useState('');
  const [naAddr, setNaAddr] = useState('');
  const [savingAddr, setSavingAddr] = useState(false);
  const [tidying, setTidying] = useState(false);
  const [tidy, setTidy] = useState<TidyResult | null>(null); // non-null → confirm overlay is open
  const [postal, setPostal] = useState<PostalData | null>(null); // for live re-validation on edit
  const [tidyInfo, setTidyInfo] = useState<string[]>([]); // one-time notes (e.g. postcode override)

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

  // Panel 5 — urgency (PR73, optional buy-priority)
  const [urgency, setUrgency] = useState<Urgency | null>(null);

  // save
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ sales_id: string; total: number; routed: 'fulfill' | 'pending'; pay: string } | null>(null);

  // Stale-response guards: each search bumps its seq at the start; a settled response only commits if it's
  // still the latest (debounced typing can fire several overlapping requests).
  const custSeq = useRef(0);
  const skuSeq = useRef(0);

  // PR147: dirty = anything entered and not yet saved (the shell's ← back confirms before discarding).
  useEffect(() => {
    onDirtyChange?.(!result && (!!customer || lines.length > 0));
  }, [customer, lines, result, onDirtyChange]);

  // ── PR260 — draft persistence: survive a reload (a deploy force-reloading the tab, PWA relaunch,
  // the Refresh button) without losing an in-progress order. `hydratingRef` starts true so the persist
  // effect can't clear the saved draft before the restore below runs. ──
  const draftKey = `jz:sales:draft:neworder:${userEmail || '_'}`;
  const hydratingRef = useRef(true);
  const [restored, setRestored] = useState(false);

  // restore once on mount (this screen is create-only and mounts fresh on a hard reload)
  useEffect(() => {
    const draft = loadDraft<OrderDraft>(draftKey);
    if (!draft || (!draft.customer && (draft.lines?.length ?? 0) === 0)) { hydratingRef.current = false; return; }
    (async () => {
      setCustomer(draft.customer);
      setLines(draft.lines ?? []);
      setPayMode(draft.payMode ?? 'none');
      setPayAmount(draft.payAmount ?? '');
      setPayMethod(draft.payMethod || (paymentMethods[0]?.label ?? ''));
      setConfirmLater(!!draft.confirmLater);
      setUrgency(draft.urgency ?? null);
      // re-load the customer's server data (loyalty + addresses) so the saved addressId resolves
      if (draft.customer) {
        try {
          const [loy, addrs] = await Promise.all([getLoyalty(draft.customer.id), getCustomerAddresses(draft.customer.id)]);
          setLoyalty(loy);
          setAddresses(addrs);
        } catch { /* best-effort — the picker still works */ }
      }
      setAddressId(draft.addressId ?? null);
      setRestored(true);
      hydratingRef.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist the typed/selected content as it changes (skipped while hydrating; cleared once not dirty)
  useEffect(() => {
    if (hydratingRef.current) return;
    if (!result && (!!customer || lines.length > 0)) {
      saveDraft<OrderDraft>(draftKey, { customer, addressId, confirmLater, lines, payMode, payAmount, payMethod, urgency });
    } else {
      clearDraft(draftKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer, addressId, confirmLater, lines, payMode, payAmount, payMethod, urgency, result]);

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

  // ── live searches (debounced as you type — see the effects below) ──
  async function runCustSearch() {
    const _id = ++custSeq.current;
    const q = custQuery.trim();
    if (q.length < 2) { setCustResults([]); setCustSearched(false); return; }
    setCustSearching(true);
    try {
      const hits = await searchCustomers(q);
      if (custSeq.current !== _id) return; // a newer keystroke superseded this request
      setCustResults(hits); setCustSearching(false); setCustSearched(true);
    } catch {
      if (custSeq.current !== _id) return;
      setCustResults([]); setCustSearching(false); setCustSearched(true);
    }
  }

  // PR156: session-local result cache — repeating/backspacing a query renders instantly instead of
  // re-hitting the server (the roundtrip is what made the search feel heavy on mobile data).
  const skuCache = useRef(new Map<string, SkuHit[]>());

  async function runSkuSearch() {
    const _id = ++skuSeq.current;
    const q = skuQuery.trim();
    // <3 matches searchSkus' real floor (the 0025 pg_trgm index needs ≥3) — short-circuit here
    // instead of round-tripping to a guaranteed [] and falsely showing "No results".
    if (q.length < 3) { setSkuResults([]); setSkuSearched(false); return; }
    const cached = skuCache.current.get(q.toLowerCase());
    if (cached) { setSkuResults(cached); setSkuSearching(false); setSkuSearched(true); return; }
    setSkuSearching(true);
    try {
      const hits = await searchSkus(q);
      if (skuSeq.current !== _id) return; // a newer keystroke superseded this request
      skuCache.current.set(q.toLowerCase(), hits);
      setSkuResults(hits); setSkuSearching(false); setSkuSearched(true);
    } catch {
      if (skuSeq.current !== _id) return;
      setSkuResults([]); setSkuSearching(false); setSkuSearched(true);
    }
  }

  // Debounced auto-search: fire 220ms after typing stops, clearing below the floor.
  useEffect(() => {
    const q = custQuery.trim();
    if (q.length < 2) { setCustResults([]); setCustSearching(false); return; }
    const t = setTimeout(() => { runCustSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custQuery]);

  useEffect(() => {
    const q = skuQuery.trim();
    if (q.length < 3) { setSkuResults([]); setSkuSearching(false); return; }
    const t = setTimeout(() => { runSkuSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skuQuery]);

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
    // PR339 — Customer ID is required; phone is optional (many marketplaces don't share a number).
    if (!ncName.trim()) { setNcError('Customer ID is required.'); return; }
    setSavingCust(true);
    setNcError(null);
    try {
      // PR159 — combine the picked country's dial code with the local number (leading 0s dropped),
      // e.g. ID (+62) + "081260002889" → "6281260002889". Empty local number → no phone.
      const local = ncPhone.replace(/\D/g, '').replace(/^0+/, '');
      const fullPhone = local ? `${dialOf(ncCountry)}${local}` : '';
      const channels = ncChannel ? [{ platform: ncChannel, handle: ncHandle.trim() }] : [];
      // step 1 creates the customer only — the address is added in step 2 (below).
      const res = await createCustomer({ name: ncName, phone: fullPhone, channel: ncChannel, channels });
      // PR339 — the composed Customer ID already exists → show the existing record(s) to pick or go back.
      if ('conflict' in res) {
        setNcConflicts(res.conflict.map((c) => ({ id: c.customer_id, name: c.name, phone: c.phone, tier: null, lifetime_spend: 0 })));
        setNcStep('conflict');
        return;
      }
      const cust = res.customer;
      const [loy, addrs] = await Promise.all([
        getLoyalty(cust.customer_id),
        getCustomerAddresses(cust.customer_id),
      ]);
      setCustomer({ id: cust.customer_id, name: cust.name, phone: cust.phone, tier: loy.tier, lifetime_spend: loy.lifetime_spend });
      setLoyalty(loy);
      setAddresses(addrs);
      setAddressId(addrs[0]?.address_id ?? null);
      setConfirmLater(false);
      closeNewCust();
    } catch (e) {
      setNcError(e instanceof Error ? e.message : 'Failed to create customer.');
    } finally {
      setSavingCust(false);
    }
  }

  // ── address: paste a free-text blob → tidy into structured fields → confirm overlay → save ──
  async function handleTidyAddress() {
    if (!customer) return;
    if (!naAddr.trim()) { setError('Address text is required.'); return; }
    setTidying(true);
    setError(null);
    try {
      const data = await loadPostal();
      const result = tidyAddress(naAddr, { recipient: naRecipient || customer.name, phone: naContact || customer.phone }, data);
      // separate one-time info (e.g. "used ward postcode …") from live chain-validation warnings
      const chain = validateAddress(result, data);
      setTidyInfo(result.warnings.filter((wm) => !chain.includes(wm)));
      setPostal(data);
      setTidy(result);
      setShowNewAddr(false); // PR343 — hand off from the blob overlay to the Confirm-address overlay
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read the address.');
    } finally {
      setTidying(false);
    }
  }

  async function handleConfirmAddress() {
    if (!customer || !tidy) return;
    setSavingAddr(true);
    setError(null);
    try {
      const addr = await createAddress(customer.id, {
        recipient_name: tidy.recipient_name || customer.name || undefined,
        contact_phone: tidy.contact_phone || customer.phone || undefined,
        street: tidy.street || undefined,
        kelurahan: tidy.kelurahan || undefined,
        kecamatan: tidy.kecamatan || undefined,
        kota: tidy.kota || undefined,
        provinsi: tidy.provinsi || undefined,
        negara: tidy.negara || undefined,
        kode_pos: tidy.kode_pos || undefined,
        delivery_note: tidy.delivery_note || undefined,
        source_blob: naAddr, // preserve the operator's original paste
      });
      setAddresses((prev) => [addr, ...prev]);
      setAddressId(addr.address_id);
      setConfirmLater(false);
      setShowNewAddr(false);
      setTidy(null);
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
        urgency,
        lines: lines.map((l) => ({ item_code: l.item_code, qty: l.qty, unit_price_idr: l.unit_price_idr })),
        payment: paid > 0 ? { amount_idr: paid, method: payMethod || null } : null,
      });
      setResult({ sales_id: res.sales_id, total: subtotal, routed: res.routed, pay: payStatus });
      clearDraft(draftKey); // PR260 — order committed; drop its draft so it can't be restored later
      setRestored(false);
      onSaved?.(res.sales_id, res.routed); // JZ-001: notify the Orders shell (toast + count refresh)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save order.');
    } finally {
      setSaving(false);
    }
  }

  function resetAll() {
    setCustomer(null); setLoyalty(null); setCustQuery(''); setCustResults([]); setCustSearched(false); setShowNewCust(false);
    setNcName(''); setNcPhone(''); setNcCountry('ID'); setNcChannel(''); setNcHandle('');
    setAddresses([]); setAddressId(null); setConfirmLater(false); setShowNewAddr(false);
    setNaRecipient(''); setNaContact(''); setNaAddr(''); setTidy(null);
    setSkuQuery(''); setSkuResults([]); setSkuSearched(false); setDraftQty({}); setDraftPrice({}); setLines([]);
    setPayMode('none'); setPayAmount(''); setPayMethod(paymentMethods[0]?.label ?? '');
    setUrgency(null);
    setError(null); setResult(null);
    clearDraft(draftKey); setRestored(false); // PR260 — explicit "New order" / discard wipes the draft
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
        <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Sales', href: '/sales' }, { label: 'New order' }]} />
        {successBody}
      </div>
    );
  }

  const body = (
    <>
      <div className="ops-layout">
        <main className="ops-main">
          {error && <div className="validation err">{error}</div>}

          {/* PR260 — a restored in-progress order (e.g. a deploy reloaded the tab mid-entry). */}
          {restored && (
            <div className="validation ok rcv-restored">
              <span>Restored your unsaved order.</span>
              <button className="btn-link" onClick={resetAll}>discard &amp; start fresh</button>
            </div>
          )}

          {/* Panel 1 — Customer */}
          <section className="panel">
            <div className="panel-head"><span className="panel-num">1</span> Customer</div>
            <div className="panel-body">
              {!customer && (
                <>
                  <div className="search-row">
                    <SearchInput
                      value={custQuery}
                      onChange={(v) => { setCustQuery(v); setCustSearched(false); if (!v.trim()) setCustResults([]); }}
                      placeholder="Search phone or name…"
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runCustSearch(); } }}
                    />
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
                            <span className="ri-name">
                              {customerLabel(c.name, c.phone)}
                              {c.tier && <span className={`tier tier-${c.tier.toLowerCase()}`} style={{ marginLeft: 6 }}>{c.tier}</span>}
                            </span>
                            <span className="ri-meta">
                              {c.phone ? formatPhoneDisplay(c.phone) : '—'}
                              {c.lifetime_spend > 0 ? ` · ${fmtRpCompact(c.lifetime_spend)}` : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button className="btn-brown btn-ico" style={{ justifyContent: 'center' }} onClick={openNewCust}><UserIcon />New customer</button>
                </>
              )}

              {/* PR339 — New customer as an overlay (matches the rest of the system); Customer ID required,
                  phone optional, and a duplicate Customer ID surfaces the existing record(s). */}
              {showNewCust && (
                <div className="sc-modal-backdrop" onClick={closeNewCust}>
                  <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="New customer" onClick={(e) => e.stopPropagation()}>
                    <div className="sc-modal-head sc-modal-head-row">
                      <span className="sc-modal-title">{ncStep === 'conflict' ? 'Customer ID already exists' : 'New customer'}</span>
                      <button className="sc-modal-x" onClick={closeNewCust} aria-label="Close">×</button>
                    </div>
                    <div className="sc-modal-body">
                      {ncStep === 'form' ? (
                        <div className="po-form">
                          <div className="po-field">
                            <label>Customer ID<span className="req" aria-hidden="true">*</span></label>
                            <input type="text" placeholder="e.g. Elin AQ" value={ncName} autoFocus onChange={(e) => setNcName(e.target.value)} disabled={savingCust} />
                          </div>
                          <div className="po-field">
                            <label>WhatsApp / phone number</label>
                            <div className="nc-row">
                              <PhoneCountrySelect value={ncCountry} onChange={setNcCountry} disabled={savingCust} />
                              <input className="nc-phone" type="tel" inputMode="numeric" placeholder="081260002889" value={ncPhone} onChange={(e) => setNcPhone(e.target.value)} disabled={savingCust} />
                            </div>
                          </div>
                          <div className="po-field">
                            <label>Channel</label>
                            <div className="nc-row">
                              <IconSelect
                                className="nc-channel-platform"
                                value={ncChannel || null}
                                options={channelSelectOptions}
                                placeholder="— channel —"
                                ariaLabel="Channel platform"
                                disabled={savingCust}
                                onChange={setNcChannel}
                              />
                              <input className="nc-channel-handle" type="text" placeholder="username / number" value={ncHandle} onChange={(e) => setNcHandle(e.target.value)} disabled={savingCust} />
                            </div>
                          </div>
                          {ncError && <div className="validation err">{ncError}</div>}
                          <div className="fd-commit">
                            <button className="btn-secondary" onClick={closeNewCust} disabled={savingCust}>Cancel</button>
                            <button className="btn-primary" onClick={handleCreateCustomer} disabled={savingCust || !ncName.trim()}>
                              {savingCust ? 'Saving…' : 'Create customer'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="hint" style={{ marginBottom: 8 }}>A customer with this ID already exists. Pick it to use for this order, or go back to enter a different Customer ID.</div>
                          <ul className="result-list">
                            {ncConflicts.map((c) => (
                              <li key={c.id}>
                                <button className="result-item" onClick={() => { selectCustomer(c); closeNewCust(); }}>
                                  <span className="ri-name">{customerLabel(c.name, c.phone)}</span>
                                  <span className="ri-meta">{c.phone ? formatPhoneDisplay(c.phone) : '—'}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                          <div className="fd-commit">
                            <button className="btn-link bv-back" onClick={() => { setNcStep('form'); setNcError(null); }}>← back</button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {customer && (
                <div className="selected-customer">
                  <div className="sc-main">
                    <b>{customerLabel(customer.name, customer.phone)}</b>
                    <span>{customer.phone ? formatPhoneDisplay(customer.phone) : '—'}</span>
                  </div>
                  <div className="loyalty-chip">
                    {customer.tier ? <span className={`tier tier-${customer.tier.toLowerCase()}`}>{customer.tier}</span> : <span className="tier tier-none">No tier</span>}
                    <span className="ls">{fmtRpCompact(customer.lifetime_spend)}</span>
                    {loyalty?.to_next_tier && (
                      <span className="next">{fmtRpCompact(loyalty.to_next_tier.remaining)} → {loyalty.to_next_tier.tier}</span>
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
                  <button className="btn-brown btn-ico" style={{ justifyContent: 'center' }} onClick={() => setShowNewAddr(true)} disabled={!customer}><MapPinIcon />New address</button>
                </>
              )}
            </div>
          </section>

          {/* PR343 — New address as an overlay (matches New customer): paste the blob, we tidy it into the
              Confirm-address overlay. */}
          {showNewAddr && (
            <div className="sc-modal-backdrop" onClick={() => setShowNewAddr(false)}>
              <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="New address" onClick={(e) => e.stopPropagation()}>
                <div className="sc-modal-head sc-modal-head-row">
                  <span className="sc-modal-title">New address</span>
                  <button className="sc-modal-x" onClick={() => setShowNewAddr(false)} aria-label="Close">×</button>
                </div>
                <div className="sc-modal-body">
                  <div className="po-form">
                    <div className="po-field">
                      <label>Recipient name</label>
                      <input type="text" value={naRecipient} onChange={(e) => setNaRecipient(e.target.value)} disabled={tidying} />
                    </div>
                    <div className="po-field">
                      <label>Recipient phone number</label>
                      <input type="tel" inputMode="numeric" value={naContact} onChange={(e) => setNaContact(e.target.value)} disabled={tidying} />
                    </div>
                    <div className="po-field">
                      <label>Recipient address <em className="po-sub">(paste the full address — we’ll tidy it into fields next)</em></label>
                      <textarea value={naAddr} placeholder="Paste the recipient's full address here" onChange={(e) => setNaAddr(e.target.value)} disabled={tidying} />
                    </div>
                    {error && <div className="validation err">{error}</div>}
                    <div className="fd-commit">
                      <button className="btn-secondary" onClick={() => setShowNewAddr(false)} disabled={tidying}>Cancel</button>
                      <button className="btn-primary" onClick={handleTidyAddress} disabled={tidying || !naAddr.trim()}>{tidying ? 'Tidying…' : 'Add address'}</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* PR340 — Confirm-address overlay, matching Customer › detail › Add address (cream location box,
              small-caps label subtext, live Preview + postcode check) minus the "Original address" part. */}
          {tidy && (() => {
            const locWarn = locationWarning(tidy, postal);
            return (
            <div className="sc-modal-backdrop" onClick={() => setTidy(null)}>
              <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Confirm address" onClick={(e) => e.stopPropagation()}>
                <div className="sc-modal-head sc-modal-head-row">
                  <span className="sc-modal-title">Confirm address</span>
                  <button className="sc-modal-x" onClick={() => setTidy(null)} aria-label="Close">×</button>
                </div>
                <div className="sc-modal-body">
                  {tidyInfo.length > 0 && (
                    <div className="validation warn" style={{ marginBottom: 10 }}>{tidyInfo.map((wm, i) => <div key={i}>{wm}</div>)}</div>
                  )}
                  <div className="po-form">
                    <div className="po-inline">
                      <div className="po-field"><label>Recipient name</label><input type="text" value={tidy.recipient_name ?? ''} onChange={(e) => setTidy({ ...tidy, recipient_name: e.target.value })} /></div>
                      <div className="po-field"><label>Contact phone</label><input type="text" inputMode="tel" value={tidy.contact_phone ?? ''} onChange={(e) => setTidy({ ...tidy, contact_phone: e.target.value })} /></div>
                    </div>
                    <div className="po-field">
                      <label>Country</label>
                      <CountrySelect value={tidy.negara || null} onChange={(country) => setTidy({ ...tidy, negara: country })} disabled={savingAddr} />
                    </div>
                    <div className="cust-loc-box">
                      {isIndonesia(tidy.negara) && (
                        <div className="po-field">
                          <label>Autofill <em className="po-sub">(province / city / kecamatan / kelurahan / postcode)</em></label>
                          <PostcodeAutofill
                            disabled={savingAddr}
                            onPick={(h) => setTidy((d) => (d ? { ...d, ...collapseRegionDuplicates({ provinsi: normalizeProvince(h.province), kota: h.city, kecamatan: h.sub_district, kelurahan: h.urban }), kode_pos: h.postal } : d))}
                          />
                        </div>
                      )}
                      <div className="po-inline">
                        <div className="po-field"><label>Province{isIndonesia(tidy.negara) ? '' : ' / region'}</label><input type="text" value={tidy.provinsi ?? ''} onChange={(e) => setTidy({ ...tidy, provinsi: e.target.value })} /></div>
                        <div className="po-field"><label>City / district</label><input type="text" value={tidy.kota ?? ''} onChange={(e) => setTidy({ ...tidy, kota: e.target.value })} /></div>
                      </div>
                      {isIndonesia(tidy.negara) && (
                        <div className="po-inline">
                          <div className="po-field"><label>Subdistrict (kecamatan)</label><input type="text" value={tidy.kecamatan ?? ''} onChange={(e) => setTidy({ ...tidy, kecamatan: e.target.value })} /></div>
                          <div className="po-field"><label>Ward (kelurahan)</label><input type="text" value={tidy.kelurahan ?? ''} onChange={(e) => setTidy({ ...tidy, kelurahan: e.target.value })} /></div>
                        </div>
                      )}
                      <div className="po-field"><label>Postcode</label><input type="text" inputMode="numeric" value={tidy.kode_pos ?? ''} onChange={(e) => setTidy({ ...tidy, kode_pos: e.target.value })} /></div>
                      {locWarn && (
                        <div className={`cust-loc-warn ${locWarn.tone === 'red' ? 'is-red' : 'is-yellow'}`}>
                          <span>{locWarn.text}</span>
                          {locWarn.suggest?.map((pc) => (
                            <button key={pc} type="button" className="cust-loc-suggest" onClick={() => setTidy((d) => (d ? { ...d, kode_pos: pc } : d))}>{pc}</button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="po-field">
                      <label>Address <em className="po-sub">(street, alley/gang, no. — not the city/province above)</em></label>
                      <textarea value={tidy.street ?? ''} onChange={(e) => setTidy({ ...tidy, street: e.target.value })} />
                    </div>
                    <div className="po-field">
                      <label>Delivery note <em className="po-sub">(courier instructions / sender — printed below the courier line as “Note: …”)</em></label>
                      <input type="text" value={tidy.delivery_note ?? ''} onChange={(e) => setTidy({ ...tidy, delivery_note: e.target.value })} />
                    </div>
                    <div className="cust-addr-stub cust-addr-preview">
                      <div className="cust-addr-stub-label">Preview address</div>
                      <div className="cust-addr-stub-text">{[
                        (tidy.recipient_name ?? '').trim(),
                        previewRawAddress(tidy) || '—',
                        (tidy.contact_phone ?? '').trim(),
                        (tidy.delivery_note ?? '').trim() ? `Note: ${(tidy.delivery_note ?? '').trim()}` : '',
                      ].filter(Boolean).join('\n')}</div>
                    </div>
                    <div className="fd-commit">
                      <button className="btn-secondary" onClick={() => { setTidy(null); setShowNewAddr(true); }} disabled={savingAddr}>Back</button>
                      <button className="btn-primary" onClick={handleConfirmAddress} disabled={savingAddr}>{savingAddr ? 'Saving…' : 'Save address'}</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            );
          })()}

          {/* Panel 3 — Items */}
          <section className={`panel ${!customer ? 'panel-locked' : ''}`}>
            <div className="panel-head"><span className="panel-num">3</span> Items</div>
            <div className="panel-body">
              <div className="search-row">
                <SearchInput
                  ref={skuInputRef}
                  value={skuQuery}
                  onChange={(v) => { setSkuQuery(v); setSkuSearched(false); if (!v.trim()) setSkuResults([]); }}
                  placeholder="SKU, name, or piece count…"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSkuSearch(); } }}
                  disabled={!customer}
                  onClear={clearSkuSearch}
                />
              </div>
              {skuSearching && <div className="hint">Searching…</div>}
              {!skuSearching && skuSearched && skuResults.length === 0 && (
                <div className="hint"><em>No results</em></div>
              )}
              {skuResults.length > 0 && (
                <ul className="result-list">
                  {/* PR156 card: md image left; beside it l1 = SKU + Inventory-style stat icons
                      (on order · shipped · warehouse), l2 = name, l3 = qty stepper × price × add. */}
                  {skuResults.map((s) => {
                    const qtyNow = Math.max(1, parseInt(draftQty[s.item_code] || '1', 10) || 1);
                    return (
                      <li key={s.item_code} className="sku-result">
                        <div className="sku-line">
                          <SkuImage status={imgMap[s.item_code]?.status} displayUrl={imgMap[s.item_code]?.displayUrl} name={s.name} size={SKU_IMG.md} />
                          <div className="sku-main">
                            <div className="sku-l1">
                              <span className="sku-code">{s.item_code}</span>
                              <StockStats pending={s.pending} onTheWay={s.on_the_way} warehouse={s.available} />
                            </div>
                            <div className="sku-name-line">{s.name}</div>
                            <div className="sku-add">
                              <span className="qty-step">
                                <button type="button" onClick={() => setDraftQty((d) => ({ ...d, [s.item_code]: String(Math.max(1, qtyNow - 1)) }))} disabled={qtyNow <= 1} aria-label="decrease">−</button>
                                <input type="number" inputMode="numeric" min={1} value={draftQty[s.item_code] ?? '1'}
                                  onChange={(e) => setDraftQty((d) => ({ ...d, [s.item_code]: e.target.value }))} />
                                <button type="button" onClick={() => setDraftQty((d) => ({ ...d, [s.item_code]: String(qtyNow + 1) }))} aria-label="increase">+</button>
                              </span>
                              {/* price: text + thousands grouping; state stores digits only (PR24 §4) */}
                              <input className="price" type="text" inputMode="numeric" placeholder="Rp price"
                                value={fmtThousands(draftPrice[s.item_code] ?? '')}
                                onChange={(e) => setDraftPrice((d) => ({ ...d, [s.item_code]: e.target.value.replace(/\D/g, '') }))} />
                              <button className="btn-secondary" onClick={() => addLine(s)}>add</button>
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
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
              {/* PR156: None → DP → Full (the payment progression), each with a fill glyph. */}
              <div className="pay-toggle">
                <button className={payMode === 'none' ? 'active' : ''} onClick={() => setPayMode('none')}>○ None</button>
                <button className={payMode === 'dp' ? 'active' : ''} onClick={() => setPayMode('dp')}>◑ DP</button>
                <button className={payMode === 'full' ? 'active' : ''} onClick={() => setPayMode('full')}>● Full</button>
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
                  <IconSelect
                    ariaLabel="Payment method"
                    value={payMethod}
                    options={paymentMethods.map((m) => ({ value: m.label, label: m.label, icon: m.icon }))}
                    onChange={setPayMethod}
                  />
                )
              )}
            </div>
          </section>

          {/* Panel 5 — Priority (PR73): optional buy-urgency, surfaced on the Purchasing From-Sales
              cards. PR144: explicitly labelled optional (preorder items only), explanatory text dropped. */}
          <section className={`panel ${!customer ? 'panel-locked' : ''}`}>
            <div className="panel-head"><span className="panel-num">5</span> Priority <em className="panel-opt">(optional — preorder items only)</em></div>
            <div className="panel-body">
              <div className="urg-toggle" role="group" aria-label="Order urgency">
                {URGENCY_OPTS.map((u) => (
                  <button
                    key={u.key}
                    type="button"
                    className={`urg-btn urg-${u.key} ${urgency === u.key ? 'active' : ''}`}
                    aria-pressed={urgency === u.key}
                    onClick={() => setUrgency(urgency === u.key ? null : u.key)}
                  >
                    {u.label}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </main>

        {/* Sticky summary rail */}
        <aside className="ops-rail">
          <div className="rail-card">
            <div className="rail-title">Order summary</div>
            <div className="rail-row"><span>Customer</span><b>{customer?.name || '—'}</b></div>
            <div className="rail-sep" />
            {/* PR144: item count + per-SKU mini lines (thumb · code/name · ×qty · line total) so the
                Subtotal below reads as the sum of qty × price. No Payment row — Subtotal vs Paid
                already says it; Status carries the pipeline readiness. */}
            <div className="rail-row"><span>Items</span><b>{lines.length ? `×${lines.reduce((s, l) => s + l.qty, 0)}` : '—'}</b></div>
            {lines.length > 0 && (
              <ul className="rail-lines">
                {lines.map((l, i) => (
                  <li key={`${l.item_code}-${i}`} className="rail-line">
                    <SkuImage status={imgMap[l.item_code]?.status} displayUrl={imgMap[l.item_code]?.displayUrl} name={l.name} size={SKU_IMG.sm} />
                    <div className="rail-line-main">
                      <span className="rail-line-code">{l.item_code}</span>
                      <span className="rail-line-name">{l.name}</span>
                    </div>
                    <span className="rail-line-qty">×{l.qty}</span>
                    <span className="rail-line-amt">{fmtRp(l.qty * l.unit_price_idr)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="rail-sep" />
            <div className="rail-row"><span>Subtotal</span><b>{fmtRp(subtotal)}</b></div>
            <div className="rail-row"><span>Paid</span><b>{fmtRp(paid)}</b></div>
            <div className="rail-sep" />
            <div className="rail-row"><span>Status</span><span className={`rail-pill ${readinessClass(readiness)}`}>{readiness}</span></div>
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
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Sales', href: '/sales' }, { label: 'New order' }]} />
      {body}
    </div>
  );
}

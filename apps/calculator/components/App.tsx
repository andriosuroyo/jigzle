'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { createSupabaseBrowserClient } from '@jigzle/db/client';
import type { Currency, ShippingMethod, SavedCalculation, UserPrefs } from '@jigzle/db/types';
import { compute, fmtNum, fmtRp, type FxMap } from '@jigzle/lib';
import {
  Button,
  Section,
  Headline,
  Field,
  BreakdownRow,
  DetailRow,
} from '@jigzle/ui';

type Props = {
  initialMethods: ShippingMethod[];
  initialCurrencies: Currency[];
  initialCalculations: SavedCalculation[];
  initialPrefs: UserPrefs | null;
  userEmail: string;
};

type View = 'calculator' | 'history' | 'rates';

export default function App(props: Props) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [view, setView] = useState<View>('calculator');

  // Data
  const [methods, setMethods] = useState<ShippingMethod[]>(props.initialMethods);
  const [currencies, setCurrencies] = useState<Currency[]>(props.initialCurrencies);
  const [calculations, setCalculations] = useState<SavedCalculation[]>(props.initialCalculations);

  const fx: FxMap = useMemo(() => {
    const m: FxMap = {};
    currencies.forEach((c) => { m[c.code] = Number(c.rate_to_idr); });
    return m;
  }, [currencies]);

  const fxUpdatedAt = useMemo(() => {
    if (!currencies.length) return null;
    return currencies.reduce<string | null>((latest, c) => {
      if (!c.updated_at) return latest;
      return !latest || c.updated_at > latest ? c.updated_at : latest;
    }, null);
  }, [currencies]);

  // Form state
  const prefs = props.initialPrefs;
  const defaultMethodId = prefs?.method_id || methods[0]?.id || 'ship-cn-ups';
  const [methodId, setMethodId] = useState<string>(defaultMethodId);
  const [taxRate, setTaxRate] = useState<number>(prefs?.tax_rate ?? 18.25);
  const [sku, setSku] = useState<string>('');
  const [purchasePrice, setPurchasePrice] = useState<number>(279);
  const [localShipping, setLocalShipping] = useState<number>(0);
  const [realWeightG, setRealWeightG] = useState<number>(600);
  const [boxP, setBoxP] = useState<number>(34);
  const [boxL, setBoxL] = useState<number>(1);
  const [boxT, setBoxT] = useState<number>(34);
  const [coefficient, setCoefficient] = useState<number>(prefs?.coefficient ?? 0.40);
  const [marketplaceActive, setMarketplaceActive] = useState<boolean>(prefs?.marketplace_active ?? false);
  const [marketplaceRate, setMarketplaceRate] = useState<number>(prefs?.marketplace_rate ?? 7.5);

  // Modal
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailCalc = detailId ? calculations.find((c) => c.id === detailId) : null;

  // History search
  const [histSearch, setHistSearch] = useState<string>('');

  // Fx refresh
  const [fxStatus, setFxStatus] = useState<{ kind: 'idle' | 'fetching' | 'err'; text: string }>(
    { kind: 'idle', text: '' }
  );

  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getUser();
      setUserId(data.user?.id || null);
    })();
  }, [supabase]);

  // Replace the upsert above with one that uses userId.
  useEffect(() => {
    if (!userId) return;
    const handle = setTimeout(() => {
      void supabase.from('user_prefs').upsert(
        {
          user_id: userId,
          method_id: methodId,
          tax_rate: taxRate,
          coefficient,
          marketplace_active: marketplaceActive,
          marketplace_rate: marketplaceRate,
        },
        { onConflict: 'user_id' }
      );
    }, 600);
    return () => clearTimeout(handle);
  }, [userId, methodId, taxRate, coefficient, marketplaceActive, marketplaceRate, supabase]);

  // Computation
  const method = methods.find((m) => m.id === methodId) || methods[0];
  const c = method
    ? compute({
        method,
        fx,
        tax_rate: taxRate,
        purchase_price: purchasePrice,
        local_shipping: localShipping,
        real_weight_g: realWeightG,
        box_p: boxP,
        box_l: boxL,
        box_t: boxT,
        coefficient,
        marketplace_active: marketplaceActive,
        marketplace_rate: marketplaceRate,
      })
    : null;

  // Validation
  const validation = useMemo(() => {
    if (!method || !c) return { cls: 'warn', text: 'Loading…' };
    if (purchasePrice <= 0) return { cls: 'warn', text: '⚠ Missing or zero purchase price.' };
    if (realWeightG <= 0 && boxP * boxL * boxT <= 0)
      return { cls: 'warn', text: '⚠ Missing both real weight and box dimensions.' };
    if (coefficient + (marketplaceActive ? marketplaceRate / 100 : 0) >= 0.95)
      return { cls: 'warn', text: '⚠ Coefficient + marketplace fee ≥ 95%. Lower one.' };
    if (c.fx_source === 0)
      return { cls: 'err', text: `⚠ No FX rate available for ${method.source_currency}. Refresh in Rates tab.` };
    return { cls: 'ok', text: '✓ Calculation complete.' };
  }, [method, c, purchasePrice, realWeightG, boxP, boxL, boxT, coefficient, marketplaceActive, marketplaceRate]);

  // FX hint
  const fxHint = useMemo(() => {
    if (!fxUpdatedAt) return 'Cached defaults loaded. Tap Rates → Refresh live.';
    const d = new Date(fxUpdatedAt);
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    return days === 0 ? 'Live rate · refreshed today' : `Live rate · refreshed ${days} days ago`;
  }, [fxUpdatedAt]);

  const switchView = useCallback((v: View) => {
    setView(v);
    window.scrollTo(0, 0);
  }, []);

  async function saveCalc() {
    if (!method || !c || !userId) return;
    const payload = {
      user_id: userId,
      sku: sku || '',
      method_id: method.id,
      method_display: method.display,
      source_country: method.source_country,
      source_currency: method.source_currency,
      rate_currency: method.rate_currency,
      shipping_rate: method.rate_per_kg,
      warehouse_fee: method.warehouse_fee,
      tax_included: method.tax_included,
      fx_source: c.fx_source,
      fx_rate_ship: c.fx_rate_ship,
      tax_rate: taxRate,
      purchase_price: purchasePrice,
      local_shipping: localShipping,
      real_weight_g: realWeightG,
      box_p: boxP,
      box_l: boxL,
      box_t: boxT,
      coefficient,
      marketplace_active: marketplaceActive,
      marketplace_rate: marketplaceRate,
      item_cost_idr: c.item_cost_idr,
      shipping_cost_idr: c.shipping_cost_idr,
      import_tax_idr: c.import_tax_idr,
      marketplace_fee_idr: c.marketplace_fee_idr,
      total_cost_idr: c.total_cost_idr,
      rec_sale_price: c.rec_sale_price,
      low_margin_idr: c.low_margin_idr,
    };
    const { data, error } = await supabase
      .from('calculations')
      .insert(payload)
      .select('*')
      .single();
    if (!error && data) {
      setCalculations((prev) => [data as SavedCalculation, ...prev]);
      flashSaved();
    } else {
      alert('Save failed: ' + (error?.message || 'unknown'));
    }
  }

  function flashSaved() {
    const btn = document.querySelector<HTMLButtonElement>('.btn-save');
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = '✓ Saved';
    btn.style.background = 'var(--green)';
    setTimeout(() => {
      btn.textContent = orig;
      btn.style.background = '';
    }, 1500);
  }

  async function deleteCalc(id: string) {
    if (!confirm('Delete this calculation?')) return;
    const { error } = await supabase.from('calculations').delete().eq('id', id);
    if (!error) {
      setCalculations((prev) => prev.filter((x) => x.id !== id));
      setDetailId(null);
    } else {
      alert('Delete failed: ' + error.message);
    }
  }

  function duplicateCalc(id: string) {
    const x = calculations.find((c) => c.id === id);
    if (!x) return;
    setMethodId(x.method_id);
    setTaxRate(Number(x.tax_rate));
    setSku(x.sku || '');
    setPurchasePrice(Number(x.purchase_price));
    setLocalShipping(Number(x.local_shipping));
    setRealWeightG(Number(x.real_weight_g));
    setBoxP(Number(x.box_p));
    setBoxL(Number(x.box_l));
    setBoxT(Number(x.box_t));
    setCoefficient(0.40);
    setMarketplaceActive(x.marketplace_active);
    setMarketplaceRate(Number(x.marketplace_rate));
    setDetailId(null);
    switchView('calculator');
  }

  function resetForm() {
    if (!confirm('Reset all inputs to defaults?')) return;
    setSku('');
    setPurchasePrice(0);
    setLocalShipping(0);
    setRealWeightG(0);
    setBoxP(0);
    setBoxL(0);
    setBoxT(0);
    setCoefficient(0.40);
    setMarketplaceActive(false);
  }

  async function refreshLiveFX() {
    setFxStatus({ kind: 'fetching', text: 'Fetching from Frankfurter…' });
    try {
      const res = await fetch('/api/fx/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      setCurrencies(data.currencies as Currency[]);
      setFxStatus({ kind: 'idle', text: '' });
    } catch (e: any) {
      setFxStatus({ kind: 'err', text: 'Fetch failed: ' + e.message + '. Using cached values.' });
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  // Filtered history
  const filteredCalcs = useMemo(() => {
    const s = histSearch.trim().toLowerCase();
    if (!s) return calculations;
    return calculations.filter(
      (x) =>
        (x.sku || '').toLowerCase().includes(s) ||
        (x.method_display || '').toLowerCase().includes(s) ||
        (x.source_currency || '').toLowerCase().includes(s)
    );
  }, [calculations, histSearch]);

  if (!method) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
        No shipping methods configured. Add rows to <code>shipping_methods</code> in Supabase.
      </div>
    );
  }

  const volEmpty = !boxP || !boxL || !boxT;

  return (
    <>
      <header className="app-header">
        <div className="logo">J</div>
        <div className="title">Jigzle Calculator</div>
        <div className="meta">v1.0</div>
        <button className="signout" onClick={signOut} title={props.userEmail}>Sign out</button>
      </header>

      <nav className="tab-bar">
        <button className={`tab ${view === 'calculator' ? 'active' : ''}`} onClick={() => switchView('calculator')}>Calculator</button>
        <button className={`tab ${view === 'history' ? 'active' : ''}`} onClick={() => switchView('history')}>History</button>
        <button className={`tab ${view === 'rates' ? 'active' : ''}`} onClick={() => switchView('rates')}>Rates</button>
      </nav>

      {/* CALCULATOR */}
      <div className={`view ${view === 'calculator' ? 'active' : ''}`}>
        <div className="view-inner">
          <Headline
            primaryLabel="Rec. sale price"
            primaryValue={c ? fmtRp(c.rec_sale_price) : 'Rp —'}
            secondaryLabel="Margin if discounted 10%"
            secondaryValue={c ? fmtRp(c.low_margin_idr) : 'Rp —'}
          />

          <Section band="Shipping method & rates">
            <Field
              label="Shipping method"
              required
              bold
              hint="Drives currency, rate, warehouse fee, tax-included flag."
            >
              <div className="field-row">
                <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                  {methods.map((m) => (
                    <option key={m.id} value={m.id}>{m.display}</option>
                  ))}
                </select>
              </div>
            </Field>

            <Field label="Source currency">
              <div className="field-row">
                <div className="computed-row">{method.source_currency}</div>
              </div>
            </Field>

            <Field label="FX rate to IDR" hint={fxHint}>
              <div className="field-row">
                <div className="computed-row">{c ? fmtNum(c.fx_source, 4) : '—'}</div>
              </div>
            </Field>

            <Field label="Shipping rate">
              <div className="field-row">
                <div className="computed-row">{fmtNum(method.rate_per_kg, 0)}  {method.rate_currency} / kg</div>
              </div>
            </Field>

            <Field label="Warehouse fee">
              <div className="field-row">
                <div className="computed-row">{fmtNum(method.warehouse_fee, 2)}  {method.source_currency}</div>
              </div>
            </Field>

            <Field
              label="Import tax rate"
              required
              hint="Currently 18.25% in Indonesia. Plan to update to 25% in future."
            >
              <div className="field-row">
                <input type="number" min={0} max={100} step={0.01} value={taxRate}
                  onChange={(e) => setTaxRate(+e.target.value || 0)} />
                <span className="unit">%</span>
              </div>
            </Field>

            <Field
              label="Tax included in shipping?"
              hint="Auto from method · TRUE for forwarders (CBL, MTE)."
            >
              <div className="field-row">
                <div className={`computed-row ${method.tax_included ? 'flag-true' : 'flag-false'}`}>
                  {method.tax_included ? 'YES — bundled' : 'no'}
                </div>
              </div>
            </Field>
          </Section>

          <Section band="Item details">
            <Field label="SKU (optional)">
              <div className="field-row">
                <input type="text" placeholder="e.g. 3DC-50001" value={sku}
                  onChange={(e) => setSku(e.target.value)} />
              </div>
            </Field>

            <Field label="Purchase price" required>
              <div className="field-row">
                <input type="number" min={0} step={0.01} value={purchasePrice}
                  onChange={(e) => setPurchasePrice(+e.target.value || 0)} />
                <span className="unit">{method.source_currency}</span>
              </div>
            </Field>

            <Field label="Local shipping / handling">
              <div className="field-row">
                <input type="number" min={0} step={0.01} value={localShipping}
                  onChange={(e) => setLocalShipping(+e.target.value || 0)} />
                <span className="unit">{method.source_currency}</span>
              </div>
            </Field>

            <Field label="Real weight" required>
              <div className="field-row">
                <input type="number" min={0} step={0.1} value={realWeightG}
                  onChange={(e) => setRealWeightG(+e.target.value || 0)} />
                <span className="unit">g</span>
              </div>
            </Field>

            <div className="field">
              <span className="field-label">Box dimensions P × L × T (cm)</span>
              <div className="dims">
                <input type="number" min={0} step={0.1} value={boxP} placeholder="P"
                  onChange={(e) => setBoxP(+e.target.value || 0)} />
                <input type="number" min={0} step={0.1} value={boxL} placeholder="L"
                  onChange={(e) => setBoxL(+e.target.value || 0)} />
                <input type="number" min={0} step={0.1} value={boxT} placeholder="T"
                  onChange={(e) => setBoxT(+e.target.value || 0)} />
              </div>
              <div className="vol-weight">
                {volEmpty
                  ? '— (fill all three dims)'
                  : c
                    ? `= ${fmtNum(c.vol_weight_g, 0)} g volumetric weight  ·  effective ${fmtNum(c.effective_kg * 1000, 0)} g`
                    : '—'}
              </div>
            </div>
          </Section>

          <Section band="Pricing tuning">
            <div className="field">
              <span className="field-label req">Coefficient (margin target)</span>
              <div className="slider-field">
                <div className="slider-top">
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>Higher = higher rec sale price</span>
                  <span className="slider-value">{coefficient.toFixed(2)}</span>
                </div>
                <input type="range" min={0} max={0.9} step={0.01} value={coefficient}
                  onChange={(e) => setCoefficient(+e.target.value)} />
              </div>
            </div>

            <Field
              label="Apply marketplace fee?"
              hint="Shopee / Tokopedia / TikTok takes a cut; FALSE for direct/own store."
            >
              <div className="field-row">
                <div className="toggle-wrap">
                  <button type="button" className={`toggle-opt ${!marketplaceActive ? 'active' : ''}`}
                    onClick={() => setMarketplaceActive(false)}>No · Direct</button>
                  <button type="button" className={`toggle-opt ${marketplaceActive ? 'active' : ''}`}
                    onClick={() => setMarketplaceActive(true)}>Yes · Marketplace</button>
                </div>
              </div>
            </Field>

            {marketplaceActive && (
              <Field label="Marketplace fee rate" hint="Default 7.5% · varies by platform.">
                <div className="field-row">
                  <input type="number" min={0} max={100} step={0.01} value={marketplaceRate}
                    onChange={(e) => setMarketplaceRate(+e.target.value || 0)} />
                  <span className="unit">%</span>
                </div>
              </Field>
            )}
          </Section>

          <Section band="Breakdown" bodyClassName="breakdown">
            {c && (
              <>
                <BreakdownRow marker="A" desc="Item cost subtotal" sub="(purchase + local + warehouse) × FX" val={c.item_cost_idr} />
                <BreakdownRow marker="B" desc="Shipping cost" sub={`${fmtNum(c.effective_kg * 1000, 0)} g × ${fmtNum(method.rate_per_kg, 0)} ${method.rate_currency}/kg × FX`} val={c.shipping_cost_idr} />
                {method.tax_included ? (
                  <BreakdownRow marker="C" desc="Import tax" sub="Included in shipping rate — no separate tax" val={0} cls="tax-incl" />
                ) : (
                  <BreakdownRow marker="C" desc="Import tax" sub={`(A + B) × ${fmtNum(taxRate, 2)}%`} val={c.import_tax_idr} />
                )}
                {marketplaceActive ? (
                  <BreakdownRow marker="D" desc="Marketplace fee" sub={`rec sale price × ${fmtNum(marketplaceRate, 2)}%`} val={c.marketplace_fee_idr} />
                ) : (
                  <BreakdownRow marker="D" desc="Marketplace fee" sub="Not applied" val={0} cls="off" />
                )}
                <BreakdownRow marker="Σ" desc="TOTAL COST" sub="" val={c.total_cost_idr} cls="total" />
              </>
            )}
          </Section>

          <div className={`validation ${validation.cls}`}>{validation.text}</div>

          <div className="actions">
            <Button variant="secondary" onClick={resetForm}>Reset</Button>
            <Button variant="primary" className="btn-save" onClick={saveCalc}>Save calculation</Button>
          </div>

          <div className="footer-info">
            <b>Jigzle Calculator</b> · synced via Supabase · install: tap browser menu → Add to Home Screen
          </div>
        </div>
      </div>

      {/* HISTORY */}
      <div className={`view ${view === 'history' ? 'active' : ''}`}>
        <div className="view-inner">
          <div className="history-search">
            <input type="text" placeholder="Search SKU, route, currency…"
              value={histSearch} onChange={(e) => setHistSearch(e.target.value)} />
          </div>
          <div className="history-list">
            {filteredCalcs.length === 0 ? (
              <div className="hist-empty">No saved calculations yet.<br />Save one from the Calculator tab.</div>
            ) : (
              filteredCalcs.map((c) => {
                const dt = new Date(c.created_at);
                const dtStr =
                  dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
                  ' · ' +
                  dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                const dashParts = c.method_display.split('—');
                const routeLabel = dashParts[1] ? dashParts.slice(1).join('—').trim() : c.method_display;
                return (
                  <div key={c.id} className="hist-item" onClick={() => setDetailId(c.id)}>
                    <div className="top">
                      <span className="sku">{c.sku || '— no SKU —'}</span>
                      <span className="price">{fmtRp(Number(c.rec_sale_price))}</span>
                    </div>
                    <div className="meta">{c.source_country} · {routeLabel} · {dtStr}</div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* RATES */}
      <div className={`view ${view === 'rates' ? 'active' : ''}`}>
        <div className="view-inner">
          <div className="rates-section">
            <h3>FX rates to IDR</h3>
            <div className={`fx-refresh ${fxStatus.kind === 'fetching' ? 'fetching' : ''} ${fxStatus.kind === 'err' ? 'err' : ''}`}>
              <span>
                {fxStatus.text ||
                  (fxUpdatedAt
                    ? 'Live rates · refreshed ' + new Date(fxUpdatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                    : 'Using cached defaults · tap Refresh live to fetch')}
              </span>
              <button onClick={refreshLiveFX}>Refresh live</button>
            </div>
            <div className="rates-fx-grid">
              {currencies.filter((x) => x.code !== 'IDR').map((cur) => (
                <div key={cur.code} className="fx-card">
                  <span className="cur">{cur.code}</span>
                  <span className="rate">{fmtNum(Number(cur.rate_to_idr), 4)}</span>
                </div>
              ))}
            </div>

            <h3 style={{ marginTop: 24 }}>Shipping methods</h3>
            {methods.map((m) => (
              <div key={m.id} className="rates-method">
                <div className="top">
                  <span className="name">{m.display}</span>
                  <span className="rate">{fmtNum(Number(m.rate_per_kg), 0)} {m.rate_currency}/kg</span>
                </div>
                <div className="meta">
                  <span className="pill">{m.source_country}</span>
                  <span className="pill">{m.rate_currency} rate</span>
                  {m.tax_included && <span className="pill tax">tax included</span>}
                  {Number(m.warehouse_fee) > 0 && (
                    <span className="pill">+{m.warehouse_fee} {m.source_currency} warehouse</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* MODAL */}
      <div className={`modal-bg ${detailCalc ? 'show' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) setDetailId(null); }}>
        {detailCalc && (
          <div className="modal">
            <div className="modal-header">
              <div className="title">{detailCalc.sku || 'Calculation'}</div>
              <button className="close" onClick={() => setDetailId(null)}>×</button>
            </div>
            <Headline
              primaryLabel="Rec. sale price (saved)"
              primaryValue={fmtRp(Number(detailCalc.rec_sale_price))}
              secondaryLabel="Margin if discounted 10%"
              secondaryValue={fmtRp(Number(detailCalc.low_margin_idr))}
            />
            <div className="detail-section">
              <h4>Inputs</h4>
              <DetailRow l="SKU" r={detailCalc.sku || '—'} />
              <DetailRow l="Method" r={detailCalc.method_display} />
              <DetailRow l="Purchase price" r={`${fmtNum(Number(detailCalc.purchase_price), 2)} ${detailCalc.source_currency}`} />
              <DetailRow l="Local shipping" r={`${fmtNum(Number(detailCalc.local_shipping), 2)} ${detailCalc.source_currency}`} />
              <DetailRow l="Real weight" r={`${fmtNum(Number(detailCalc.real_weight_g), 0)} g`} />
              <DetailRow l="Box dims" r={`${detailCalc.box_p} × ${detailCalc.box_l} × ${detailCalc.box_t} cm`} />
              <DetailRow l="Coefficient" r={fmtNum(Number(detailCalc.coefficient), 2)} />
              <DetailRow l="Marketplace fee" r={detailCalc.marketplace_active ? Number(detailCalc.marketplace_rate).toFixed(2) + '%' : 'not applied'} />
            </div>
            <div className="detail-section">
              <h4>Snapshots at save</h4>
              <DetailRow l="FX rate" r={fmtNum(Number(detailCalc.fx_source), 4)} />
              <DetailRow l="Shipping rate" r={`${fmtNum(Number(detailCalc.shipping_rate), 0)} ${detailCalc.rate_currency}/kg`} />
              <DetailRow l="Import tax rate" r={`${fmtNum(Number(detailCalc.tax_rate), 2)}%`} />
              <DetailRow l="Tax included?" r={detailCalc.tax_included ? 'Yes' : 'No'} rStyle={detailCalc.tax_included ? { color: 'var(--green)', fontWeight: 600 } : undefined} />
              <DetailRow l="Warehouse fee" r={`${fmtNum(Number(detailCalc.warehouse_fee), 2)} ${detailCalc.source_currency}`} />
            </div>
            <div className="detail-section">
              <h4>Computed</h4>
              <DetailRow l="Item cost" r={fmtRp(Number(detailCalc.item_cost_idr))} />
              <DetailRow l="Shipping cost" r={fmtRp(Number(detailCalc.shipping_cost_idr))} />
              <DetailRow l="Import tax" r={fmtRp(Number(detailCalc.import_tax_idr))} />
              <DetailRow l="Marketplace fee" r={fmtRp(Number(detailCalc.marketplace_fee_idr))} />
              <DetailRow l="Total cost" r={fmtRp(Number(detailCalc.total_cost_idr))} lStyle={{ fontWeight: 600, color: 'var(--brown)' }} rStyle={{ fontWeight: 700 }} />
            </div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => deleteCalc(detailCalc.id)}>Delete</Button>
              <Button variant="primary" onClick={() => duplicateCalc(detailCalc.id)}>Duplicate to new</Button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

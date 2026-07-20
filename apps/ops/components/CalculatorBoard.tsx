'use client';

// Pricing Calculator (PR396) — landed cost → recommended sale price. A single-purpose tool now: the
// old History and Rates tabs were retired — FX + shipping-method rates live in Settings › Calculator.
// Layout: a full-width result headline on top, then a two-column body (inputs · a sticky breakdown) on
// desktop that stacks on mobile. The maths is the shared @jigzle/lib compute(), unchanged.

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import { compute, fmtNum, fmtRp, type FxMap } from '@jigzle/lib';
import type { Currency, ShippingMethod, UserPrefs } from '@jigzle/db/types';
import { savePrefs } from '@/app/calculator/actions';

// one breakdown line (A / B / C / D / Σ)
function BrkRow({ m, desc, sub, val, muted, total }: { m: string; desc: string; sub?: string; val: number; muted?: boolean; total?: boolean }) {
  return (
    <div className={`calc-brk-row${total ? ' total' : ''}${muted ? ' muted' : ''}`}>
      <span className="calc-brk-m">{m}</span>
      <span className="calc-brk-desc"><b>{desc}</b>{sub ? <em>{sub}</em> : null}</span>
      <span className="calc-brk-val">{fmtRp(val)}</span>
    </div>
  );
}

export default function CalculatorBoard({
  initialMethods,
  initialCurrencies,
  initialPrefs,
  userEmail,
}: {
  initialMethods: ShippingMethod[];
  initialCurrencies: Currency[];
  initialPrefs: UserPrefs | null;
  userEmail: string;
}) {
  const methods = initialMethods;
  const currencies = initialCurrencies;

  const fx: FxMap = useMemo(() => {
    const m: FxMap = {};
    currencies.forEach((c) => { m[c.code] = Number(c.rate_to_idr); });
    return m;
  }, [currencies]);
  const fxUpdatedAt = useMemo(
    () => currencies.reduce<string | null>((l, c) => (c.updated_at && (!l || c.updated_at > l) ? c.updated_at : l), null),
    [currencies]
  );

  const prefs = initialPrefs;
  const [methodId, setMethodId] = useState<string>(prefs?.method_id || methods[0]?.id || '');
  const [taxRate, setTaxRate] = useState<number>(prefs?.tax_rate ?? 18.25);
  const [sku, setSku] = useState('');
  const [purchasePrice, setPurchasePrice] = useState(279);
  const [localShipping, setLocalShipping] = useState(0);
  const [realWeightG, setRealWeightG] = useState(600);
  const [boxP, setBoxP] = useState(34);
  const [boxL, setBoxL] = useState(1);
  const [boxT, setBoxT] = useState(34);
  const [coefficient, setCoefficient] = useState<number>(prefs?.coefficient ?? 0.40);
  const [marketplaceActive, setMarketplaceActive] = useState<boolean>(prefs?.marketplace_active ?? false);
  const [marketplaceRate, setMarketplaceRate] = useState<number>(prefs?.marketplace_rate ?? 7.5);

  // persist form defaults (debounced); skip the initial mount so a page load doesn't write
  const firstPrefs = useRef(true);
  useEffect(() => {
    if (firstPrefs.current) { firstPrefs.current = false; return; }
    const h = setTimeout(() => {
      void savePrefs({ method_id: methodId, tax_rate: taxRate, coefficient, marketplace_active: marketplaceActive, marketplace_rate: marketplaceRate }).catch(() => {});
    }, 600);
    return () => clearTimeout(h);
  }, [methodId, taxRate, coefficient, marketplaceActive, marketplaceRate]);

  const method = methods.find((m) => m.id === methodId) || methods[0];
  const c = method
    ? compute({ method, fx, tax_rate: taxRate, purchase_price: purchasePrice, local_shipping: localShipping, real_weight_g: realWeightG, box_p: boxP, box_l: boxL, box_t: boxT, coefficient, marketplace_active: marketplaceActive, marketplace_rate: marketplaceRate })
    : null;

  const validation = useMemo(() => {
    if (!method || !c) return { cls: 'warn', text: 'Loading…' };
    if (purchasePrice <= 0) return { cls: 'warn', text: '⚠ Missing or zero purchase price.' };
    if (realWeightG <= 0 && boxP * boxL * boxT <= 0) return { cls: 'warn', text: '⚠ Missing both real weight and box dimensions.' };
    if (coefficient + (marketplaceActive ? marketplaceRate / 100 : 0) >= 0.95) return { cls: 'warn', text: '⚠ Coefficient + marketplace fee ≥ 95%. Lower one.' };
    if (c.fx_source === 0) return { cls: 'err', text: `⚠ No FX rate for ${method.source_currency}. Refresh in Settings › Calculator.` };
    return { cls: 'ok', text: '✓ Calculation complete.' };
  }, [method, c, purchasePrice, realWeightG, boxP, boxL, boxT, coefficient, marketplaceActive, marketplaceRate]);

  const fxHint = useMemo(() => {
    if (!fxUpdatedAt) return 'Cached defaults · manage in Settings › Calculator';
    const days = Math.floor((Date.now() - new Date(fxUpdatedAt).getTime()) / 86_400_000);
    return days === 0 ? 'Live · refreshed today' : `Live · refreshed ${days}d ago`;
  }, [fxUpdatedAt]);

  function reset() {
    if (!confirm('Reset all inputs to defaults?')) return;
    setSku(''); setPurchasePrice(0); setLocalShipping(0); setRealWeightG(0); setBoxP(0); setBoxL(0); setBoxT(0); setCoefficient(0.40); setMarketplaceActive(false);
  }

  const volEmpty = !boxP || !boxL || !boxT;

  return (
    <div className="ops">
      <AppHeader active="calculator" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Calculator' }]} />

      <div className="calc-wrap">
        {!method ? (
          <div className="hint">No shipping methods configured — add them in Settings › Calculator.</div>
        ) : (
          <>
            {/* result headline — full width, always on top */}
            <div className="calc-headline">
              <div className="calc-hl-cell">
                <div className="calc-hl-label">Rec. sale price</div>
                <div className="calc-hl-value">{c ? fmtRp(c.rec_sale_price) : 'Rp —'}</div>
              </div>
              <div className="calc-hl-cell">
                <div className="calc-hl-label">Margin if −10%</div>
                <div className="calc-hl-value sub">{c ? fmtRp(c.low_margin_idr) : 'Rp —'}</div>
              </div>
            </div>

            <div className="calc-grid">
              {/* LEFT — inputs */}
              <div className="calc-col-inputs">
                <section className="fd-section">
                  <div className="fd-section-head">Shipping method &amp; rates</div>
                  <div className="po-form">
                    <div className="po-field">
                      <label>Shipping method</label>
                      <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                        {methods.map((m) => <option key={m.id} value={m.id}>{m.display}</option>)}
                      </select>
                    </div>
                    <div className="po-inline">
                      <div className="po-field"><label>Source currency</label><div className="calc-ro">{method.source_currency}</div></div>
                      <div className="po-field"><label>FX rate to IDR</label><div className="calc-ro">{c ? fmtNum(c.fx_source, 4) : '—'}</div></div>
                    </div>
                    <div className="hint" style={{ marginTop: -4 }}>{fxHint}</div>
                    <div className="po-inline">
                      <div className="po-field"><label>Shipping rate</label><div className="calc-ro">{fmtNum(method.rate_per_kg, 0)} {method.rate_currency}/kg</div></div>
                      <div className="po-field"><label>Warehouse fee</label><div className="calc-ro">{fmtNum(method.warehouse_fee, 2)} {method.source_currency}</div></div>
                    </div>
                    <div className="po-inline">
                      <div className="po-field">
                        <label>Import tax rate</label>
                        <div className="calc-inrow"><input type="number" min={0} max={100} step={0.01} value={taxRate} onChange={(e) => setTaxRate(+e.target.value || 0)} /><span className="calc-unit">%</span></div>
                      </div>
                      <div className="po-field"><label>Tax included?</label><div className={`calc-ro ${method.tax_included ? 'pos' : ''}`}>{method.tax_included ? 'YES — bundled' : 'no'}</div></div>
                    </div>
                  </div>
                </section>

                <section className="fd-section">
                  <div className="fd-section-head">Item details</div>
                  <div className="po-form">
                    <div className="po-field"><label>SKU</label><input type="text" placeholder="e.g. 3DC-50001" value={sku} onChange={(e) => setSku(e.target.value)} /></div>
                    <div className="po-inline">
                      <div className="po-field"><label>Purchase price</label><div className="calc-inrow"><input type="number" min={0} step={0.01} value={purchasePrice} onChange={(e) => setPurchasePrice(+e.target.value || 0)} /><span className="calc-unit">{method.source_currency}</span></div></div>
                      <div className="po-field"><label>Local shipping</label><div className="calc-inrow"><input type="number" min={0} step={0.01} value={localShipping} onChange={(e) => setLocalShipping(+e.target.value || 0)} /><span className="calc-unit">{method.source_currency}</span></div></div>
                    </div>
                    <div className="po-field"><label>Real weight</label><div className="calc-inrow"><input type="number" min={0} step={0.1} value={realWeightG} onChange={(e) => setRealWeightG(+e.target.value || 0)} /><span className="calc-unit">g</span></div></div>
                    <div className="po-field">
                      <label>Box dimensions P × L × T (cm)</label>
                      <div className="calc-dims">
                        <input type="number" min={0} step={0.1} value={boxP} placeholder="P" onChange={(e) => setBoxP(+e.target.value || 0)} />
                        <input type="number" min={0} step={0.1} value={boxL} placeholder="L" onChange={(e) => setBoxL(+e.target.value || 0)} />
                        <input type="number" min={0} step={0.1} value={boxT} placeholder="T" onChange={(e) => setBoxT(+e.target.value || 0)} />
                      </div>
                      <span className="hint">{volEmpty ? '— fill all three dims' : c ? `= ${fmtNum(c.vol_weight_g, 0)} g volumetric · effective ${fmtNum(c.effective_kg * 1000, 0)} g` : '—'}</span>
                    </div>
                  </div>
                </section>

                <section className="fd-section">
                  <div className="fd-section-head">Pricing tuning</div>
                  <div className="po-form">
                    <div className="po-field">
                      <label>Coefficient (margin target)</label>
                      <div className="calc-slider">
                        <div className="calc-slider-top"><span className="hint">Higher = higher rec sale price</span><span className="calc-slider-val">{coefficient.toFixed(2)}</span></div>
                        <input type="range" min={0} max={0.9} step={0.01} value={coefficient} onChange={(e) => setCoefficient(+e.target.value)} />
                      </div>
                    </div>
                    <div className="po-field">
                      <label>Apply marketplace fee?</label>
                      <div className="calc-seg" role="group">
                        <button type="button" className={!marketplaceActive ? 'active' : ''} onClick={() => setMarketplaceActive(false)}>No · Direct</button>
                        <button type="button" className={marketplaceActive ? 'active' : ''} onClick={() => setMarketplaceActive(true)}>Yes · Marketplace</button>
                      </div>
                    </div>
                    {marketplaceActive && (
                      <div className="po-field"><label>Marketplace fee rate</label><div className="calc-inrow"><input type="number" min={0} max={100} step={0.01} value={marketplaceRate} onChange={(e) => setMarketplaceRate(+e.target.value || 0)} /><span className="calc-unit">%</span></div></div>
                    )}
                  </div>
                </section>
              </div>

              {/* RIGHT — sticky breakdown */}
              <aside className="calc-col-results">
                <section className="fd-section">
                  <div className="fd-section-head">Breakdown</div>
                  {c && (
                    <div className="calc-brk">
                      <BrkRow m="A" desc="Item cost subtotal" sub="(purchase + local + warehouse) × FX" val={c.item_cost_idr} />
                      <BrkRow m="B" desc="Shipping cost" sub={`${fmtNum(c.effective_kg * 1000, 0)} g × ${fmtNum(method.rate_per_kg, 0)} ${method.rate_currency}/kg × FX`} val={c.shipping_cost_idr} />
                      {method.tax_included
                        ? <BrkRow m="C" desc="Import tax" sub="Included in shipping rate" val={0} muted />
                        : <BrkRow m="C" desc="Import tax" sub={`(A + B) × ${fmtNum(taxRate, 2)}%`} val={c.import_tax_idr} />}
                      {marketplaceActive
                        ? <BrkRow m="D" desc="Marketplace fee" sub={`rec sale × ${fmtNum(marketplaceRate, 2)}%`} val={c.marketplace_fee_idr} />
                        : <BrkRow m="D" desc="Marketplace fee" sub="Not applied" val={0} muted />}
                      <BrkRow m="Σ" desc="TOTAL COST" val={c.total_cost_idr} total />
                    </div>
                  )}
                  <div className={`validation ${validation.cls}`} style={{ marginTop: 12 }}>{validation.text}</div>
                  <div className="calc-actions">
                    <button className="btn-secondary" onClick={reset}>Reset</button>
                  </div>
                </section>
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

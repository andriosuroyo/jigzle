'use client';

// Pricing Calculator (PR396/PR397) — landed cost → recommended sale price. Single-purpose tool; FX +
// shipping-method rates (and the per-method import tax) live in Settings › Calculator. Layout: a
// full-width result headline (rec price · margin · coefficient) on top, then a two-column body
// (inputs · sticky breakdown) on desktop that stacks on mobile. Maths is the shared @jigzle/lib compute().

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import { compute, fmtNum, fmtRp, type FxMap } from '@jigzle/lib';
import type { Currency, ShippingMethod, UserPrefs } from '@jigzle/db/types';
import { savePrefs, refreshFx } from '@/app/calculator/actions';

// currency CODE → symbol, following the app standard (元 for CNY, never ¥). Falls back to the code.
const CCY_SYMBOL: Record<string, string> = { CNY: '元', USD: '$', GBP: '£', JPY: '¥', EUR: '€', IDR: 'Rp', TWD: 'NT$', HKD: 'HK$', KRW: '₩' };
const ccySym = (code: string | null | undefined): string => CCY_SYMBOL[(code ?? '').toUpperCase()] ?? (code ?? '');

// method picker label: flag + the route name minus the leading country ("China — MTE — Air" → "🇨🇳 MTE — Air").
function methodLabel(m: ShippingMethod): string {
  const parts = m.display.split('—').map((s) => s.trim()).filter(Boolean);
  const rest = parts.length > 1 ? parts.slice(1).join(' — ') : m.display;
  return `${m.flag ? m.flag + ' ' : ''}${rest}`.trim();
}

const FX_STALE_MS = 18 * 60 * 60 * 1000; // auto-refresh FX if the cached rate is older than this

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

// one read-only method-info cell (label · value) — display only, not an input
function Meta({ l, v, pos }: { l: string; v: string; pos?: boolean }) {
  return <div className="calc-meta-item"><span className="calc-meta-l">{l}</span><span className={`calc-meta-v${pos ? ' pos' : ''}`}>{v}</span></div>;
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
  const [currencies, setCurrencies] = useState<Currency[]>(initialCurrencies);

  const fx: FxMap = useMemo(() => {
    const m: FxMap = {};
    currencies.forEach((c) => { m[c.code] = Number(c.rate_to_idr); });
    return m;
  }, [currencies]);
  const fxUpdatedAt = useMemo(
    () => currencies.reduce<string | null>((l, c) => (c.updated_at && (!l || c.updated_at > l) ? c.updated_at : l), null),
    [currencies]
  );

  // Live feed without a manual routine: if the cached FX is stale, refresh it once in the background on
  // load (the same Frankfurter pull as Settings, just automatic). Silent — cached values stay if it fails.
  const fxTried = useRef(false);
  useEffect(() => {
    if (fxTried.current) return;
    fxTried.current = true;
    const stale = !fxUpdatedAt || Date.now() - new Date(fxUpdatedAt).getTime() > FX_STALE_MS;
    if (stale) refreshFx().then(setCurrencies).catch(() => {});
  }, [fxUpdatedAt]);

  const prefs = initialPrefs;
  const [methodId, setMethodId] = useState<string>(prefs?.method_id || methods[0]?.id || '');
  const [purchasePrice, setPurchasePrice] = useState(279);
  const [localShipping, setLocalShipping] = useState(0);
  const [realWeightG, setRealWeightG] = useState(600);
  const [boxP, setBoxP] = useState(34);
  const [boxL, setBoxL] = useState(1);
  const [boxT, setBoxT] = useState(34);
  const [coefficient, setCoefficient] = useState<number>(prefs?.coefficient ?? 0.40);
  const [marketplaceActive, setMarketplaceActive] = useState<boolean>(prefs?.marketplace_active ?? false);
  const [marketplaceRate, setMarketplaceRate] = useState<number>(prefs?.marketplace_rate ?? 7.5);

  const method = methods.find((m) => m.id === methodId) || methods[0];
  const taxRate = method?.import_tax_rate ?? 18.25; // per-method, managed in Settings
  // Whether import tax is charged is fixed per method in Settings (tax_included = bundled/all-in → 0).

  // persist form defaults (debounced); skip the initial mount so a page load doesn't write
  const firstPrefs = useRef(true);
  useEffect(() => {
    if (firstPrefs.current) { firstPrefs.current = false; return; }
    const h = setTimeout(() => {
      void savePrefs({ method_id: methodId, tax_rate: taxRate, coefficient, marketplace_active: marketplaceActive, marketplace_rate: marketplaceRate }).catch(() => {});
    }, 600);
    return () => clearTimeout(h);
  }, [methodId, taxRate, coefficient, marketplaceActive, marketplaceRate]);

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

  function reset() {
    if (!confirm('Reset all inputs to defaults?')) return;
    setPurchasePrice(0); setLocalShipping(0); setRealWeightG(0); setBoxP(0); setBoxL(0); setBoxT(0); setCoefficient(0.40); setMarketplaceActive(false);
  }

  const volEmpty = !boxP || !boxL || !boxT;
  const sym = method ? ccySym(method.source_currency) : '';

  return (
    <div className="ops">
      <AppHeader active="calculator" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Calculator' }]} />

      <div className="calc-wrap">
        {!method ? (
          <div className="hint">No shipping methods configured — add them in Settings › Calculator.</div>
        ) : (
          <>
            {/* result headline — rec price · margin · coefficient */}
            <div className="calc-headline">
              <div className="calc-hl-cell">
                <div className="calc-hl-label">Rec. sale price</div>
                <div className="calc-hl-value">{c ? fmtRp(c.rec_sale_price) : 'Rp —'}</div>
              </div>
              <div className="calc-hl-cell">
                <div className="calc-hl-label">Margin if −10%</div>
                <div className="calc-hl-value sub">{c ? fmtRp(c.low_margin_idr) : 'Rp —'}</div>
              </div>
              <div className="calc-hl-cell calc-hl-coef">
                <div className="calc-hl-label">Coefficient</div>
                <input className="no-spin" type="number" min={0} max={0.9} step={0.01} value={coefficient}
                  onChange={(e) => setCoefficient(Math.min(0.9, Math.max(0, +e.target.value || 0)))} />
              </div>
            </div>

            <div className="calc-grid">
              {/* LEFT — inputs */}
              <div className="calc-col-inputs">
                {/* shipping method + its read-only datapoints, in one outlined box. Tax is fixed by the
                    method's Settings (charge import tax → the rate, else 0%). */}
                <div className="po-form calc-method-box">
                  <div className="po-field">
                    <label>Shipping method</label>
                    <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                      {methods.map((m) => <option key={m.id} value={m.id}>{methodLabel(m)}</option>)}
                    </select>
                  </div>
                  <div className="calc-meta calc-meta-4">
                    <Meta l="FX → IDR" v={c ? fmtNum(c.fx_source, 2) : '—'} />
                    <Meta l="Shipping" v={`${fmtNum(method.rate_per_kg, 0)} ${method.rate_currency}/kg`} />
                    <Meta l="Extra" v={`${sym}${fmtNum(method.warehouse_fee, 2)}`} />
                    <Meta l="Import tax" v={method.tax_included ? '0%' : `${fmtNum(taxRate, 2)}%`} />
                  </div>
                </div>

                <div className="po-form">
                  <div className="po-inline">
                    <div className="po-field"><label>Purchase price</label><div className="calc-inrow"><span className="calc-pre">{sym}</span><input type="number" min={0} step={0.01} value={purchasePrice} onChange={(e) => setPurchasePrice(+e.target.value || 0)} /></div></div>
                    <div className="po-field"><label>Local shipping</label><div className="calc-inrow"><span className="calc-pre">{sym}</span><input type="number" min={0} step={0.01} value={localShipping} onChange={(e) => setLocalShipping(+e.target.value || 0)} /></div></div>
                  </div>
                  <div className="po-field">
                    <label>Product dimensions &amp; weight</label>
                    <div className="calc-dimwt">
                      <input className="no-spin" type="number" min={0} step={0.1} value={boxP} placeholder="P" onChange={(e) => setBoxP(+e.target.value || 0)} />
                      <span className="calc-x">×</span>
                      <input className="no-spin" type="number" min={0} step={0.1} value={boxL} placeholder="L" onChange={(e) => setBoxL(+e.target.value || 0)} />
                      <span className="calc-x">×</span>
                      <input className="no-spin" type="number" min={0} step={0.1} value={boxT} placeholder="T" onChange={(e) => setBoxT(+e.target.value || 0)} />
                      <span className="calc-unit">cm</span>
                    </div>
                    <div className="calc-wtrow">
                      <div className="calc-inrow calc-wt-input"><input className="no-spin" type="number" min={0} step={0.1} value={realWeightG} placeholder="weight" onChange={(e) => setRealWeightG(+e.target.value || 0)} /><span className="calc-unit">g</span></div>
                      <div className="calc-wt-notes">
                        <span>{volEmpty ? 'fill all 3 dims →' : c ? `${fmtNum(c.vol_weight_g, 0)} g volumetric` : '—'}</span>
                        <span>{c ? `${fmtNum(c.effective_kg * 1000, 0)} g effective` : '—'}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="po-form">
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
              </div>

              {/* RIGHT — sticky breakdown */}
              <aside className="calc-col-results">
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
                {validation.cls !== 'ok' && <div className={`validation ${validation.cls}`} style={{ marginTop: 12 }}>{validation.text}</div>}
                <div className="calc-actions">
                  <button className="btn-secondary" onClick={reset}>Reset</button>
                </div>
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

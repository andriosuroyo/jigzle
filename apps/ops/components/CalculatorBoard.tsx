'use client';

// Pricing Calculator (PR93) — ported from the standalone jigzle-calculator app into ops and restyled
// to the jigzle design language (AppHeader + breadcrumbs + ops cards/forms). Three views: Calculator
// (landed cost → recommended sale price), History (saved calcs + detail modal), Rates (FX + shipping
// methods). Writes go through server actions; the maths is the shared @jigzle/lib compute(), so the
// numbers match the old app formula-for-formula.

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import { compute, fmtNum, fmtRp, type FxMap } from '@jigzle/lib';
import type { Currency, ShippingMethod, SavedCalculation, UserPrefs } from '@jigzle/db/types';
import { deleteCalculation, refreshFx, saveCalculation, savePrefs } from '@/app/calculator/actions';

type View = 'calculator' | 'history' | 'rates';
const VIEW_LABEL: Record<View, string> = { calculator: 'Calculator', history: 'History', rates: 'Rates' };

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

// one detail-modal row (label · value)
function DRow({ l, r }: { l: string; r: string }) {
  return <div className="calc-drow"><span>{l}</span><span>{r}</span></div>;
}

export default function CalculatorBoard({
  initialMethods,
  initialCurrencies,
  initialCalculations,
  initialPrefs,
  userEmail,
}: {
  initialMethods: ShippingMethod[];
  initialCurrencies: Currency[];
  initialCalculations: SavedCalculation[];
  initialPrefs: UserPrefs | null;
  userEmail: string;
}) {
  const [view, setView] = useState<View>('calculator');
  const methods = initialMethods;
  const [currencies, setCurrencies] = useState<Currency[]>(initialCurrencies);
  const [calculations, setCalculations] = useState<SavedCalculation[]>(initialCalculations);
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

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

  const [detailId, setDetailId] = useState<string | null>(null);
  const detailCalc = detailId ? calculations.find((c) => c.id === detailId) ?? null : null;
  const [histSearch, setHistSearch] = useState('');
  const [fxStatus, setFxStatus] = useState<{ kind: 'idle' | 'fetching' | 'err'; text: string }>({ kind: 'idle', text: '' });

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
    if (c.fx_source === 0) return { cls: 'err', text: `⚠ No FX rate for ${method.source_currency}. Refresh in Rates.` };
    return { cls: 'ok', text: '✓ Calculation complete.' };
  }, [method, c, purchasePrice, realWeightG, boxP, boxL, boxT, coefficient, marketplaceActive, marketplaceRate]);

  const fxHint = useMemo(() => {
    if (!fxUpdatedAt) return 'Cached defaults. Refresh in Rates.';
    const days = Math.floor((Date.now() - new Date(fxUpdatedAt).getTime()) / 86_400_000);
    return days === 0 ? 'Live · refreshed today' : `Live · refreshed ${days}d ago`;
  }, [fxUpdatedAt]);

  function switchView(v: View) { setView(v); window.scrollTo(0, 0); }

  async function doSave() {
    if (!method || !c) return;
    setBusy(true);
    try {
      const saved = await saveCalculation({
        sku: sku || '', method_id: method.id, method_display: method.display, source_country: method.source_country,
        source_currency: method.source_currency, rate_currency: method.rate_currency, shipping_rate: method.rate_per_kg,
        warehouse_fee: method.warehouse_fee, tax_included: method.tax_included, fx_source: c.fx_source, fx_rate_ship: c.fx_rate_ship,
        tax_rate: taxRate, purchase_price: purchasePrice, local_shipping: localShipping, real_weight_g: realWeightG,
        box_p: boxP, box_l: boxL, box_t: boxT, coefficient, marketplace_active: marketplaceActive, marketplace_rate: marketplaceRate,
        item_cost_idr: c.item_cost_idr, shipping_cost_idr: c.shipping_cost_idr, import_tax_idr: c.import_tax_idr,
        marketplace_fee_idr: c.marketplace_fee_idr, total_cost_idr: c.total_cost_idr, rec_sale_price: c.rec_sale_price, low_margin_idr: c.low_margin_idr,
      });
      setCalculations((prev) => [saved, ...prev]);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(id: string) {
    if (!confirm('Delete this calculation?')) return;
    try {
      await deleteCalculation(id);
      setCalculations((prev) => prev.filter((x) => x.id !== id));
      setDetailId(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  function duplicate(x: SavedCalculation) {
    setMethodId(x.method_id); setTaxRate(Number(x.tax_rate)); setSku(x.sku || '');
    setPurchasePrice(Number(x.purchase_price)); setLocalShipping(Number(x.local_shipping)); setRealWeightG(Number(x.real_weight_g));
    setBoxP(Number(x.box_p)); setBoxL(Number(x.box_l)); setBoxT(Number(x.box_t)); setCoefficient(0.40);
    setMarketplaceActive(x.marketplace_active); setMarketplaceRate(Number(x.marketplace_rate));
    setDetailId(null); switchView('calculator');
  }

  function reset() {
    if (!confirm('Reset all inputs to defaults?')) return;
    setSku(''); setPurchasePrice(0); setLocalShipping(0); setRealWeightG(0); setBoxP(0); setBoxL(0); setBoxT(0); setCoefficient(0.40); setMarketplaceActive(false);
  }

  async function doRefreshFx() {
    setFxStatus({ kind: 'fetching', text: 'Fetching from Frankfurter…' });
    try {
      const fresh = await refreshFx();
      setCurrencies(fresh);
      setFxStatus({ kind: 'idle', text: '' });
    } catch (e) {
      setFxStatus({ kind: 'err', text: `Fetch failed: ${e instanceof Error ? e.message : ''}. Using cached values.` });
    }
  }

  const filtered = useMemo(() => {
    const s = histSearch.trim().toLowerCase();
    if (!s) return calculations;
    return calculations.filter((x) => (x.sku || '').toLowerCase().includes(s) || (x.method_display || '').toLowerCase().includes(s) || (x.source_currency || '').toLowerCase().includes(s));
  }, [calculations, histSearch]);

  const volEmpty = !boxP || !boxL || !boxT;

  return (
    <div className="ops">
      <AppHeader active="calculator" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Calculator', href: '/calculator' }, { label: VIEW_LABEL[view] }]} />

      <div className="orders-bar">
        <nav className="orders-tabs" role="tablist" aria-label="Calculator">
          {(['calculator', 'history', 'rates'] as View[]).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={`orders-tab ${view === v ? 'active' : ''}`} onClick={() => switchView(v)}>{VIEW_LABEL[v]}</button>
          ))}
        </nav>
      </div>

      <div className="orders-panels calc-wrap">
        {!method && <div className="hint">No shipping methods configured — add rows to <code>shipping_methods</code> in Supabase.</div>}

        {/* ── CALCULATOR ── */}
        {method && view === 'calculator' && (
          <>
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
                <div className="po-field"><label>SKU <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(optional)</em></label><input type="text" placeholder="e.g. 3DC-50001" value={sku} onChange={(e) => setSku(e.target.value)} /></div>
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
            </section>

            <div className={`validation ${validation.cls}`}>{validation.text}</div>

            <div className="calc-actions">
              <button className="btn-secondary" onClick={reset}>Reset</button>
              <button className="btn-primary" onClick={doSave} disabled={busy}>{savedFlash ? '✓ Saved' : busy ? 'Saving…' : 'Save calculation'}</button>
            </div>
          </>
        )}

        {/* ── HISTORY ── */}
        {view === 'history' && (
          <div className="calc-hist">
            <input className="calc-hist-search" type="text" placeholder="Search SKU, route, currency…" value={histSearch} onChange={(e) => setHistSearch(e.target.value)} />
            {filtered.length === 0 ? (
              <div className="hint">No saved calculations yet. Save one from the Calculator tab.</div>
            ) : (
              <ul className="calc-hist-list">
                {filtered.map((x) => {
                  const dt = new Date(x.created_at);
                  const dtStr = `${dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} · ${dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
                  const parts = x.method_display.split('—');
                  const route = parts[1] ? parts.slice(1).join('—').trim() : x.method_display;
                  return (
                    <li key={x.id}>
                      <button className="calc-hist-item" onClick={() => setDetailId(x.id)}>
                        <div className="calc-hist-top"><span className="calc-hist-sku">{x.sku || '— no SKU —'}</span><span className="calc-hist-price">{fmtRp(Number(x.rec_sale_price))}</span></div>
                        <div className="hint">{x.source_country} · {route} · {dtStr}</div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* ── RATES ── */}
        {view === 'rates' && (
          <div className="calc-rates">
            <div className="fd-section-head">FX rates to IDR</div>
            <div className={`calc-fx-refresh ${fxStatus.kind}`}>
              <span className="hint">{fxStatus.text || (fxUpdatedAt ? `Live · refreshed ${new Date(fxUpdatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Cached defaults · tap Refresh live')}</span>
              <button className="btn-secondary" onClick={doRefreshFx} disabled={fxStatus.kind === 'fetching'}>{fxStatus.kind === 'fetching' ? '…' : 'Refresh live'}</button>
            </div>
            <div className="calc-fx-grid">
              {currencies.filter((x) => x.code !== 'IDR').map((cur) => (
                <div key={cur.code} className="calc-fx-card"><span className="calc-fx-code">{cur.code}</span><span className="calc-fx-rate">{fmtNum(Number(cur.rate_to_idr), 4)}</span></div>
              ))}
            </div>

            <div className="fd-section-head" style={{ marginTop: 18 }}>Shipping methods</div>
            <ul className="calc-methods">
              {methods.map((m) => (
                <li key={m.id} className="calc-method">
                  <div className="calc-method-top"><span className="calc-method-name">{m.display}</span><span className="calc-method-rate">{fmtNum(Number(m.rate_per_kg), 0)} {m.rate_currency}/kg</span></div>
                  <div className="calc-pills">
                    <span className="calc-pill">{m.source_country}</span>
                    <span className="calc-pill">{m.rate_currency} rate</span>
                    {m.tax_included && <span className="calc-pill tax">tax included</span>}
                    {Number(m.warehouse_fee) > 0 && <span className="calc-pill">+{m.warehouse_fee} {m.source_currency} wh</span>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── detail modal ── */}
      {detailCalc && (
        <div className="sc-modal-backdrop" onClick={() => setDetailId(null)}>
          <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Saved calculation" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">{detailCalc.sku || 'Calculation'}</span>
              <button className="sc-modal-x" onClick={() => setDetailId(null)} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              <div className="calc-headline">
                <div className="calc-hl-cell"><div className="calc-hl-label">Rec. sale price</div><div className="calc-hl-value">{fmtRp(Number(detailCalc.rec_sale_price))}</div></div>
                <div className="calc-hl-cell"><div className="calc-hl-label">Margin if −10%</div><div className="calc-hl-value sub">{fmtRp(Number(detailCalc.low_margin_idr))}</div></div>
              </div>

              <div className="fd-section-head">Inputs</div>
              <DRow l="SKU" r={detailCalc.sku || '—'} />
              <DRow l="Method" r={detailCalc.method_display} />
              <DRow l="Purchase price" r={`${fmtNum(Number(detailCalc.purchase_price), 2)} ${detailCalc.source_currency}`} />
              <DRow l="Local shipping" r={`${fmtNum(Number(detailCalc.local_shipping), 2)} ${detailCalc.source_currency}`} />
              <DRow l="Real weight" r={`${fmtNum(Number(detailCalc.real_weight_g), 0)} g`} />
              <DRow l="Box dims" r={`${detailCalc.box_p} × ${detailCalc.box_l} × ${detailCalc.box_t} cm`} />
              <DRow l="Coefficient" r={fmtNum(Number(detailCalc.coefficient), 2)} />
              <DRow l="Marketplace fee" r={detailCalc.marketplace_active ? `${Number(detailCalc.marketplace_rate).toFixed(2)}%` : 'not applied'} />

              <div className="fd-section-head" style={{ marginTop: 12 }}>Snapshots at save</div>
              <DRow l="FX rate" r={fmtNum(Number(detailCalc.fx_source), 4)} />
              <DRow l="Shipping rate" r={`${fmtNum(Number(detailCalc.shipping_rate), 0)} ${detailCalc.rate_currency}/kg`} />
              <DRow l="Import tax rate" r={`${fmtNum(Number(detailCalc.tax_rate), 2)}%`} />
              <DRow l="Tax included?" r={detailCalc.tax_included ? 'Yes' : 'No'} />
              <DRow l="Warehouse fee" r={`${fmtNum(Number(detailCalc.warehouse_fee), 2)} ${detailCalc.source_currency}`} />

              <div className="fd-section-head" style={{ marginTop: 12 }}>Computed</div>
              <DRow l="Item cost" r={fmtRp(Number(detailCalc.item_cost_idr))} />
              <DRow l="Shipping cost" r={fmtRp(Number(detailCalc.shipping_cost_idr))} />
              <DRow l="Import tax" r={fmtRp(Number(detailCalc.import_tax_idr))} />
              <DRow l="Marketplace fee" r={fmtRp(Number(detailCalc.marketplace_fee_idr))} />
              <DRow l="Total cost" r={fmtRp(Number(detailCalc.total_cost_idr))} />

              <div className="calc-actions" style={{ marginTop: 16 }}>
                <button className="btn-secondary danger" onClick={() => doDelete(detailCalc.id)}>Delete</button>
                <button className="btn-primary" onClick={() => duplicate(detailCalc)}>Duplicate to new</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

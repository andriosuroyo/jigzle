'use client';

// Settings → Calculator → Rates (PR396). The Calculator's reference data, moved out of the tool itself:
// live FX rates to IDR (with a Refresh-live action) + the shipping-method rate cards. Self-loads on mount.

import { useEffect, useState } from 'react';
import { fmtNum } from '@jigzle/lib';
import type { Currency, ShippingMethod } from '@jigzle/db/types';
import { getCalcCurrencies, getCalcMethods, refreshFx } from '@/app/calculator/actions';

export default function CalculatorRatesSettings({ embedded = false }: { embedded?: boolean }) {
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [methods, setMethods] = useState<ShippingMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [fxStatus, setFxStatus] = useState<{ kind: 'idle' | 'fetching' | 'err'; text: string }>({ kind: 'idle', text: '' });

  useEffect(() => {
    Promise.all([getCalcCurrencies(), getCalcMethods()])
      .then(([cs, ms]) => { setCurrencies(cs); setMethods(ms); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const fxUpdatedAt = currencies.reduce<string | null>((l, c) => (c.updated_at && (!l || c.updated_at > l) ? c.updated_at : l), null);

  async function doRefreshFx() {
    setFxStatus({ kind: 'fetching', text: 'Fetching from Frankfurter…' });
    try {
      setCurrencies(await refreshFx());
      setFxStatus({ kind: 'idle', text: '' });
    } catch (e) {
      setFxStatus({ kind: 'err', text: `Fetch failed: ${e instanceof Error ? e.message : ''}. Using cached values.` });
    }
  }

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? '' : 'set-sec'}>
      {!embedded && <div className="set-sec-title">Calculator rates</div>}
      <div className="set-sec-sub">The Calculator’s reference data — live FX rates and the shipping-method rate cards used to compute a landed cost.</div>

      <div className="fd-section-head" style={{ marginTop: 10 }}>FX rates to IDR</div>
      <div className={`calc-fx-refresh ${fxStatus.kind}`}>
        <span className="hint">{fxStatus.text || (fxUpdatedAt ? `Live · refreshed ${new Date(fxUpdatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Cached defaults · tap Refresh live')}</span>
        <button className="btn-secondary" onClick={doRefreshFx} disabled={fxStatus.kind === 'fetching'}>{fxStatus.kind === 'fetching' ? '…' : 'Refresh live'}</button>
      </div>
      {loading ? <div className="hint">Loading…</div> : (
        <div className="calc-fx-grid">
          {currencies.filter((x) => x.code !== 'IDR').map((cur) => (
            <div key={cur.code} className="calc-fx-card"><span className="calc-fx-code">{cur.code}</span><span className="calc-fx-rate">{fmtNum(Number(cur.rate_to_idr), 4)}</span></div>
          ))}
        </div>
      )}

      <div className="fd-section-head" style={{ marginTop: 18 }}>Shipping methods</div>
      {loading ? <div className="hint">Loading…</div> : (
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
      )}
    </Wrap>
  );
}

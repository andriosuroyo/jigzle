'use client';

// Clover Royalty (PR392). Pick an entity → see the unpaid total (IDR + USD) and every royalty-owing
// sold-and-shipped line as a card (image · SKU · name · sold date · Paid/Unpaid). "Sold" = PAID + SENT
// (order_lines.shipped_at, order payment_status='Paid'); new orders that aren't fully paid-and-sent don't
// count. Totals are view-only; each line can be marked paid/unpaid, and there's a bulk "Mark all as paid".

import { useEffect, useMemo, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import { fmtRp, fmtNiceDate, fmtNum } from '@jigzle/lib';
import { getRoyaltyLedger, setRoyaltyPaid } from '@/app/royalty/actions';
import type { RoyaltyEntity, RoyaltyLedger } from '@/app/royalty/types';

// Foreign-currency display carries a +5% buffer so a payout budgeted here still covers FX drift.
const FX_BUFFER = 1.05;
const CCYS = [
  { code: 'IDR', flag: '🇮🇩' },
  { code: 'USD', flag: '🇺🇸' },
  { code: 'EUR', flag: '🇪🇺' },
] as const;
type Ccy = (typeof CCYS)[number]['code'];

export default function RoyaltyBoard({ entities, userEmail }: { entities: RoyaltyEntity[]; userEmail: string }) {
  const [entity, setEntity] = useState<string>(entities[0]?.name ?? '');
  const [ledger, setLedger] = useState<RoyaltyLedger | null>(null);
  const [ccy, setCcy] = useState<Ccy>('IDR');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Show an IDR amount in the selected currency. IDR is native; USD/EUR convert via the rate + buffer.
  function fmtCcy(idr: number): string {
    if (ccy === 'IDR') return fmtRp(idr);
    const rate = ledger?.rates?.[ccy] ?? null;
    if (!rate) return '—';
    const sym = ccy === 'USD' ? '$' : '€';
    return `${sym}${fmtNum((idr / rate) * FX_BUFFER, 2)}`;
  }

  async function load(name: string) {
    if (!name) { setLedger(null); return; }
    setLoading(true); setError(null);
    try { setLedger(await getRoyaltyLedger(name)); }
    catch { setError('Could not load royalties.'); setLedger(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(entity); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [entity]);

  const codes = useMemo(() => (ledger?.lines.map((l) => l.item_code).filter(Boolean) as string[]) ?? [], [ledger]);
  const imgMap = useSkuImages(codes);

  async function markAllPaid() {
    if (!ledger) return;
    const unpaid = ledger.lines.filter((l) => !l.paid).map((l) => l.line_id);
    if (!unpaid.length) return;
    setBusy(true); setError(null);
    const { error } = await setRoyaltyPaid(unpaid, true);
    if (error) setError(error); else await load(entity);
    setBusy(false);
  }

  const unpaidCount = ledger?.lines.filter((l) => !l.paid).length ?? 0;

  return (
    <div className="ops">
      <AppHeader active="royalty" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Clover Royalty' }]} />

      <div className="roy-wrap">
        {/* entity selector */}
        <div className="sc-tabs roy-entity-tabs" role="tablist" aria-label="Royalty entity">
          {entities.map((e) => (
            <button key={e.id} role="tab" aria-selected={entity === e.name}
              className={`sc-tab ${entity === e.name ? 'active' : ''}`} onClick={() => setEntity(e.name)}>
              {e.name}
            </button>
          ))}
        </div>
        {entities.length === 0 && <div className="hint">No royalty entities yet — add them in Settings → Clover Royalty.</div>}

        {error && <div className="validation err" style={{ margin: '10px 0' }}>{error}</div>}

        {/* totals (view-only) + currency selector + Mark all */}
        <div className="roy-totals">
          <div className="roy-total-card">
            <div className="roy-total-label">Unpaid</div>
            <div className="roy-total-idr">{fmtCcy(ledger?.unpaid_idr ?? 0)}</div>
          </div>
          <div className="roy-total-card roy-total-paid">
            <div className="roy-total-label">Paid to date</div>
            <div className="roy-total-idr">{fmtCcy(ledger?.paid_idr ?? 0)}</div>
          </div>
          <div className="roy-total-side">
            <div className="roy-ccy" role="group" aria-label="Display currency">
              {CCYS.map((c) => (
                <button key={c.code} type="button" className={`roy-ccy-btn ${ccy === c.code ? 'active' : ''}`}
                  aria-pressed={ccy === c.code} onClick={() => setCcy(c.code)}>
                  <span aria-hidden="true">{c.flag}</span> {c.code}
                </button>
              ))}
            </div>
            {unpaidCount > 0 && (
              <button className="btn-primary roy-markall" onClick={markAllPaid} disabled={busy}>Mark all {unpaidCount} as paid</button>
            )}
          </div>
        </div>

        {/* the line cards — Sales-style: 36px image + exactly two left/right-justified lines */}
        {loading ? <div className="hint">Loading…</div> : !ledger ? null : ledger.lines.length === 0 ? (
          <div className="hint fq-empty">No paid-and-sent sales for {entity} yet.</div>
        ) : (
          <ul className="roy-list">
            {ledger.lines.map((l) => (
              <li key={l.line_id}>
                <div className={`roy-card ${l.paid ? 'is-paid' : ''}`}>
                  <SkuImage status={l.item_code ? imgMap[l.item_code]?.status : undefined} displayUrl={l.item_code ? imgMap[l.item_code]?.displayUrl : undefined} name={l.name} size={SKU_IMG.sm} />
                  <div className="roy-card-body">
                    <div className="roy-line">
                      <span className="roy-code">{l.item_code ?? '—'}</span>
                      <span className="roy-sold">{l.sold_date ? fmtNiceDate(l.sold_date) : '—'}</span>
                    </div>
                    <div className="roy-line">
                      <span className="roy-name">{l.name}{l.qty > 1 ? ` ×${l.qty}` : ''}</span>
                      <span className="roy-right">
                        <span className="roy-amt">{fmtRp(l.royalty_idr)}</span>
                        <span className={`po-status ${l.paid ? 'forwarder' : 'processing'}`}>{l.paid ? (l.paid_date ? `Paid ${fmtNiceDate(l.paid_date)}` : 'Paid') : 'Unpaid'}</span>
                      </span>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

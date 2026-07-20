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

export default function RoyaltyBoard({ entities, userEmail }: { entities: RoyaltyEntity[]; userEmail: string }) {
  const [entity, setEntity] = useState<string>(entities[0]?.name ?? '');
  const [ledger, setLedger] = useState<RoyaltyLedger | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function toggle(lineId: string, paid: boolean) {
    setBusy(true); setError(null);
    const { error } = await setRoyaltyPaid([lineId], paid);
    if (error) setError(error); else await load(entity);
    setBusy(false);
  }
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

        {/* unpaid totals (view-only) */}
        <div className="roy-totals">
          <div className="roy-total-card">
            <div className="roy-total-label">Unpaid</div>
            <div className="roy-total-idr">{fmtRp(ledger?.unpaid_idr ?? 0)}</div>
            <div className="roy-total-usd">
              {ledger?.unpaid_usd != null ? `≈ $${fmtNum(ledger.unpaid_usd, 2)}` : '—'}
              {ledger?.usd_rate ? <span className="roy-rate-note"> · 1 USD = Rp {fmtNum(ledger.usd_rate, 0)}</span> : null}
            </div>
          </div>
          <div className="roy-total-card roy-total-paid">
            <div className="roy-total-label">Paid to date</div>
            <div className="roy-total-idr">{fmtRp(ledger?.paid_idr ?? 0)}</div>
            <div className="roy-total-usd">{ledger ? `${ledger.lines.length} lines · ${unpaidCount} unpaid` : ''}</div>
          </div>
        </div>

        {unpaidCount > 0 && (
          <div className="td-actions" style={{ marginBottom: 10 }}>
            <button className="btn-primary" onClick={markAllPaid} disabled={busy}>Mark all {unpaidCount} as paid</button>
          </div>
        )}

        {/* the line cards */}
        {loading ? <div className="hint">Loading…</div> : !ledger ? null : ledger.lines.length === 0 ? (
          <div className="hint fq-empty">No paid-and-sent sales for {entity} yet.</div>
        ) : (
          <ul className="fq-list">
            {ledger.lines.map((l) => (
              <li key={l.line_id}>
                <div className={`fq-row roy-card ${l.paid ? 'is-paid' : ''}`}>
                  <div className="cat-row">
                    <SkuImage status={l.item_code ? imgMap[l.item_code]?.status : undefined} displayUrl={l.item_code ? imgMap[l.item_code]?.displayUrl : undefined} name={l.name} size={SKU_IMG.sm} />
                    <div className="cat-row-main">
                      <div className="fq-row-top">
                        <span className="fq-id">{l.item_code ?? '—'}</span>
                        <span className={`po-status ${l.paid ? 'forwarder' : 'processing'}`} style={{ marginLeft: 'auto' }}>{l.paid ? 'Paid' : 'Unpaid'}</span>
                      </div>
                      <div className="fq-row-bot">
                        <span className="cat-row-name">{l.name}</span>
                      </div>
                      <div className="roy-card-meta">
                        <span>Sold {l.sold_date ? fmtNiceDate(l.sold_date) : '—'}</span>
                        {l.qty > 1 && <span>×{l.qty}</span>}
                        <span className="roy-card-amt">{fmtRp(l.royalty_idr)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="roy-card-act">
                    {l.paid
                      ? <button className="btn-secondary" onClick={() => toggle(l.line_id, false)} disabled={busy}>Mark unpaid</button>
                      : <button className="btn-brown" onClick={() => toggle(l.line_id, true)} disabled={busy}>Mark paid</button>}
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

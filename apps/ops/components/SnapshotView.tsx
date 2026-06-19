'use client';

// Snapshot view (docs/016 §7) — any past session, read-only: confirmed / counted vs expected vs
// delta, as frozen at close. Reads the stamped stock_check_lines (no live recompute). PR21 §2 — the
// table is now a 2-line image-card list (mirrors the live count rows) + the in-session two-line header.

import { useEffect, useMemo, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { getSessionLines } from '@/app/stock-check/actions';
import { modeLabel, modeVerb } from '@/app/stock-check/types';
import type { LineRow, SessionRow } from '@/app/stock-check/types';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function SnapshotView({ session, onExit }: { session: SessionRow; onExit: () => void }) {
  const [lines, setLines] = useState<LineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const l = await getSessionLines(session.stock_check_id);
        if (on) setLines(l);
      } catch (e) {
        if (on) setError(e instanceof Error ? e.message : 'Failed to load the snapshot.');
      } finally {
        if (on) setLoading(false);
      }
    })();
    return () => { on = false; };
  }, [session.stock_check_id]);

  const imgCodes = useMemo(() => lines.map((l) => l.item_code), [lines]);
  const imgMap = useSkuImages(imgCodes);

  const net = lines.reduce((s, l) => s + (l.delta ?? 0), 0);

  return (
    <div className="sc-wrap">
      <div className="sc-sess-head">
        <div className="sc-sess-row1">
          <button className="btn-link" onClick={onExit}>← sessions</button>
          <span className="sc-sess-actions">
            <span className={`sc-badge ${session.status}`}>{session.status}</span>
            <span className="sc-prog">net {net > 0 ? `+${net}` : net}</span>
          </span>
        </div>
        <div className="sc-sess-row2">
          {modeLabel(session.mode)} · {session.scope === 'all_active' ? 'all active' : (session.scope_brands ?? []).join(', ')} · {modeVerb(session.mode)} {session.counted_by} · closed {fmtDate(session.closed_at)}
        </div>
      </div>

      {error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}

      <div className="sc-snap-list">
        {loading && <div className="sc-empty">Loading…</div>}
        {!loading && lines.length === 0 && <div className="sc-empty">No lines.</div>}
        {lines.map((l) => {
          const status = l.added_missing ? 'added'
            : l.confirmed ? '✓'
            : l.review_action === 'zeroed' ? 'set 0'
            : l.review_action === 'ignored' ? 'left' : '—';
          const nums = l.counted_qty != null
            ? `${l.counted_qty} / ${l.expected_physical ?? 0}`
            : `exp ${l.expected_physical ?? 0}`;
          return (
            <div key={l.line_id} className="sc-snap-row">
              <SkuImage status={imgMap[l.item_code]?.status} displayUrl={imgMap[l.item_code]?.displayUrl} name={l.name} size={40} />
              <span className="sc-row-id">
                <span className="ff-code">{l.item_code}</span>
                <span className="ff-name">{l.name}</span>
              </span>
              <span className="sc-snap-meta">
                <span className={`sc-delta ${l.delta ? (l.delta > 0 ? 'pos' : 'neg') : 'zero'}`}>
                  {l.delta == null ? '—' : l.delta > 0 ? `+${l.delta}` : l.delta}
                </span>
                <span className="sc-snap-sub">{status} · {nums}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="inv-count">{lines.length} SKU{lines.length === 1 ? '' : 's'} · read-only snapshot</div>
    </div>
  );
}

'use client';

// Snapshot view (docs/016 §7) — any past session, read-only: confirmed / counted vs expected vs
// delta, as frozen at close. Reads the stamped stock_check_lines (no live recompute).

import { useEffect, useMemo, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { getSessionLines } from '@/app/stock-check/actions';
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

  const isCount = session.mode === 'count';
  const net = lines.reduce((s, l) => s + (l.delta ?? 0), 0);

  return (
    <div className="sc-wrap">
      <div className="sc-sess-head">
        <button className="btn-link" onClick={onExit}>← sessions</button>
        <div className="sc-sess-head-main">
          <div className="sc-sess-title">
            {isCount ? 'Count' : 'Presence'} · {session.counted_by} <span className={`sc-badge ${session.status}`}>{session.status}</span>
          </div>
          <div className="sc-sess-sub">
            {session.scope === 'all_active' ? 'all active' : (session.scope_brands ?? []).join(', ')} · closed {fmtDate(session.closed_at)} · net {net > 0 ? `+${net}` : net}
          </div>
        </div>
      </div>

      {error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}

      <div className="inv-table-wrap" style={{ marginTop: 12 }}>
        <table className="inv-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th>Status</th>
              {isCount && <th className="num">Counted</th>}
              <th className="num">Expected</th>
              <th className="num">Delta</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td className="inv-empty" colSpan={isCount ? 6 : 5}>Loading…</td></tr>
            )}
            {!loading && lines.length === 0 && (
              <tr><td className="inv-empty" colSpan={isCount ? 6 : 5}>No lines.</td></tr>
            )}
            {lines.map((l) => (
              <tr key={l.line_id}>
                <td className="inv-code">
                  <span className="inv-code-cell">
                    <SkuImage status={imgMap[l.item_code]?.status} displayUrl={imgMap[l.item_code]?.displayUrl} name={l.name} size={26} />
                    {l.item_code}
                  </span>
                </td>
                <td className="inv-name">{l.name}</td>
                <td>
                  {l.added_missing ? 'added' : l.confirmed ? '✓' : l.review_action === 'zeroed' ? 'set 0' : l.review_action === 'ignored' ? 'left' : '—'}
                </td>
                {isCount && <td className="num inv-num">{l.counted_qty ?? '—'}</td>}
                <td className="num inv-num">{l.expected_physical ?? '—'}</td>
                <td className={`num inv-num ${l.delta ? (l.delta > 0 ? 'sc-pos' : 'sc-neg') : 'zero'}`}>
                  {l.delta == null ? '—' : l.delta > 0 ? `+${l.delta}` : l.delta}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="inv-count">{lines.length} SKU{lines.length === 1 ? '' : 's'} · read-only snapshot</div>
    </div>
  );
}

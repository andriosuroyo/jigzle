'use client';

// Stock Check board (docs/016 §7). Top-level pane: two tabs — Counts (sessions: open + history/
// snapshots; "New count" → mode + scope + counted_by) and Adjustments (the ledger). Opening a
// session routes into the mode UI (Presence checklist / Count scanner); a closed session opens its
// read-only snapshot. The cosmetic batch will re-home the nav entry under SYSTEM; here it's added to
// the current flat AppHeader.

import { useEffect, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import PresenceSession from '@/components/PresenceSession';
import CountSession from '@/components/CountSession';
import SnapshotView from '@/components/SnapshotView';
import AdjustmentsTab from '@/components/AdjustmentsTab';
import { getSessions, openStockCheck } from '@/app/stock-check/actions';
import { modeLabel } from '@/app/stock-check/types';
import type { BrandOption, NewCountInput, SessionRow, StockCheckMode, StockCheckScope } from '@/app/stock-check/types';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function scopeLabel(s: SessionRow): string {
  if (s.scope === 'all_active') return 'all active';
  return (s.scope_brands ?? []).join(', ') || 'brand';
}

export default function StockCheckBoard({
  initialSessions,
  brands,
  userEmail,
}: {
  initialSessions: SessionRow[];
  brands: BrandOption[];
  userEmail: string;
}) {
  const [tab, setTab] = useState<'counts' | 'adjustments'>('counts');
  const [sessions, setSessions] = useState<SessionRow[]>(initialSessions);
  const [detail, setDetail] = useState<SessionRow | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastBy, setLastBy] = useState('');
  const reqRef = useRef(0);

  // shared login → remember who counted last so they don't retype each session (spec §5).
  useEffect(() => {
    try {
      setLastBy(localStorage.getItem('sc:lastBy') || '');
    } catch {
      /* localStorage unavailable — fine */
    }
  }, []);

  async function reloadSessions(): Promise<SessionRow[]> {
    const myReq = ++reqRef.current;
    try {
      const list = await getSessions();
      if (reqRef.current === myReq) setSessions(list);
      return list;
    } catch (e) {
      if (reqRef.current === myReq) setError(e instanceof Error ? e.message : 'Failed to load sessions.');
      return sessions;
    }
  }

  async function createCount(input: NewCountInput) {
    setError(null);
    const res = await openStockCheck(input);
    if (!res.ok) throw new Error(res.message); // client-side throw → the modal shows the readable message
    try {
      localStorage.setItem('sc:lastBy', input.counted_by);
    } catch {
      /* ignore */
    }
    setLastBy(input.counted_by);
    setShowNew(false);
    const list = await reloadSessions();
    const fresh = list.find((s) => s.stock_check_id === res.stock_check_id);
    if (fresh) setDetail(fresh);
  }

  async function exitDetail() {
    setDetail(null);
    await reloadSessions();
  }

  async function onClosed(id: number) {
    // optimistically flip to the closed snapshot so it shows even if the reload below fails.
    setDetail((d) => (d && d.stock_check_id === id ? { ...d, status: 'closed' } : d));
    const list = await reloadSessions();
    const fresh = list.find((s) => s.stock_check_id === id);
    if (fresh) setDetail(fresh);
  }

  // ── detail (a single open/closed session) ──
  if (tab === 'counts' && detail) {
    if (detail.status === 'open' && detail.mode === 'presence') {
      return (
        <div className="ops">
          <AppHeader active="stock-check" userEmail={userEmail} />
          <PresenceSession session={detail} onExit={exitDetail} onClosed={() => onClosed(detail.stock_check_id)} />
        </div>
      );
    }
    if (detail.status === 'open' && detail.mode === 'count') {
      return (
        <div className="ops">
          <AppHeader active="stock-check" userEmail={userEmail} />
          <CountSession session={detail} onExit={exitDetail} onClosed={() => onClosed(detail.stock_check_id)} />
        </div>
      );
    }
    return (
      <div className="ops">
        <AppHeader active="stock-check" userEmail={userEmail} />
        <SnapshotView session={detail} onExit={exitDetail} />
      </div>
    );
  }

  return (
    <div className="ops">
      <AppHeader active="stock-check" userEmail={userEmail} />

      <div className="sc-wrap">
        <div className="sc-tabs">
          <button className={`sc-tab ${tab === 'counts' ? 'active' : ''}`} onClick={() => setTab('counts')}>Counts</button>
          <button className={`sc-tab ${tab === 'adjustments' ? 'active' : ''}`} onClick={() => setTab('adjustments')}>Adjustments</button>
        </div>

        {error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}

        {tab === 'counts' ? (
          <>
            <div className="sc-bar">
              <button className="btn-primary" onClick={() => setShowNew(true)}>+ New count</button>
            </div>
            <div className="sc-sess-list">
              {sessions.length === 0 && <div className="sc-empty">No counts yet. Start one with “New count”.</div>}
              {sessions.map((s) => (
                <button key={s.stock_check_id} className="sc-sess" onClick={() => setDetail(s)}>
                  <div className="sc-sess-l1">
                    <span className={`sc-badge ${s.status}`}>{s.status}</span>
                    <span className="sc-sess-mode">{modeLabel(s.mode)}</span>
                    <span className="sc-sess-scope">{scopeLabel(s)}</span>
                    <span className="sc-sess-date">{fmtDate(s.started_at)}</span>
                  </div>
                  <div className="sc-sess-l2">
                    <span className="sc-sess-by">{s.counted_by}</span>
                    <span className="sc-sess-meta">
                      {s.status === 'open'
                        ? `${s.confirmed_count}/${s.line_count} ${s.mode === 'count' ? 'counted' : 'checked'}`
                        : `${s.changed_count} changed`}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <AdjustmentsTab />
        )}
      </div>

      {showNew && (
        <NewCountModal brands={brands} defaultBy={lastBy} onCreate={createCount} onCancel={() => setShowNew(false)} />
      )}
    </div>
  );
}

// ── New-count modal (mode + scope + brands + counted_by) ──
function NewCountModal({
  brands,
  defaultBy,
  onCreate,
  onCancel,
}: {
  brands: BrandOption[];
  defaultBy: string;
  onCreate: (input: NewCountInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<StockCheckMode>('presence');
  const [scope, setScope] = useState<StockCheckScope>('all_active');
  const [countedBy, setCountedBy] = useState(defaultBy);
  const [note, setNote] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const f = filter.trim().toLowerCase();
  const shown = f
    ? brands.filter((b) => b.prefix.toLowerCase().includes(f) || (b.name ?? '').toLowerCase().includes(f))
    : brands;

  function toggle(prefix: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(prefix)) n.delete(prefix);
      else n.add(prefix);
      return n;
    });
  }

  async function submit() {
    setError(null);
    if (!countedBy.trim()) return setError('Enter who is counting.');
    if (scope === 'brand' && selected.size === 0) return setError('Pick at least one brand.');
    setBusy(true);
    try {
      await onCreate({ mode, scope, brands: [...selected], counted_by: countedBy.trim(), note: note.trim() || null });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start the count.');
      setBusy(false);
    }
  }

  return (
    <div className="sc-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="sc-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sc-modal-head">
          <div className="sc-modal-title">New count</div>
          <div className="sc-modal-sub">Mode is fixed for the session.</div>
        </div>

        <div className="sc-modal-body">
          <label className="sc-field">
            <span>Who is counting</span>
            <input type="text" value={countedBy} placeholder="name" onChange={(e) => setCountedBy(e.target.value)} />
          </label>

          <div className="sc-field">
            <span>Mode</span>
            <div className="sc-seg">
              <button className={mode === 'presence' ? 'active' : ''} onClick={() => setMode('presence')}>Checkbox</button>
              <button className={mode === 'count' ? 'active' : ''} onClick={() => setMode('count')}>Scan</button>
            </div>
          </div>

          <div className="sc-field">
            <span>Scope</span>
            <div className="sc-seg">
              <button className={scope === 'all_active' ? 'active' : ''} onClick={() => setScope('all_active')}>All active</button>
              <button className={scope === 'brand' ? 'active' : ''} onClick={() => setScope('brand')}>By brand</button>
            </div>
          </div>

          {scope === 'brand' && (
            <div className="sc-brandpick">
              <input type="text" placeholder="filter brands" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <div className="sc-brandlist">
                {shown.map((b) => (
                  <label key={b.prefix} className="sc-brandopt">
                    <input type="checkbox" checked={selected.has(b.prefix)} onChange={() => toggle(b.prefix)} />
                    <span className="ff-code">{b.prefix}</span>
                    <span className="ff-name">{b.name ?? ''}</span>
                  </label>
                ))}
                {shown.length === 0 && <div className="sc-empty">No brands match.</div>}
              </div>
              <div className="sc-exp">{selected.size} selected</div>
            </div>
          )}

          <label className="sc-field">
            <span>Note (optional)</span>
            <input type="text" value={note} placeholder="e.g. monthly count" onChange={(e) => setNote(e.target.value)} />
          </label>

          {error && <div className="validation err" style={{ marginTop: 10 }}>{error}</div>}
        </div>

        <div className="sc-modal-foot">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>{busy ? 'Starting…' : 'Start count'}</button>
        </div>
      </div>
    </div>
  );
}

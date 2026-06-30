'use client';

// Duplicate-customer cleanup (PR102). A review modal that surfaces same-name groups
// containing a likely stray (a record with no orders) — the "Henny Y split across four rows" pattern —
// and lets the operator pick the keeper and pull the strays' phones + addresses into it. Merging
// re-points every order/shipment at the keeper and DELETES the selected stray rows, so a record that
// still carries orders is flagged and needs a second confirm before it goes.

import { useEffect, useMemo, useState } from 'react';
import { customerLabel, fmtRpCompact } from '@jigzle/lib';
import { getDuplicateGroups, mergeCustomers } from '@/app/customers/actions';
import type { DuplicateGroup, MergeResult } from '@/app/customers/types';

const fmtDay = (s: string | null): string => (s ? s.slice(0, 10) : '—');

export default function MergeDuplicates({ onClose, onMerged }: { onClose: () => void; onMerged: (removedIds: number[]) => void }) {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // per-group draft: which record is the keeper + which are ticked to merge in
  const [primaryOf, setPrimaryOf] = useState<Record<string, number>>({});
  const [selectedOf, setSelectedOf] = useState<Record<string, Set<number>>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);   // group awaiting "merge anyway" (a real record is ticked)
  const [doneOf, setDoneOf] = useState<Record<string, MergeResult>>({});
  const [errOf, setErrOf] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const g = await getDuplicateGroups();
        if (!live) return;
        setGroups(g);
        // defaults: keeper = first member (groups arrive keeper-first), tick every order-less stray
        const prim: Record<string, number> = {};
        const sel: Record<string, Set<number>> = {};
        for (const grp of g) {
          prim[grp.key] = grp.members[0].id;
          sel[grp.key] = new Set(grp.members.filter((m) => m.id !== grp.members[0].id && m.order_count === 0).map((m) => m.id));
        }
        setPrimaryOf(prim);
        setSelectedOf(sel);
      } catch (e) {
        if (live) setLoadErr(e instanceof Error ? e.message : 'Failed to load duplicates.');
      }
    })();
    return () => { live = false; };
  }, []);

  // when the keeper changes, drop it from the merge selection (can't merge a record into itself)
  function setPrimary(key: string, id: number) {
    setPrimaryOf((p) => ({ ...p, [key]: id }));
    setSelectedOf((s) => { const next = new Set(s[key]); next.delete(id); return { ...s, [key]: next }; });
    setConfirmKey(null);
  }
  function toggle(key: string, id: number) {
    setSelectedOf((s) => { const next = new Set(s[key]); if (next.has(id)) next.delete(id); else next.add(id); return { ...s, [key]: next }; });
    setConfirmKey(null);
  }

  async function runMerge(group: DuplicateGroup) {
    const key = group.key;
    const primaryId = primaryOf[key];
    const ids = [...(selectedOf[key] ?? new Set<number>())];
    if (!primaryId || ids.length === 0) return;
    // ticking a record that has orders merges two real people — make the operator confirm once
    const risky = group.members.some((m) => ids.includes(m.id) && m.order_count > 0);
    if (risky && confirmKey !== key) { setConfirmKey(key); return; }
    setBusyKey(key);
    setErrOf((e) => { const rest = { ...e }; delete rest[key]; return rest; });
    try {
      const res = await mergeCustomers(primaryId, ids);
      setDoneOf((d) => ({ ...d, [key]: res }));
      setConfirmKey(null);
      onMerged(res.removedIds);
    } catch (e) {
      setErrOf((er) => ({ ...er, [key]: e instanceof Error ? e.message : 'Merge failed.' }));
    } finally {
      setBusyKey(null);
    }
  }

  const remaining = useMemo(() => (groups ?? []).filter((g) => !doneOf[g.key]), [groups, doneOf]);

  return (
    <div className="sc-modal-backdrop" onClick={onClose}>
      <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Merge duplicate customers" onClick={(e) => e.stopPropagation()}>
        <div className="sc-modal-head sc-modal-head-row">
          <div>
            <div className="sc-modal-title">Merge duplicate customers</div>
            <div className="sc-modal-sub">Same-name records where at least one looks like a stray (no orders). Pick the record to keep; ticked rows are merged in and deleted.</div>
          </div>
          <button className="sc-modal-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="sc-modal-body">
          {loadErr && <div className="validation err">{loadErr}</div>}
          {!groups && !loadErr && <div className="hint">Scanning customers…</div>}
          {groups && remaining.length === 0 && Object.keys(doneOf).length === 0 && !loadErr && (
            <div className="hint">No likely duplicates found.</div>
          )}

          {(groups ?? []).map((group) => {
            const done = doneOf[group.key];
            if (done) {
              const bits = [
                `${done.removedIds.length} record${done.removedIds.length === 1 ? '' : 's'} removed`,
                done.phonesAdded ? `${done.phonesAdded} number${done.phonesAdded === 1 ? '' : 's'} added` : null,
                done.addressesMoved ? `${done.addressesMoved} address${done.addressesMoved === 1 ? '' : 'es'} moved` : null,
                done.addressesSkipped ? `${done.addressesSkipped} duplicate address${done.addressesSkipped === 1 ? '' : 'es'} dropped` : null,
                done.droppedPhones ? `${done.droppedPhones} extra number${done.droppedPhones === 1 ? '' : 's'} didn’t fit (3 max)` : null,
                done.recordsReassigned ? `${done.recordsReassigned} order/shipment row${done.recordsReassigned === 1 ? '' : 's'} re-pointed` : null,
              ].filter(Boolean);
              return (
                <div key={group.key} className="dup-group">
                  <div className="dup-group-head">{group.name}</div>
                  <div className="validation ok">Merged into #{done.primaryId} · {bits.join(' · ')}.</div>
                </div>
              );
            }

            const primaryId = primaryOf[group.key];
            const selected = selectedOf[group.key] ?? new Set<number>();
            const busy = busyKey === group.key;
            const riskyTicked = group.members.some((m) => selected.has(m.id) && m.order_count > 0);
            const awaiting = confirmKey === group.key && riskyTicked;
            return (
              <div key={group.key} className="dup-group">
                <div className="dup-group-head">{group.name} <span className="hint">· {group.members.length} records</span></div>
                <ul className="dup-members">
                  {group.members.map((m) => {
                    const isPrimary = primaryId === m.id;
                    const isSel = selected.has(m.id);
                    return (
                      <li key={m.id} className={`dup-member${isPrimary ? ' is-primary' : ''}`}>
                        <label className="dup-keep" title="Keep this record">
                          <input type="radio" name={`primary-${group.key}`} checked={isPrimary} onChange={() => setPrimary(group.key, m.id)} disabled={busy} />
                          <span>keep</span>
                        </label>
                        <div className="dup-info">
                          <div className="dup-name">
                            {customerLabel(m.name, m.phones[0])} <span className="hint">#{m.id}</span>
                            {m.order_count === 0
                              ? <span className="dup-tag dup-tag-stray">no orders</span>
                              : <span className="dup-tag dup-tag-real">{m.order_count} order{m.order_count === 1 ? '' : 's'}</span>}
                          </div>
                          <div className="dup-meta hint">
                            {m.phones.length ? m.phones.join(' · ') : 'no phone'}
                            {` · ${m.address_count} address${m.address_count === 1 ? '' : 'es'}`}
                            {m.last_purchase ? ` · last ${fmtDay(m.last_purchase)}` : ''}
                            {m.lifetime_spend > 0 ? ` · ${fmtRpCompact(m.lifetime_spend)}` : ''}
                          </div>
                        </div>
                        {!isPrimary && (
                          <label className="dup-merge" title="Merge this record into the keeper, then delete it">
                            <input type="checkbox" checked={isSel} onChange={() => toggle(group.key, m.id)} disabled={busy} />
                            <span>merge</span>
                          </label>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {errOf[group.key] && <div className="validation err" style={{ marginTop: 8 }}>{errOf[group.key]}</div>}
                {awaiting && (
                  <div className="validation warn" style={{ marginTop: 8 }}>
                    A ticked record has its own orders — merging moves them to the keeper and deletes the record. Click again to confirm.
                  </div>
                )}
                <div className="dup-actions">
                  <button
                    className="btn-primary"
                    disabled={busy || !primaryId || selected.size === 0}
                    onClick={() => runMerge(group)}
                  >
                    {busy ? 'Merging…' : awaiting ? 'Merge anyway' : `Merge ${selected.size || ''} into keeper`.trim()}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="sc-modal-foot" style={{ justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

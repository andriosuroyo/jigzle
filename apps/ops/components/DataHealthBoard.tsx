'use client';

// Data health (PR107, extended PR108) — a read-only integrity scan over the customer table, the in-app
// home for the cleanup we've been doing by hand. Surfaces the import's split signatures (customers that
// share a number, or share an address) which the same-name scan misses, plus empty stray records, and
// lets you fix each through the merge tool / a guarded bulk delete — no raw DB connection, all under RLS.

import { useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import MergeDuplicates from '@/components/MergeDuplicates';
import { deleteEmptyStrays, getDataHealth } from '@/app/customers/actions';
import { customerLabel } from '@jigzle/lib';
import type { DataHealth } from '@/app/customers/types';

export default function DataHealthBoard({ initial, userEmail }: { initial: DataHealth; userEmail: string }) {
  const [health, setHealth] = useState<DataHealth>(initial);
  const [mergeIds, setMergeIds] = useState<number[] | null>(null);   // exact group → opens the merge tool
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmStrays, setConfirmStrays] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  async function refresh() {
    setRefreshing(true);
    try {
      setHealth(await getDataHealth());
    } finally {
      setRefreshing(false);
    }
  }

  async function deleteStrays() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await deleteEmptyStrays(health.emptyStrays.map((s) => s.id));
      setNotice({ tone: 'ok', text: `Deleted ${res.deleted} empty record${res.deleted === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped} (had attached data)` : ''}.` });
      setConfirmStrays(false);
      await refresh();
    } catch (e) {
      setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Delete failed.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ops">
      <AppHeader active="data-health" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Data health' }]} />

      <div className="set-wrap">
        {notice && <div className={`validation ${notice.tone}`} style={{ marginBottom: 12 }}>{notice.text}</div>}

        <div className="cust-stats" style={{ marginTop: 4 }}>
          <div className="cust-stat">
            <div className="cust-stat-label">Customers</div>
            <div className="cust-stat-value cust-stat-figure">{health.totalCustomers.toLocaleString('en-US')}</div>
            <div className="cust-stat-sub">total records</div>
          </div>
          <div className="cust-stat">
            <div className="cust-stat-label">Shared number</div>
            <div className="cust-stat-value cust-stat-figure">{health.sharedPhoneGroupCount}</div>
            <div className="cust-stat-sub">{health.overThreeCount} need a manual choice</div>
          </div>
          <div className="cust-stat">
            <div className="cust-stat-label">Shared address</div>
            <div className="cust-stat-value cust-stat-figure">{health.sharedAddressGroupCount}</div>
            <div className="cust-stat-sub">groups (no shared number)</div>
          </div>
          <div className="cust-stat">
            <div className="cust-stat-label">Empty records</div>
            <div className="cust-stat-value cust-stat-figure">{health.emptyStrayCount}</div>
            <div className="cust-stat-sub">no data attached</div>
          </div>
        </div>

        <div className="po-tobuy-head" style={{ marginTop: 8 }}>
          <div className="hint">Customers that share a <b>number</b> or an <b>address</b> are almost always one person split by the import — review to fold them into one keeper.</div>
          <button className="btn-secondary" onClick={refresh} disabled={refreshing || busy}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
        </div>

        {/* shared number */}
        <div className="fd-section-head" style={{ marginTop: 16 }}>Sharing a number {health.groups.length ? `(${health.groups.length})` : ''}</div>
        {health.groups.length === 0 && <div className="validation ok">No customers share a phone number.</div>}
        <ul className="dh-list">
          {health.groups.map((g) => (
            <li key={`p-${g.memberIds.join('-')}`} className="dh-group">
              <div className="dh-group-main">
                <div className="dh-group-head">
                  {g.members.map((m, i) => (
                    <span key={m.id} className="dh-member">
                      {i > 0 && <span className="dh-sep">·</span>}
                      {customerLabel(m.name, m.phones[0])} <span className="hint">#{m.id}</span>
                    </span>
                  ))}
                  {g.numberCount > 3 && <span className="dup-tag dup-tag-stray">{g.numberCount} numbers</span>}
                </div>
                <div className="dh-group-sub hint">shares {g.sharedPhones.join(', ')}</div>
              </div>
              <button className="btn-secondary" onClick={() => setMergeIds(g.memberIds)}>Review &amp; merge</button>
            </li>
          ))}
        </ul>

        {/* shared address */}
        <div className="fd-section-head" style={{ marginTop: 20 }}>Sharing an address {health.addressGroups.length ? `(${health.addressGroups.length})` : ''}</div>
        {health.addressGroups.length === 0 && <div className="validation ok">No customers share an address (beyond those already sharing a number).</div>}
        <ul className="dh-list">
          {health.addressGroups.map((g) => (
            <li key={`a-${g.memberIds.join('-')}`} className="dh-group">
              <div className="dh-group-main">
                <div className="dh-group-head">
                  {g.members.map((m, i) => (
                    <span key={m.id} className="dh-member">
                      {i > 0 && <span className="dh-sep">·</span>}
                      {customerLabel(m.name, m.phones[0])} <span className="hint">#{m.id}</span>
                    </span>
                  ))}
                </div>
                <div className="dh-group-sub hint">shares “{g.sharedAddress.slice(0, 80)}{g.sharedAddress.length > 80 ? '…' : ''}”</div>
              </div>
              <button className="btn-secondary" onClick={() => setMergeIds(g.memberIds)}>Review &amp; merge</button>
            </li>
          ))}
        </ul>

        {/* empty strays */}
        <div className="po-tobuy-head" style={{ marginTop: 20 }}>
          <div className="fd-section-head" style={{ marginBottom: 0 }}>Empty records {health.emptyStrays.length ? `(${health.emptyStrays.length})` : ''}</div>
          {health.emptyStrays.length > 0 && !confirmStrays && (
            <button className="btn-secondary" onClick={() => { setNotice(null); setConfirmStrays(true); }} disabled={busy}>Delete all</button>
          )}
          {confirmStrays && (
            <span className="dh-confirm">
              <span className="hint">Delete {health.emptyStrays.length} empty record{health.emptyStrays.length === 1 ? '' : 's'}?</span>
              <button className="btn-secondary" onClick={() => setConfirmStrays(false)} disabled={busy}>Cancel</button>
              <button className="btn-link danger" onClick={deleteStrays} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
            </span>
          )}
        </div>
        {health.emptyStrays.length === 0 ? (
          <div className="validation ok">No empty records — every customer has a number, address, channel or order.</div>
        ) : (
          <div className="dh-stray-list hint">
            {health.emptyStrays.map((s) => `${s.name || '(no name)'} #${s.id}`).join('  ·  ')}
          </div>
        )}

        <div className="dh-foot hint">
          For same-<i>name</i> duplicates, use <b>Customer → Find duplicates</b>. For a bulk reconcile against the
          source spreadsheets, see <code>scripts/import/reconcile_customers.py</code>.
        </div>
      </div>

      {mergeIds && (
        <MergeDuplicates
          initialIds={mergeIds}
          onClose={() => { setMergeIds(null); refresh(); }}
          onMerged={() => { /* groups refresh when the modal closes */ }}
        />
      )}
    </div>
  );
}

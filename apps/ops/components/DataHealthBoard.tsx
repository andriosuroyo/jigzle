'use client';

// Data health (PR107) — a read-only integrity scan over the customer table, the in-app home for the
// cleanup we've been doing by hand. Surfaces the import's phone-split signature (customers that share
// a number, which the same-name scan misses) and lets you fix each group through the merge tool
// without ever touching a raw DB connection. Everything here runs with your session under RLS.

import { useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import MergeDuplicates from '@/components/MergeDuplicates';
import { getDataHealth } from '@/app/customers/actions';
import { customerLabel } from '@jigzle/lib';
import type { DataHealth } from '@/app/customers/types';

export default function DataHealthBoard({ initial, userEmail }: { initial: DataHealth; userEmail: string }) {
  const [health, setHealth] = useState<DataHealth>(initial);
  const [mergeSeed, setMergeSeed] = useState<string | null>(null);   // shared phone → opens the merge tool
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      setHealth(await getDataHealth());
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="ops">
      <AppHeader active="data-health" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Data health' }]} />

      <div className="set-wrap">
        <div className="cust-stats" style={{ marginTop: 4 }}>
          <div className="cust-stat">
            <div className="cust-stat-label">Customers</div>
            <div className="cust-stat-value cust-stat-figure">{health.totalCustomers.toLocaleString('en-US')}</div>
            <div className="cust-stat-sub">total records</div>
          </div>
          <div className="cust-stat">
            <div className="cust-stat-label">Shared-number groups</div>
            <div className="cust-stat-value cust-stat-figure">{health.sharedPhoneGroupCount}</div>
            <div className="cust-stat-sub">{health.overThreeCount} need a manual number choice</div>
          </div>
          <div className="cust-stat">
            <div className="cust-stat-label">No name</div>
            <div className="cust-stat-value cust-stat-figure">{health.noName}</div>
            <div className="cust-stat-sub">blank-name records</div>
          </div>
        </div>

        <div className="dh-intro hint">
          Customers that <b>share a phone number</b> are almost always the same person split across rows by the
          import. Review a group to fold the duplicates into one keeper (the merge tool opens pre-loaded with the
          shared number). A <span className="dup-tag dup-tag-stray">4+ numbers</span> tag means consolidating would
          exceed the three phone slots — you’ll pick which numbers to keep.
        </div>

        <div className="po-tobuy-head" style={{ marginTop: 16 }}>
          <div className="fd-section-head" style={{ marginBottom: 0 }}>Customers sharing a number</div>
          <button className="btn-secondary" onClick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
        </div>

        {health.groups.length === 0 && <div className="validation ok" style={{ marginTop: 10 }}>No customers share a phone number — nothing to consolidate here.</div>}

        <ul className="dh-list">
          {health.groups.map((g) => (
            <li key={g.memberIds.join('-')} className="dh-group">
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
              <button className="btn-secondary" onClick={() => setMergeSeed(g.sharedPhones[0])}>Review &amp; merge</button>
            </li>
          ))}
        </ul>

        {health.groups.length >= 200 && (
          <div className="hint" style={{ marginTop: 8 }}>Showing the first 200 groups — fix some and Refresh to see the rest.</div>
        )}

        <div className="dh-foot hint">
          For same-<i>name</i> duplicates (no shared number), use <b>Customer → Find duplicates</b>. For a bulk
          reconcile against the source spreadsheets, see <code>scripts/import/reconcile_customers.py</code>.
        </div>
      </div>

      {mergeSeed && (
        <MergeDuplicates
          initialQuery={mergeSeed}
          onClose={() => { setMergeSeed(null); refresh(); }}
          onMerged={() => { /* groups refresh when the modal closes */ }}
        />
      )}
    </div>
  );
}

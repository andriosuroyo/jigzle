'use client';

// PR196 — the home hub. Four category columns left→right (Sales · Warehouse · Database · Tools &
// Settings), each a white panel with a vertical list of nav rows. Sales / Purchasing / Outbound rows
// carry at-a-glance work-queue counts, fetched lazily after render (getHubCounts) so the landing is
// instant. Desktop shows the four columns side-by-side; narrower screens reflow to 2 then 1 column.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { NAV_GROUPS } from '@/components/navConfig';
import { getHubCounts, type HubCounts } from '@/app/hubCounts';

// one stat chip: a coloured dot (optional) + label + number. `pending` shows a muted placeholder.
function Stat({ tone, label, value, pending }: { tone?: 'red' | 'yellow' | 'green'; label: string; value: number; pending: boolean }) {
  return (
    <span className="hub-stat">
      {tone && <span className={`hub-stat-dot ${tone}`} aria-hidden />}
      <span className="hub-stat-label">{label}</span>
      <span className="hub-stat-num">{pending ? '—' : value}</span>
    </span>
  );
}

function CardStats({ navKey, counts }: { navKey: string; counts: HubCounts | null }) {
  const pending = counts == null;
  if (navKey === 'orders') {
    const s = counts?.sales;
    return (
      <div className="hub-stats">
        <Stat tone="red" label="To order" value={s?.toOrder ?? 0} pending={pending} />
        <Stat tone="yellow" label="On the way" value={s?.onTheWay ?? 0} pending={pending} />
        <Stat tone="green" label="Ready" value={s?.ready ?? 0} pending={pending} />
      </div>
    );
  }
  if (navKey === 'purchasing') {
    const p = counts?.purchasing;
    return (
      <div className="hub-stats">
        <Stat label="Manual" value={p?.manual ?? 0} pending={pending} />
        <Stat label="From sales" value={p?.fromSales ?? 0} pending={pending} />
      </div>
    );
  }
  if (navKey === 'outbound') {
    const o = counts?.outbound;
    return (
      <div className="hub-stats">
        <Stat tone="green" label="Ready to ship" value={o?.readyToShip ?? 0} pending={pending} />
      </div>
    );
  }
  return null;
}

const HAS_STATS = new Set(['orders', 'purchasing', 'outbound']);

export default function HubBoard() {
  const [counts, setCounts] = useState<HubCounts | null>(null);

  useEffect(() => {
    let alive = true;
    getHubCounts().then((c) => { if (alive) setCounts(c); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <div className="hub">
      {NAV_GROUPS.map((g) => (
        <section className="hub-col" key={g.label}>
          <h2 className="hub-col-title">{g.label}</h2>
          <div className="hub-col-list">
            {g.items.map((n) => (
              <Link href={n.href} className="hub-item" key={n.key}>
                <div className="hub-item-head">
                  <span className="nav-icon-wrap">{n.icon}</span>
                  <span className="hub-item-label">{n.label}</span>
                </div>
                {n.sub && <div className="hub-item-sub">{n.sub}</div>}
                {HAS_STATS.has(n.key) && <CardStats navKey={n.key} counts={counts} />}
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

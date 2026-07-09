'use client';

// PR90 — shared breadcrumb trail (Home › Section › Tab), rendered just below AppHeader on every
// section. Home + Section are links/buttons that lead back; the last crumb is the current page/tab
// (bold, not a link). A crumb is a Link when it has `href`, a button when it has `onClick`, else plain.

import { Fragment, useState } from 'react';
import Link from 'next/link';

export type Crumb = { label: string; href?: string; onClick?: () => void };

export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  // PR220 — manual refresh (right of the trail). The boards hold their own client state seeded from
  // server props, so a hard reload is the reliable way to pull fresh data on demand — and it only
  // runs when the operator asks for it, instead of automatic background refetches.
  // PR258 — this is `window.location.reload()`: it reloads ONLY the tab it's clicked in. There is no
  // realtime channel / broadcast anywhere in the app, so one operator's refresh can never reach
  // another device. Keep it that way — never wire this button to a shared/server-push mechanism.
  const [refreshing, setRefreshing] = useState(false);
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((c, i) => {
        const isLast = i === items.length - 1;
        const node = isLast || (!c.href && !c.onClick) ? (
          <span className="crumb-current">{c.label}</span>
        ) : c.href ? (
          <Link href={c.href} className="crumb-link">{c.label}</Link>
        ) : (
          <button type="button" className="crumb-link" onClick={c.onClick}>{c.label}</button>
        );
        return (
          <Fragment key={i}>
            {i > 0 && <span className="crumb-sep" aria-hidden>›</span>}
            {node}
          </Fragment>
        );
      })}
      <button
        type="button"
        className={`crumb-refresh${refreshing ? ' spinning' : ''}`}
        onClick={() => { setRefreshing(true); window.location.reload(); }}
        title="Refresh this page"
        aria-label="Refresh"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>
    </nav>
  );
}

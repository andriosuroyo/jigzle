'use client';

// PR90 — shared breadcrumb trail (Home › Section › Tab), rendered just below AppHeader on every
// section. Home + Section are links/buttons that lead back; the last crumb is the current page/tab
// (bold, not a link). A crumb is a Link when it has `href`, a button when it has `onClick`, else plain.

import { Fragment } from 'react';
import Link from 'next/link';

export type Crumb = { label: string; href?: string; onClick?: () => void };

export default function Breadcrumbs({ items }: { items: Crumb[] }) {
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
    </nav>
  );
}

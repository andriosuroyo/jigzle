'use client';

import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import { createSupabaseBrowserClient } from '@jigzle/db/client';
import { NAV_GROUPS } from '@/components/navConfig';

export default function AppHeader({ active, userEmail }: { active?: string; userEmail: string }) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [open, setOpen] = useState(false);

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return (
    <header className="app-header">
      <Link href="/" className="logo" onClick={() => setOpen(false)}>J</Link>
      <Link href="/" className="title" style={{ textDecoration: 'none', color: 'inherit' }}>Jigzle Ops</Link>

      {/* Desktop: one horizontal bar, the 3 groups separated by dividers. */}
      <nav className="topnav" aria-label="Primary">
        {NAV_GROUPS.map((g, i) => (
          <Fragment key={g.label}>
            {i > 0 && <span className="nav-divider" aria-hidden="true" />}
            <div className="nav-group" role="group" aria-label={g.label}>
              {g.items.map((n) => (
                <Link key={n.key} href={n.href} className={active === n.key ? 'active' : undefined}>
                  <span className="nav-icon-wrap">{n.icon}</span>
                  {n.label}
                </Link>
              ))}
            </div>
          </Fragment>
        ))}
      </nav>

      {/* Mobile: hamburger toggles the slide-down drawer (the same config, 3 labeled sections). */}
      <button
        className="nav-toggle"
        aria-label="Menu"
        aria-expanded={open}
        aria-controls="nav-drawer"
        onClick={() => setOpen((o) => !o)}
      >
        <span /><span /><span />
      </button>

      <button className="signout" onClick={signOut} title={userEmail}>Sign out</button>

      {open && (
        <div className="nav-drawer" id="nav-drawer" role="navigation" aria-label="Primary">
          {NAV_GROUPS.map((g) => (
            <div className="nav-section" key={g.label}>
              <div className="nav-section-label">{g.label}</div>
              {g.items.map((n) => (
                <Link
                  key={n.key}
                  href={n.href}
                  className={active === n.key ? 'active' : undefined}
                  onClick={() => setOpen(false)}
                >
                  <span className="nav-icon-wrap">{n.icon}</span>
                  {n.label}
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </header>
  );
}

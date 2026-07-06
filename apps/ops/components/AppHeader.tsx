'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
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

      {/* Desktop: the 4 category labels; hover / keyboard-focus a label to reveal its items. */}
      <nav className="topnav" aria-label="Primary">
        {NAV_GROUPS.map((g) => {
          const activeGroup = g.items.some((n) => n.key === active);
          return (
            <div className="nav-group" key={g.label}>
              <button type="button" className={`nav-group-btn ${activeGroup ? 'active' : ''}`} aria-haspopup="true">
                {g.label}
                <span className="nav-caret" aria-hidden="true">▾</span>
              </button>
              <div className="nav-dropdown" role="menu" aria-label={g.label}>
                {g.items.map((n) => (
                  <Link key={n.key} href={n.href} role="menuitem" className={active === n.key ? 'active' : undefined}>
                    <span className="nav-icon-wrap">{n.icon}</span>
                    {n.label}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
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

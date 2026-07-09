'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { createSupabaseBrowserClient } from '@jigzle/db/client';
import { NAV_GROUPS } from '@/components/navConfig';

export default function AppHeader({ active, userEmail }: { active?: string; userEmail: string }) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [open, setOpen] = useState(false);

  async function signOut() {
    // PR258 — scope: 'local' clears ONLY this device's session. The default ('global') revokes the
    // account's refresh tokens on EVERY device, so when two operators shared an account one signing
    // out silently bounced the other to /login mid-task (read as "the refresh hit everyone"). Local
    // sign-out leaves other devices' sessions untouched. Fall back to a plain sign-out if the arg
    // isn't honoured, so a failure never strands the operator signed-in.
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      await supabase.auth.signOut();
    }
    window.location.href = '/login';
  }

  return (
    <header className="app-header">
      <Link href="/" className="logo" onClick={() => setOpen(false)} aria-label="Jigzle home">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.webp" alt="Jigzle" width={30} height={30} />
      </Link>
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

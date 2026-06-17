'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { createSupabaseBrowserClient } from '@jigzle/db/client';

const NAV = [
  { key: 'procurement', href: '/procurement', label: 'Procurement' },
  { key: 'receiving',   href: '/receiving',   label: 'Receiving' },
  { key: 'sales',       href: '/sales/new',   label: 'Sales' },
  { key: 'fulfill',     href: '/fulfill',     label: 'Fulfill' },
  { key: 'outbound',    href: '/outbound',    label: 'Outbound' },
  { key: 'inventory',   href: '/inventory',   label: 'Inventory' },
  { key: 'catalogue',   href: '/catalogue',   label: 'Catalogue' },
];

export default function AppHeader({ active, userEmail }: { active?: string; userEmail: string }) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = '/login';
  }
  return (
    <header className="app-header">
      <Link href="/" className="logo">J</Link>
      <Link href="/" className="title" style={{ textDecoration: 'none', color: 'inherit' }}>Jigzle Ops</Link>
      <nav className="topnav">
        {NAV.map((n) => (
          <Link key={n.key} href={n.href} className={active === n.key ? 'active' : undefined}>{n.label}</Link>
        ))}
      </nav>
      <button className="signout" onClick={signOut} title={userEmail}>Sign out</button>
    </header>
  );
}

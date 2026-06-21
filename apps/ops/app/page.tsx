import Link from 'next/link';
import { createSupabaseServerClient } from '@jigzle/db/server';
import AppHeader from '@/components/AppHeader';
import { NAV_GROUPS } from '@/components/navConfig';

export const dynamic = 'force-dynamic';

// Ops home — nav hub. Rendered from NAV_GROUPS (§10), the SAME source the menu uses, so the cards
// always match the menu: same groups, same icons, and Orders + Settings appear automatically. Each
// card's blurb is the nav item's `sub`. AppHeader behaviour is unchanged.
export default async function Home() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return (
    <div className="ops">
      <AppHeader userEmail={user?.email || ''} />
      <div className="hub">
        {NAV_GROUPS.map((g) => (
          <section className="hub-group" key={g.label}>
            <h2 className="hub-group-title">{g.label}</h2>
            <div className="hub-grid">
              {g.items.map((n) => (
                <Link href={n.href} className="hub-card" key={n.key}>
                  <div className="hub-card-title"><span className="nav-icon-wrap">{n.icon}</span> {n.label}</div>
                  {n.sub && <div className="hub-card-sub">{n.sub}</div>}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

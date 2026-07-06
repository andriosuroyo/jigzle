import { createSupabaseServerClient } from '@jigzle/db/server';
import AppHeader from '@/components/AppHeader';
import HubBoard from '@/components/HubBoard';

export const dynamic = 'force-dynamic';

// Ops home — nav hub. HubBoard renders the four category columns from NAV_GROUPS (the SAME source the
// menu uses) and lazily loads the at-a-glance work-queue counts for Sales / Purchasing / Outbound.
export default async function Home() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return (
    <div className="ops">
      <AppHeader userEmail={user?.email || ''} />
      <HubBoard />
    </div>
  );
}

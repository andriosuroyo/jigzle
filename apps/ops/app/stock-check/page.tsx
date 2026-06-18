import { createSupabaseServerClient } from '@jigzle/db/server';
import StockCheckBoard from '@/components/StockCheckBoard';
import { getBrands, getSessions } from '@/app/stock-check/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the session list (open + history/snapshots) + the brand options for the
// New-count scope picker, then render the single-pane board (Counts ▸ Adjustments tabs).
export default async function StockCheckPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    sessions,
    brands,
  ] = await Promise.all([supabase.auth.getUser(), getSessions(), getBrands()]);
  return <StockCheckBoard initialSessions={sessions} brands={brands} userEmail={user?.email || ''} />;
}

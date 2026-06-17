import { createSupabaseServerClient } from '@jigzle/db/server';
import InventoryBoard from '@/components/InventoryBoard';
import { getInventory } from '@/app/inventory/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the active snapshot (default: all active, sorted by SKU) + its refreshed_at,
// render the single-pane board.
export default async function InventoryPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    rows,
  ] = await Promise.all([
    supabase.auth.getUser(),
    getInventory({ state: 'all', sort: { column: 'item_code', dir: 'asc' } }),
  ]);
  const refreshedAt = rows[0]?.refreshed_at ?? null;
  return <InventoryBoard initialRows={rows} refreshedAt={refreshedAt} userEmail={user?.email || ''} />;
}

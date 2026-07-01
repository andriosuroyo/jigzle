import { createSupabaseServerClient } from '@jigzle/db/server';
import InventoryBoard from '@/components/InventoryBoard';
import { getInventory, getInventoryCounts } from '@/app/inventory/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the active snapshot (default: all active, sorted by SKU) + its refreshed_at +
// the per-tab counts, render the single-pane board.
export default async function InventoryPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    rows,
    counts,
  ] = await Promise.all([
    supabase.auth.getUser(),
    getInventory({ state: 'all', sort: { column: 'item_code', dir: 'asc' } }),
    getInventoryCounts(),
  ]);
  const refreshedAt = rows[0]?.refreshed_at ?? null;
  return <InventoryBoard initialRows={rows} initialCounts={counts} refreshedAt={refreshedAt} userEmail={user?.email || ''} />;
}

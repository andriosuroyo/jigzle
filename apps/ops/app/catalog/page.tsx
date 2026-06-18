import { createSupabaseServerClient } from '@jigzle/db/server';
import CatalogBoard from '@/components/CatalogBoard';
import { getNeedsReview, getSharedBarcodes } from '@/app/catalog/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the needs-review queue + shared-barcode list (for the two tab counts + lists),
// render the editor board. The All tab is search-driven (no initial list).
export default async function CatalogPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    needsReview,
    shared,
  ] = await Promise.all([supabase.auth.getUser(), getNeedsReview(), getSharedBarcodes()]);

  return (
    <CatalogBoard
      initialNeedsReview={needsReview}
      initialShared={shared}
      userEmail={user?.email || ''}
    />
  );
}

import { createSupabaseServerClient } from '@jigzle/db/server';
import FulfillBoard from '@/components/FulfillBoard';
import { getFulfillQueue } from '@/app/fulfill/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the initial worklist, render the two-pane board.
export default async function FulfillPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue] = await Promise.all([
    supabase.auth.getUser(),
    getFulfillQueue(false),
  ]);
  return <FulfillBoard initialQueue={queue} userEmail={user?.email || ''} />;
}

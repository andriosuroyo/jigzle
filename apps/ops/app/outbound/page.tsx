import { createSupabaseServerClient } from '@jigzle/db/server';
import OutboundBoard from '@/components/OutboundBoard';
import { getShipQueue } from '@/app/outbound/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the ready-to-ship worklist, render the two-pane board.
export default async function OutboundPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue] = await Promise.all([
    supabase.auth.getUser(),
    getShipQueue(),
  ]);
  return <OutboundBoard initialQueue={queue} userEmail={user?.email || ''} />;
}

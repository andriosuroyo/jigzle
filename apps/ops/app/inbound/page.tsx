import { createSupabaseServerClient } from '@jigzle/db/server';
import InboundBoard from '@/components/InboundBoard';
import { getReceiveQueue } from '@/app/inbound/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the arrivals queue (open shipments), render the two-pane board.
export default async function InboundPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue] = await Promise.all([
    supabase.auth.getUser(),
    getReceiveQueue(),
  ]);
  return <InboundBoard initialQueue={queue} userEmail={user?.email || ''} />;
}

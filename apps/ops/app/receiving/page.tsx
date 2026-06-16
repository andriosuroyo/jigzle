import { createSupabaseServerClient } from '@jigzle/db/server';
import ReceivingBoard from '@/components/ReceivingBoard';
import { getReceiveQueue } from '@/app/receiving/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the arrivals queue (open shipments), render the two-pane board.
export default async function ReceivingPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue] = await Promise.all([
    supabase.auth.getUser(),
    getReceiveQueue(),
  ]);
  return <ReceivingBoard initialQueue={queue} userEmail={user?.email || ''} />;
}

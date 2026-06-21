import { createSupabaseServerClient } from '@jigzle/db/server';
import InboundBoard from '@/components/InboundBoard';
import { getReceiveQueue } from '@/app/inbound/actions';
import { getInboundLabels } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the arrivals queue (open shipments) + the SETTINGS label pick-list, render the
// two-pane board (same way /fulfill loads courier services from SETTINGS).
export default async function InboundPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue, inboundLabels] = await Promise.all([
    supabase.auth.getUser(),
    getReceiveQueue(),
    getInboundLabels(),
  ]);
  return <InboundBoard initialQueue={queue} inboundLabels={inboundLabels} userEmail={user?.email || ''} />;
}

import { createSupabaseServerClient } from '@jigzle/db/server';
import InboundShell from '@/components/InboundShell';
import { getReceiveQueue, getReceiveHistory } from '@/app/inbound/actions';
import { getInboundLabels } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the arrivals queue (open shipments), the received-shipment History, and the
// SETTINGS label pick-list, then render the two-tab board (Shipments + History), mirroring Outbound.
export default async function InboundPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue, inboundLabels, historyRows] = await Promise.all([
    supabase.auth.getUser(),
    getReceiveQueue(),
    getInboundLabels(),
    getReceiveHistory(''),
  ]);
  return (
    <InboundShell
      initialQueue={queue}
      inboundLabels={inboundLabels}
      historyRows={historyRows}
      userEmail={user?.email || ''}
    />
  );
}

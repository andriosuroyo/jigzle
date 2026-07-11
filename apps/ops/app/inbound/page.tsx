import { createSupabaseServerClient } from '@jigzle/db/server';
import InboundShell from '@/components/InboundShell';
import { getReceiveQueue } from '@/app/inbound/actions';
import { getInboundLabels, getStaffOptions, getShipmentCouriers } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the arrivals queue (open shipments) + the SETTINGS label pick-list, then render
// the two-tab board (Active + History), mirroring Outbound. PERF (PR181): the received-shipment
// History (a paged full scan) is loaded lazily by InboundHistoryBoard on first open, not here —
// Inbound opens on Active, so the initial render waits only on the queue + labels.
export default async function InboundPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue, inboundLabels, staffOptions, shipmentCouriers] = await Promise.all([
    supabase.auth.getUser(),
    getReceiveQueue(),
    getInboundLabels(),
    getStaffOptions(),
    getShipmentCouriers(),
  ]);
  return (
    <InboundShell
      initialQueue={queue}
      inboundLabels={inboundLabels}
      historyRows={[]}
      staffOptions={staffOptions}
      shipmentCouriers={shipmentCouriers.map((c) => c.label)}
      userEmail={user?.email || ''}
    />
  );
}

import { createSupabaseServerClient } from '@jigzle/db/server';
import ProcurementBoard from '@/components/ProcurementBoard';
import { getForwarders, getOpenPOs, getOpenShipments, getSuppliers } from '@/app/procurement/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the open-PO queue + the supplier / forwarder / open-shipment lists for the
// form dropdowns, render the two-pane board.
export default async function ProcurementPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    queue,
    suppliers,
    forwarders,
    shipments,
  ] = await Promise.all([
    supabase.auth.getUser(),
    getOpenPOs(),
    getSuppliers(),
    getForwarders(),
    getOpenShipments(),
  ]);

  return (
    <ProcurementBoard
      initialQueue={queue}
      suppliers={suppliers}
      forwarders={forwarders}
      shipments={shipments}
      userEmail={user?.email || ''}
    />
  );
}

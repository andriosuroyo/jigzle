import { createSupabaseServerClient } from '@jigzle/db/server';
import OrderBoard from '@/components/OrderBoard';
import { getForwarders, getOpenPOs, getOpenShipments, getSuppliers } from '@/app/order/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the open-PO queue + the supplier / forwarder / open-shipment lists for the
// form dropdowns, render the two-pane board.
export default async function OrderPage() {
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
    <OrderBoard
      initialQueue={queue}
      suppliers={suppliers}
      forwarders={forwarders}
      shipments={shipments}
      userEmail={user?.email || ''}
    />
  );
}

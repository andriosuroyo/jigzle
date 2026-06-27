import { createSupabaseServerClient } from '@jigzle/db/server';
import PurchasingShell from '@/components/PurchasingShell';
import {
  getForwarders,
  getOpenPOs,
  getOpenShipments,
  getPlannedItems,
  getPreorders,
  getReceivedItems,
  getShipmentHistory,
  getSoldOutItems,
  getSuppliers,
} from '@/app/purchasing/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the open-PO queue + form dropdown lists, plus the read-only To-buy (preorder) and
// History (per item / per shipment) data, and render the four-tab board.
export default async function OrderPage() {
  const supabase = createSupabaseServerClient();
  const [
    { data: { user } },
    queue,
    suppliers,
    forwarders,
    shipments,
    planned,
    preorders,
    soldOut,
    receivedItems,
    shipmentHistory,
  ] = await Promise.all([
    supabase.auth.getUser(),
    getOpenPOs(),
    getSuppliers(),
    getForwarders(),
    getOpenShipments(),
    getPlannedItems(),
    getPreorders(),
    getSoldOutItems(),
    getReceivedItems(''),
    getShipmentHistory(''),
  ]);

  return (
    <PurchasingShell
      initialQueue={queue}
      suppliers={suppliers}
      forwarders={forwarders}
      shipments={shipments}
      planned={planned}
      preorders={preorders}
      soldOut={soldOut}
      receivedItems={receivedItems}
      shipmentHistory={shipmentHistory}
      userEmail={user?.email || ''}
    />
  );
}

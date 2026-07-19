import { createSupabaseServerClient } from '@jigzle/db/server';
import PurchasingShell from '@/components/PurchasingShell';
import {
  getForwarders,
  getOpenPOs,
  getOpenShipments,
  getPlannedItems,
  getPreorders,
  getSuppliers,
} from '@/app/purchasing/actions';
import { getLocalCouriers, getShipmentCouriers } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the open-PO queue + form dropdown lists and the read-only To-buy (preorder) data,
// then render the four-tab board. PERF (PR181): the shipment History (a paged PO scan + subqueries) is
// loaded lazily by PurchasingHistoryBoard on first open, not here — Purchasing opens on To forwarder.
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
    localCouriers,
    shipmentCouriers,
  ] = await Promise.all([
    supabase.auth.getUser(),
    getOpenPOs(),
    getSuppliers(),
    getForwarders(),
    getOpenShipments(),
    getPlannedItems(),
    getPreorders(),
    getLocalCouriers(),
    getShipmentCouriers(),
  ]);

  return (
    <PurchasingShell
      initialQueue={queue}
      suppliers={suppliers}
      forwarders={forwarders}
      shipments={shipments}
      planned={planned}
      preorders={preorders}
      shipmentHistory={[]}
      localCouriers={localCouriers.map((c) => c.label)}
      courierIcons={Object.fromEntries(localCouriers.filter((c) => c.icon).map((c) => [c.label, c.icon as string]))}
      shipmentCouriers={shipmentCouriers.map((c) => c.label)}
      userEmail={user?.email || ''}
    />
  );
}

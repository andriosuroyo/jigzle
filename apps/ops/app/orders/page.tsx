import { createSupabaseServerClient } from '@jigzle/db/server';
import OrdersShell, { type OrdersTab } from '@/components/OrdersShell';
import { getPending } from '@/app/pending/actions';
import { getToSendQueue } from '@/app/fulfill/actions';
import { getShipQueue } from '@/app/outbound/actions';
import { getHistory } from '@/app/history/actions';
import { getPaymentMethods, getCourierServices, getBoxPresets } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const TABS: OrdersTab[] = ['pending', 'fulfill', 'outbound', 'history'];

// JZ-001 — server shell for the Orders pipeline window. Loads every stage queue + the SETTINGS lists
// up front (so each tab's board and its count badge are ready on open), then hands them to the client
// OrdersShell. ?tab= picks the open tab (default Pending); ?order= deep-links a Fulfill/Outbound order.
export default async function OrdersPage({
  searchParams,
}: {
  searchParams?: { tab?: string; order?: string };
}) {
  const supabase = createSupabaseServerClient();
  const [
    { data: { user } },
    pending,
    toSend,
    ship,
    history,
    paymentMethods,
    courierServices,
    boxPresets,
  ] = await Promise.all([
    supabase.auth.getUser(),
    getPending(),
    getToSendQueue(),
    getShipQueue(),
    getHistory(''),
    getPaymentMethods(),
    getCourierServices(),
    getBoxPresets(),
  ]);

  const tabParam = (searchParams?.tab ?? '') as OrdersTab;
  const initialTab: OrdersTab = TABS.includes(tabParam) ? tabParam : 'pending';
  const initialOrderId = searchParams?.order || null;

  return (
    <OrdersShell
      userEmail={user?.email || ''}
      initialTab={initialTab}
      initialOrderId={initialOrderId}
      pending={pending}
      toSend={toSend}
      ship={ship}
      history={history}
      paymentMethods={paymentMethods}
      courierServices={courierServices}
      boxPresets={boxPresets}
    />
  );
}

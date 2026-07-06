import { createSupabaseServerClient } from '@jigzle/db/server';
import OrdersShell, { type OrdersTab } from '@/components/OrdersShell';
import { getPending } from '@/app/pending/actions';
import { getToSendQueue } from '@/app/fulfill/actions';
import { getPaymentMethods, getCourierServices, getBoxPresets, getCommonNotes, getChannelOptions, getExportCouriers } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const TABS: OrdersTab[] = ['pending', 'fulfill', 'history'];

// JZ-001 — server shell for the Sales pipeline window (canonical route: /sales). Loads the Pending +
// Fulfill queues and the SETTINGS lists they need, then hands them to the client OrdersShell. ?tab=
// picks the open tab (default Pending); ?order= deep-links a Fulfill order. The create-order form is
// the sibling route /sales/new (opened by the window's "+ New" button).
//
// PERF (PR179): History (17k+ terminal orders, ~18 paged round-trips) is NO LONGER loaded here — it
// used to block the whole page even though Sales opens on Pending. HistoryBoard now fetches it lazily
// the first time the History tab is shown, so the initial Sales render only waits on the fast queues.
export default async function SalesPage({
  searchParams,
}: {
  searchParams?: { tab?: string; order?: string };
}) {
  const supabase = createSupabaseServerClient();
  const [
    { data: { user } },
    pending,
    toSend,
    paymentMethods,
    courierServices,
    boxPresets,
    commonNotes,
    channelOptions,
    exportCouriers,
  ] = await Promise.all([
    supabase.auth.getUser(),
    getPending(),
    getToSendQueue(),
    getPaymentMethods(),
    getCourierServices(),
    getBoxPresets(),
    getCommonNotes(),
    getChannelOptions(),
    getExportCouriers(),
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
      history={[]}
      paymentMethods={paymentMethods}
      courierServices={courierServices}
      boxPresets={boxPresets}
      commonNotes={commonNotes}
      channelOptions={channelOptions}
      exportCouriers={exportCouriers.filter((c) => c.is_active)}
    />
  );
}

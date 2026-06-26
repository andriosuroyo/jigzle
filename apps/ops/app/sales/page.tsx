import { createSupabaseServerClient } from '@jigzle/db/server';
import OrdersShell, { type OrdersTab } from '@/components/OrdersShell';
import { getPending } from '@/app/pending/actions';
import { getToSendQueue } from '@/app/fulfill/actions';
import { getHistory } from '@/app/history/actions';
import { getPaymentMethods, getCourierServices, getBoxPresets } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const TABS: OrdersTab[] = ['pending', 'fulfill', 'history'];

// JZ-001 — server shell for the Sales pipeline window (canonical route: /sales). Loads the Pending +
// Fulfill queues, the recent History, and the SETTINGS lists they need, then hands them to the client
// OrdersShell. ?tab= picks the open tab (default Pending); ?order= deep-links a Fulfill order. The
// create-order form is the sibling route /sales/new (opened by the window's "+ New" button).
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
    history,
    paymentMethods,
    courierServices,
    boxPresets,
  ] = await Promise.all([
    supabase.auth.getUser(),
    getPending(),
    getToSendQueue(),
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
      history={history}
      paymentMethods={paymentMethods}
      courierServices={courierServices}
      boxPresets={boxPresets}
    />
  );
}

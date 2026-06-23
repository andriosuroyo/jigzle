import { createSupabaseServerClient } from '@jigzle/db/server';
import HistoryBoard from '@/components/HistoryBoard';
import { getHistory } from '@/app/history/actions';
import { getPaymentMethods } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the newest orders (unfiltered) + SETTINGS payment methods (Mark paid), render the
// read-only History board (HI-1 search · HI-2 summary · HI-4 Mark paid).
export default async function HistoryPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, orders, paymentMethods] = await Promise.all([
    supabase.auth.getUser(),
    getHistory(''),
    getPaymentMethods(),
  ]);
  return <HistoryBoard initialOrders={orders} paymentMethods={paymentMethods} userEmail={user?.email || ''} />;
}

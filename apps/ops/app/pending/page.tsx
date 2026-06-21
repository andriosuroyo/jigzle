import { createSupabaseServerClient } from '@jigzle/db/server';
import PendingBoard from '@/components/PendingBoard';
import { getPending } from '@/app/pending/actions';
import { getPaymentMethods } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the Pending queue (orders with ≥1 uncut line) + SETTINGS payment methods (Mark
// paid panel), render the board.
export default async function PendingPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    orders,
    paymentMethods,
  ] = await Promise.all([supabase.auth.getUser(), getPending(), getPaymentMethods()]);

  return <PendingBoard initialOrders={orders} paymentMethods={paymentMethods} userEmail={user?.email || ''} />;
}

import { createSupabaseServerClient } from '@jigzle/db/server';
import OrdersBoard from '@/components/OrdersBoard';
import { getOrders } from '@/app/orders/actions';
import { getPaymentMethods } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the full order list + SETTINGS payment methods (Need-payment panel), render the board.
export default async function OrdersPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    orders,
    paymentMethods,
  ] = await Promise.all([supabase.auth.getUser(), getOrders('all'), getPaymentMethods()]);

  return <OrdersBoard initialOrders={orders} paymentMethods={paymentMethods} userEmail={user?.email || ''} />;
}

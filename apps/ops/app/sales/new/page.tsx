import { createSupabaseServerClient } from '@jigzle/db/server';
import OrderEntry from '@/components/OrderEntry';
import { getPaymentMethods, getChannelOptions } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Thin server shell: resolve the signed-in user + the SETTINGS payment methods (SA-5 picker) + the
// contact-channel pick-list (new-customer form), render the client screen.
export default async function NewSalesOrderPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, paymentMethods, channelOptions] = await Promise.all([
    supabase.auth.getUser(),
    getPaymentMethods(),
    getChannelOptions(),
  ]);
  return <OrderEntry userEmail={user?.email || ''} paymentMethods={paymentMethods} channelOptions={channelOptions} />;
}

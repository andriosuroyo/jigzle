import { createSupabaseServerClient } from '@jigzle/db/server';
import OrderEntry from '@/components/OrderEntry';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Thin server shell: resolve the signed-in user, render the client screen.
export default async function NewSalesOrderPage() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return <OrderEntry userEmail={user?.email || ''} />;
}

import { createSupabaseServerClient } from '@jigzle/db/server';
import CustomersBoard from '@/components/CustomersBoard';
import { getCustomers, getCustomerTiers } from '@/app/customers/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the A–Z directory (lightweight) + per-customer tiers + the user, render the board.
export default async function CustomersPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    customers,
    tiers,
  ] = await Promise.all([supabase.auth.getUser(), getCustomers(), getCustomerTiers()]);

  return <CustomersBoard initialCustomers={customers} initialTiers={tiers} userEmail={user?.email || ''} />;
}

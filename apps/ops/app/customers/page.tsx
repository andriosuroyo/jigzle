import { createSupabaseServerClient } from '@jigzle/db/server';
import CustomersBoard from '@/components/CustomersBoard';
import { getCustomers } from '@/app/customers/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the A–Z directory (lightweight) + the signed-in user, render the board.
export default async function CustomersPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    customers,
  ] = await Promise.all([supabase.auth.getUser(), getCustomers()]);

  return <CustomersBoard initialCustomers={customers} userEmail={user?.email || ''} />;
}

import { createSupabaseServerClient } from '@jigzle/db/server';
import CustomersBoard from '@/components/CustomersBoard';
import { getCustomers, getCustomerTiers } from '@/app/customers/actions';
import { getChannelOptions } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the A–Z directory (lightweight) + per-customer tiers + channel options + the user.
export default async function CustomersPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    customers,
    tiers,
    channelOptions,
  ] = await Promise.all([supabase.auth.getUser(), getCustomers(), getCustomerTiers(), getChannelOptions()]);

  return (
    <CustomersBoard
      initialCustomers={customers}
      initialTiers={tiers}
      channelOptions={channelOptions}
      userEmail={user?.email || ''}
    />
  );
}

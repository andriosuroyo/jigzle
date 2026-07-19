import { createSupabaseServerClient } from '@jigzle/db/server';
import CustomersBoard from '@/components/CustomersBoard';
import { getCustomerLetterCounts, getCustomersByLetter, getCustomerTiers } from '@/app/customers/actions';
import { getChannelOptions } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const INITIAL_LETTER = 'A'; // PR389 — the first A–Z bucket rendered; the rest load on tab open.

// Server shell: load just the A–Z counts + the first letter's rows (not the whole directory) + per-customer
// tiers + channel options + the user. The rest of the directory loads per-letter (and the full list loads
// lazily only when the Search box is used).
export default async function CustomersPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    letterCounts,
    initialRows,
    tiers,
    channelOptions,
  ] = await Promise.all([
    supabase.auth.getUser(),
    getCustomerLetterCounts(),
    getCustomersByLetter(INITIAL_LETTER),
    getCustomerTiers(),
    getChannelOptions(),
  ]);

  return (
    <CustomersBoard
      letterCounts={letterCounts}
      initialLetter={INITIAL_LETTER}
      initialRows={initialRows}
      initialTiers={tiers}
      channelOptions={channelOptions}
      userEmail={user?.email || ''}
    />
  );
}

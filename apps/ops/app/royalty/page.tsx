import { createSupabaseServerClient } from '@jigzle/db/server';
import RoyaltyBoard from '@/components/RoyaltyBoard';
import { getRoyaltyEntities } from '@/app/royalty/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the royalty entities + the signed-in user, render the board.
export default async function RoyaltyPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, entities] = await Promise.all([
    supabase.auth.getUser(),
    getRoyaltyEntities(),
  ]);
  return <RoyaltyBoard entities={entities} userEmail={user?.email || ''} />;
}

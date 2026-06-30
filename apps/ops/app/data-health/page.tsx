import { createSupabaseServerClient } from '@jigzle/db/server';
import DataHealthBoard from '@/components/DataHealthBoard';
import { getDataHealth } from '@/app/customers/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: run the read-only customer-integrity scan + load the user, render the board.
export default async function DataHealthPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    health,
  ] = await Promise.all([supabase.auth.getUser(), getDataHealth()]);

  return <DataHealthBoard initial={health} userEmail={user?.email || ''} />;
}

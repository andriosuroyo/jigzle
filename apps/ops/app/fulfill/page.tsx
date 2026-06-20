import { createSupabaseServerClient } from '@jigzle/db/server';
import FulfillBoard from '@/components/FulfillBoard';
import { getFulfillQueue } from '@/app/fulfill/actions';
import { getCourierServices } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the worklist + the SETTINGS courier list (PR26 courier dropdown), render the board.
export default async function FulfillPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue, courierServices] = await Promise.all([
    supabase.auth.getUser(),
    getFulfillQueue(false),
    getCourierServices(),
  ]);
  return <FulfillBoard initialQueue={queue} courierServices={courierServices} userEmail={user?.email || ''} />;
}

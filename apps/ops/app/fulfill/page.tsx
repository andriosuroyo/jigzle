import { createSupabaseServerClient } from '@jigzle/db/server';
import FulfillBoard from '@/components/FulfillBoard';
import { getToSendQueue } from '@/app/fulfill/actions';
import { getCourierServices } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the To-send queue (cut + courier-null orders) + the SETTINGS courier list, render
// the board. An optional ?order= preselects that order (deep-link).
export default async function FulfillPage({ searchParams }: { searchParams?: { order?: string } }) {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue, courierServices] = await Promise.all([
    supabase.auth.getUser(),
    getToSendQueue(),
    getCourierServices(),
  ]);
  return (
    <FulfillBoard
      initialQueue={queue}
      courierServices={courierServices}
      initialOrderId={searchParams?.order ?? null}
      userEmail={user?.email || ''}
    />
  );
}

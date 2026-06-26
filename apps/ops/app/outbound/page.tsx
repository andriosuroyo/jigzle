import { createSupabaseServerClient } from '@jigzle/db/server';
import OutboundBoard from '@/components/OutboundBoard';
import { getShipQueue } from '@/app/outbound/actions';
import { getBoxPresets } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the ready-to-ship worklist + the SETTINGS box presets (PR26 box dropdown), render
// the board. An optional ?order= preselects that order (deep-link).
//   Outbound is the warehouse/shipping screen, NOT part of the Sales pipeline window — the Sales team's
//   job stops at Fulfill (which moves the order into this ship queue). So it lives on its own route.
export default async function OutboundPage({ searchParams }: { searchParams?: { order?: string } }) {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue, boxPresets] = await Promise.all([
    supabase.auth.getUser(),
    getShipQueue(),
    getBoxPresets(),
  ]);
  return (
    <OutboundBoard
      initialQueue={queue}
      boxPresets={boxPresets}
      initialOrderId={searchParams?.order ?? null}
      userEmail={user?.email || ''}
    />
  );
}

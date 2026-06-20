import { createSupabaseServerClient } from '@jigzle/db/server';
import OutboundBoard from '@/components/OutboundBoard';
import { getShipQueue } from '@/app/outbound/actions';
import { getBoxPresets } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the ready-to-ship worklist + the SETTINGS box presets (PR26 box dropdown), render the board.
export default async function OutboundPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue, boxPresets] = await Promise.all([
    supabase.auth.getUser(),
    getShipQueue(),
    getBoxPresets(),
  ]);
  return <OutboundBoard initialQueue={queue} boxPresets={boxPresets} userEmail={user?.email || ''} />;
}

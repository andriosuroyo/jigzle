import { createSupabaseServerClient } from '@jigzle/db/server';
import OutboundShell from '@/components/OutboundShell';
import { getShipQueue, getShippedHistory } from '@/app/outbound/actions';
import { getBoxPresets } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Outbound is the warehouse/shipping window (separate from Sales). Two tabs: Ready to ship (the live
// fulfilled-unshipped queue) and History (orders we've shipped). ?order= deep-links a ready-to-ship
// order. Loads the queue + recent shipped history + SETTINGS box presets up front.
export default async function OutboundPage({ searchParams }: { searchParams?: { order?: string } }) {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue, shippedHistory, boxPresets] = await Promise.all([
    supabase.auth.getUser(),
    getShipQueue(),
    getShippedHistory(''),
    getBoxPresets(),
  ]);
  return (
    <OutboundShell
      userEmail={user?.email || ''}
      initialQueue={queue}
      boxPresets={boxPresets}
      shippedHistory={shippedHistory}
      initialOrderId={searchParams?.order ?? null}
    />
  );
}

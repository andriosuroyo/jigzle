import { createSupabaseServerClient } from '@jigzle/db/server';
import OutboundShell from '@/components/OutboundShell';
import { getShipQueue } from '@/app/outbound/actions';
import { getBoxPresets, getStaffOptions } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Outbound is the warehouse/shipping window (separate from Sales). Two tabs: Ready to ship (the live
// fulfilled-unshipped queue) and History (orders we've shipped). ?order= deep-links a ready-to-ship
// order. PERF (PR181): the shipped History is loaded lazily by OutboundHistoryBoard on first open, not
// here — Outbound opens on Ready to ship, so the initial render waits only on the queue + settings.
export default async function OutboundPage({ searchParams }: { searchParams?: { order?: string } }) {
  const supabase = createSupabaseServerClient();
  const [{ data: { user } }, queue, boxPresets, staffOptions] = await Promise.all([
    supabase.auth.getUser(),
    getShipQueue(),
    getBoxPresets(),
    getStaffOptions(),
  ]);
  return (
    <OutboundShell
      userEmail={user?.email || ''}
      initialQueue={queue}
      boxPresets={boxPresets}
      staffOptions={staffOptions}
      initialOrderId={searchParams?.order ?? null}
    />
  );
}

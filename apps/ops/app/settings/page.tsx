import { createSupabaseServerClient } from '@jigzle/db/server';
import SettingsBoard from '@/components/SettingsBoard';
import { getSettings } from '@/app/settings/actions';
import { getSuppliers, getForwarders } from '@/app/purchasing/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the settings lists + suppliers + forwarders + the signed-in user, render the board.
export default async function SettingsPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    settings,
    suppliers,
    forwarders,
  ] = await Promise.all([supabase.auth.getUser(), getSettings(), getSuppliers(), getForwarders()]);

  return <SettingsBoard initial={settings} suppliers={suppliers} forwarders={forwarders} userEmail={user?.email || ''} />;
}

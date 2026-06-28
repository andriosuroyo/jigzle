import { createSupabaseServerClient } from '@jigzle/db/server';
import SettingsBoard from '@/components/SettingsBoard';
import { getSettings } from '@/app/settings/actions';
import { getSuppliers } from '@/app/purchasing/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the settings lists + suppliers + the signed-in user, render the editor board.
export default async function SettingsPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    settings,
    suppliers,
  ] = await Promise.all([supabase.auth.getUser(), getSettings(), getSuppliers()]);

  return <SettingsBoard initial={settings} suppliers={suppliers} userEmail={user?.email || ''} />;
}

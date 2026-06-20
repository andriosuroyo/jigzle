import { createSupabaseServerClient } from '@jigzle/db/server';
import SettingsBoard from '@/components/SettingsBoard';
import { getSettings } from '@/app/settings/actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load the three settings lists + the signed-in user, render the editor board.
export default async function SettingsPage() {
  const supabase = createSupabaseServerClient();
  const [
    {
      data: { user },
    },
    settings,
  ] = await Promise.all([supabase.auth.getUser(), getSettings()]);

  return <SettingsBoard initial={settings} userEmail={user?.email || ''} />;
}

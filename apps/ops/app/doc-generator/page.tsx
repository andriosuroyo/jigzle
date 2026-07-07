import { createSupabaseServerClient } from '@jigzle/db/server';
import DocGeneratorBoard from '@/components/DocGeneratorBoard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function DocGeneratorPage() {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  return <DocGeneratorBoard userEmail={data.user?.email || ''} />;
}

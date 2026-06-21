import { createSupabaseServerClient } from '@jigzle/db/server';
import HistoryBoard from '@/components/HistoryBoard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// PR-B Stage 1 skeleton shell; the real read-only History board (search + summary + Mark paid) lands in Stage 6.
export default async function HistoryPage() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return <HistoryBoard userEmail={user?.email || ''} />;
}

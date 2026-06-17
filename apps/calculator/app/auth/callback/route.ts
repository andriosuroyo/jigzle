import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@jigzle/db/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (code) {
    const supabase = createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const { data: { user } } = await supabase.auth.getUser();
      // Allow-list check via the DB function that reads public.allowed_users (migration 0017).
      const { data: allowed } = await supabase.rpc('is_allowed_user');
      if (!user || !allowed) {
        await supabase.auth.signOut();
        return NextResponse.redirect(new URL('/login?error=unauthorized', url.origin));
      }
      return NextResponse.redirect(new URL('/', url.origin));
    }
  }

  return NextResponse.redirect(new URL('/login?error=unauthorized', url.origin));
}

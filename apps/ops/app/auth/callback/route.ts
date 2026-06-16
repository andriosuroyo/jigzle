import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@jigzle/db/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  // comma-separated allowed-login set; kept in sync with the DB's is_allowed_user() (migration 0016)
  const allowed = (process.env.ALLOWED_USER_EMAIL || 'andriosuroyo@gmail.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (code) {
    const supabase = createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !allowed.includes((user.email || '').toLowerCase())) {
        await supabase.auth.signOut();
        return NextResponse.redirect(new URL('/login?error=unauthorized', url.origin));
      }
      return NextResponse.redirect(new URL('/', url.origin));
    }
  }

  return NextResponse.redirect(new URL('/login?error=unauthorized', url.origin));
}

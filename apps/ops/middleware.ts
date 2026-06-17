import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

// The allow-list lives in ONE place: the DB's public.allowed_users table, read by the
// is_allowed_user() RLS function (migration 0017). This UX gate asks that same function via RPC,
// so there is no env var or code list to keep in sync — add/remove a user with a single row in
// allowed_users and every gate (this one, the auth callback, and table RLS) follows.

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: { headers: req.headers } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return req.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          req.cookies.set({ name, value, ...options });
          res = NextResponse.next({ request: { headers: req.headers } });
          res.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          req.cookies.set({ name, value: '', ...options });
          res = NextResponse.next({ request: { headers: req.headers } });
          res.cookies.set({ name, value: '', ...options });
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  const path = req.nextUrl.pathname;
  const isPublic =
    path === '/login' ||
    path.startsWith('/auth/callback') ||
    path.startsWith('/_next') ||
    path === '/manifest.json' ||
    path === '/sw.js' ||
    path.startsWith('/icons') ||
    path === '/favicon.ico';

  if (isPublic) return res;

  if (!user) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Authoritative allow-list check: ask the DB function that reads public.allowed_users.
  const { data: allowed } = await supabase.rpc('is_allowed_user');
  if (!allowed) {
    await supabase.auth.signOut();
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('error', 'unauthorized');
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

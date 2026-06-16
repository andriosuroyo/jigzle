import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

// The allowed-login set (UX gate). ALLOWED_USER_EMAIL is comma-separated — trim + lowercase each.
// The AUTHORITATIVE gate is the DB's is_allowed_user() RLS function (migration 0016); keep its
// email list in sync with this env var, or a user that passes here will be blocked by RLS.
const ALLOWED_EMAILS = (process.env.ALLOWED_USER_EMAIL || 'andriosuroyo@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

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

  if (!ALLOWED_EMAILS.includes((user.email || '').toLowerCase())) {
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

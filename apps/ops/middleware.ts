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

  // Cacheable static assets: hashed Next bundles (immutable), the manifest, and the icons/brand images.
  const isAsset =
    path.startsWith('/_next') ||
    path === '/manifest.json' ||
    path === '/sw.js' ||
    path.startsWith('/icons') ||
    path === '/favicon.ico' ||
    path === '/logo.webp' ||
    path === '/icon.png' ||
    path === '/apple-icon.png';

  // PR232 — the app has no service worker, so an installed iOS PWA (or a browser tab) keeps serving the
  // HTML document from its own HTTP cache after a deploy — the classic "my change didn't show up until I
  // reopened the app". Every page is force-dynamic (the server always renders fresh) and the referenced
  // /_next bundles are content-hashed, so it's safe to forbid caching the DOCUMENT + server actions:
  // the browser re-fetches the current HTML each launch, which pulls the latest bundle. Assets stay
  // cacheable (they're immutable / rarely change).
  const noStore = (r: NextResponse): NextResponse => {
    if (!isAsset) r.headers.set('Cache-Control', 'no-store, must-revalidate');
    return r;
  };

  // Brand assets rendered on the (unauthenticated) login screen + the app/apple icons iOS fetches for
  // "Add to Home Screen" are public; the login/callback pages are public too (PR198).
  const isPublic = path === '/login' || path.startsWith('/auth/callback') || isAsset;

  if (isPublic) return noStore(res);

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

  return noStore(res);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

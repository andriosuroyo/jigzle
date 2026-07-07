/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @react-pdf/renderer (Doc Generator) ships ESM-only — Next must transpile it or webpack throws
  // "ESM packages need to be imported" at build (PR202).
  transpilePackages: ['@jigzle/ui', '@jigzle/lib', '@jigzle/db', '@react-pdf/renderer'],
  // PR195 (URGENT freshness fix): kill the App Router CLIENT-side Router Cache stale window. Next 14.2
  // defaults a navigated dynamic route to 30s of stale reuse — so after a write (receive stock in
  // Inbound, a button in Sales/Purchasing) navigating away and back within 30s served the CACHED render
  // and the change "didn't show until refresh". Every page here is already force-dynamic + revalidate=0
  // (the SERVER always renders fresh), so setting both stale times to 0 makes every navigation refetch
  // fresh server data — and a route change remounts the board, so it re-reads the fresh props too.
  experimental: {
    staleTimes: { dynamic: 0, static: 0 },
  },
  // Old board routes were renamed (Procurement→Order→Purchasing, Receiving→Inbound, Catalogue→Catalog).
  // 308-redirect the old paths so existing links/bookmarks don't 404. Runs before middleware/auth.
  // NB: /orders is now a real page (the Sales pipeline window, JZ-001) — it must NOT be redirected
  // here, or it loops with the app-level /pending → /orders redirect.
  async redirects() {
    return [
      { source: '/procurement', destination: '/purchasing', permanent: true },
      { source: '/order', destination: '/purchasing', permanent: true },
      { source: '/receiving', destination: '/inbound', permanent: true },
      { source: '/catalogue', destination: '/catalog', permanent: true },
    ];
  },
};

module.exports = nextConfig;

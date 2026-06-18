/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@jigzle/ui', '@jigzle/lib', '@jigzle/db'],
  // Old board routes were renamed (Procurement→Order, Receiving→Inbound, Catalogue→Catalog).
  // 308-redirect the old paths so existing links/bookmarks don't 404. Runs before middleware/auth.
  async redirects() {
    return [
      { source: '/procurement', destination: '/order', permanent: true },
      { source: '/receiving', destination: '/inbound', permanent: true },
      { source: '/catalogue', destination: '/catalog', permanent: true },
    ];
  },
};

module.exports = nextConfig;

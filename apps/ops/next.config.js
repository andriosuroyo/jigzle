/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@jigzle/ui', '@jigzle/lib', '@jigzle/db'],
  // Old board routes were renamed (Procurement→Order→Purchasing, Receiving→Inbound, Catalogue→Catalog,
  // Orders→Pending). 308-redirect the old paths so existing links/bookmarks don't 404. Runs before
  // middleware/auth.
  async redirects() {
    return [
      { source: '/procurement', destination: '/purchasing', permanent: true },
      { source: '/order', destination: '/purchasing', permanent: true },
      { source: '/orders', destination: '/pending', permanent: true },
      { source: '/receiving', destination: '/inbound', permanent: true },
      { source: '/catalogue', destination: '/catalog', permanent: true },
    ];
  },
};

module.exports = nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@jigzle/ui', '@jigzle/lib', '@jigzle/db'],
};

module.exports = nextConfig;

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@scenox/shared'],
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    // In production Caddy routes /api to the API; this keeps `next dev` working.
    const target = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },
};

export default nextConfig;

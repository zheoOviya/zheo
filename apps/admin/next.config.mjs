/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: [".monkeycode-ai.live"],
  experimental: {},
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:3001/api/:path*",
      },
    ];
  },
};

export default nextConfig;

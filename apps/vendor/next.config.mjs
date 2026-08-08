/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedHosts: [".monkeycode-ai.live"],
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

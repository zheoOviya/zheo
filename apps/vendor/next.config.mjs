/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["*.monkeycode-ai.live"],
  images: {
    remotePatterns: [],
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:3001/api/:path*",
      },
    ];
  },
};

export default nextConfig;

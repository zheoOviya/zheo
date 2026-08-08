import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

function imageHosts() {
  const configured = (process.env.NEXT_PUBLIC_IMAGE_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  return ["picsum.photos"];
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: imageHosts().map((hostname) => ({
      protocol: "https",
      hostname,
    })),
  },
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

export default withBundleAnalyzer(nextConfig);

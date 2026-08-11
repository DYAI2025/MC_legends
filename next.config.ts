import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  // Loopback hosts used by local dev and Playwright. Without this, Next blocks
  // /_next/* dev resources for 127.0.0.1 and the page never hydrates.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;

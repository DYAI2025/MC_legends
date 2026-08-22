import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  // Loopback hosts used by local dev and Playwright. Without this, Next blocks
  // /_next/* dev resources for 127.0.0.1 and the page never hydrates.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  /**
   * MCL-35: a second dev server needs a build directory of its own.
   *
   * `next dev` takes a lock inside its build directory and refuses to start a second
   * instance for the same one ("Another next dev server is already running"). The
   * lifecycle e2e project runs on its own server so that closing a question cannot
   * disturb the specs that assert the seeded one, and locally that server is a dev
   * server like the other.
   *
   * Unset - which is every build, every deployment and every ordinary `npm run dev` -
   * this is exactly the Next.js default, so nothing about the shipped artefact changes.
   * Only playwright.config.ts sets it, and only for the second server.
   */
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
};

export default nextConfig;

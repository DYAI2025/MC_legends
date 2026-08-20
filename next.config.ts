import type { NextConfig } from "next";

/**
 * MCL-63. True only for `npm run build:cloudflare`, which sets the variable; the normal
 * VPS/Node `npm run build` never does, so the exported config below is byte-identical
 * to what it has always been.
 */
const isCloudflareBuild = process.env.MCL_CLOUDFLARE_BUILD === "1";

/**
 * MCL-63. Removes the server persistence adapters - and with them `pg` - from the
 * Cloudflare module graph.
 *
 * Why an alias and not a dependency fix: `next build` traces `src/composition/server.ts`
 * -> PostgresSubmissionInboxStore -> `pg`, and `pg/lib/stream.js` requires
 * `pg-cloudflare`. Next's tracer copies that package under its *default* export
 * condition (`dist/empty.js`), while OpenNext bundles the worker with esbuild
 * `conditions: ["workerd"]`, which demands `dist/index.js`. OpenNext heals that gap only
 * for packages named in `serverExternalPackages`. Naming `pg` there would fix the build
 * by shipping a working TCP PostgreSQL client into the Worker - which MCL-48 forbids,
 * because the database is reachable only from inside the VPS boundary.
 *
 * The file adapter is aliased too, and that is not incidental: without it the
 * composition root would fall back to FileSubmissionInboxStore whenever DATABASE_URL is
 * unset, and a Worker-local filesystem write would be answered with a receipt. See
 * cloudflare/persistence-unavailable.ts.
 *
 * Next 16 builds with Turbopack (confirmed in the build banner), so the alias lives
 * under `turbopack.resolveAlias`.
 */
const cloudflarePersistenceAlias = {
  // Not covered by the two adapter aliases below: src/app/api/health/ready/route.ts
  // imports Client from "pg" directly, to probe with a short-lived client rather than
  // the adapter's pool. Measured 2026-08-20 - with only the adapter aliases in place,
  // that route was the sole remaining trace root and the build still failed.
  pg: "./cloudflare/pg-unavailable.ts",
  "@/adapters/persistence/postgres-submission-inbox-store":
    "./cloudflare/persistence-unavailable.ts",
  "@/adapters/persistence/file-submission-inbox-store":
    "./cloudflare/persistence-unavailable.ts",
} as const;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  // Loopback hosts used by local dev and Playwright. Without this, Next blocks
  // /_next/* dev resources for 127.0.0.1 and the page never hydrates.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  ...(isCloudflareBuild ? { turbopack: { resolveAlias: cloudflarePersistenceAlias } } : {}),
};

export default nextConfig;

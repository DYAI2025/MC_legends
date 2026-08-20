import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * MCL-63. The Cloudflare/OpenNext build contract, committed so that Cloudflare stops
 * migrating this project during every deployment.
 *
 * No argument on purpose: `defineCloudflareConfig()` defaults the incremental cache,
 * the tag cache, the queue and the CDN invalidation handler to "dummy", so the first
 * deployment needs no R2 bucket, no Durable Object and no service binding. This site is
 * server-rendered from a framework-free dataset and its dynamic surface (`/admin`,
 * `/api/health/ready`) is already `force-dynamic`, so there is no ISR cache worth
 * paying an R2 bucket for yet. Adding one later is a change here plus a binding in
 * wrangler.jsonc, and nothing else.
 *
 * `cloudflare.useWorkerdCondition` is deliberately left at its default (`true`).
 * Setting it to `false` makes esbuild bundle with `conditions: []`, which would also
 * silence the `pg-cloudflare` resolution error this ticket is about - by shipping a
 * working TCP PostgreSQL client into the Worker. MCL-48 says the database is reached
 * only from inside the VPS boundary, so the fix is to remove `pg` from the Cloudflare
 * module graph (see next.config.ts), never to make it resolvable here.
 */
export default defineCloudflareConfig();

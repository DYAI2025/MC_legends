# Cloudflare Workers deployment (MCL-63)

Living runbook for the Cloudflare/OpenNext deployment. The VPS deployment is unchanged and is
documented separately in `vps-mc-legends.md`; the two coexist on purpose.

## What Cloudflare runs, and what it does not

```text
Browser
  -> Cloudflare Worker            pages, SSR and static assets
     /api/*  -> https://srv1308064.hstgr.cloud:8443
                  -> the existing VPS Node process
                     -> PostgreSQL over a Unix socket, inside the VPS boundary
```

The Worker never talks to PostgreSQL. It cannot: the database is reached over a Unix socket by the
process that sits next to it, and the port is not published. That is MCL-48's boundary and this
deployment does not move it. `cloudflare/worker.ts` forwards every `/api/*` request to the VPS
before the generated OpenNext handler is consulted, and `next.config.ts` resolves both persistence
adapters and `pg` to fail-closed stubs for this build only — so a request that somehow reached the
local handlers would be refused, never answered with a receipt for something nobody stored.

## Dashboard settings

Workers Builds must use the repository's own scripts. Do **not** leave the project on
`npx wrangler deploy`: with no committed Cloudflare configuration, wrangler ran an automatic
Next.js migration inside every deployment build and installed `wrangler` and
`@opennextjs/cloudflare` unpinned. That is how the `Could not resolve "pg-cloudflare"` failure of
2026-08-19 was produced.

| Setting | Value |
| --- | --- |
| Build command | `npm run build:cloudflare` |
| Deploy command | `npm run deploy:cloudflare` |

`opennextjs-cloudflare build` runs `next build` itself, so no separate build step is needed.

`opennextjs-cloudflare deploy` does **not** build — it populates the cache and runs
`wrangler deploy`. It has no `--skipBuild` flag (only `build` does, as an alias of
`--skipNextBuild`), so passing one forwards an unknown argument to wrangler. Read out of
`@opennextjs/cloudflare@1.20.2`, `dist/cli/commands/deploy.js`.

## Local

```bash
npm run build:cloudflare            # real worker build; MCL_CLOUDFLARE_BUILD=1 is set by the script
npm run check:cloudflare-bundle     # asserts pg is absent and the fail-closed stub is present
npm run preview:cloudflare          # wrangler dev against the built output; does not build
```

`preview` and `deploy` both expect a build to have run already.

## Configuration

- `wrangler.jsonc` — `main` is `cloudflare/worker.ts`, assets come from `.open-next/assets`,
  `nodejs_compat` is required by the OpenNext runtime. `vars.MCL_API_ORIGIN` is the VPS API base
  URL: a public hostname, not a secret.
- `open-next.config.ts` — `defineCloudflareConfig()` with no argument, which defaults every cache
  override to `dummy`. No R2 bucket, no Durable Object and no service binding is required.

No `AVALORIA_*` value belongs in either file, or in any other committed file. The family and admin
codes stay on the VPS, because that is where the API lives.

## Before the first deploy

1. Create the Worker and set its name to match `wrangler.jsonc` (`mc-legends`).
2. Confirm `https://srv1308064.hstgr.cloud:8443` serves the API with a certificate the Worker
   accepts. This has not been verified from CI; it is the one runtime prerequisite this change does
   not prove.
3. Point the dashboard at the two commands above.

## Rollback

The change is additive and gated on `MCL_CLOUDFLARE_BUILD`. Reverting the commit removes
`wrangler.jsonc`, `open-next.config.ts`, `cloudflare/`, the bundle check, the CI job and the four
npm scripts, and restores `next.config.ts`. Nothing in `src/`, `db/`, the VPS runbook or the running
VPS container is touched, so there is no VPS rollback step.

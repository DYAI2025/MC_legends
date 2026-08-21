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

There are **three** places holding these commands, not one, and Workers Builds runs the *trigger's*
copy — so changing only the production settings in the UI leaves pull-request builds failing.
Read back from the API on 2026-08-21:

| Where | Build command | Deploy command |
| --- | --- | --- |
| Production settings | `npm run build:cloudflare` | `npm run deploy:cloudflare` |
| Trigger, `branch_includes: ["main"]` | `npm run build:cloudflare` | `npm run deploy:cloudflare` |
| Trigger, `branch_excludes: ["main"]` | `npm run build:cloudflare` | `npx wrangler versions upload` |

The non-production trigger keeps `versions upload` on purpose: it uploads a version **without**
making it live, which is what a pull request should do. Only the `main` trigger deploys.

### What was actually wrong, measured

Build `b5e49933-3c2d-425e-bdd3-f50f00bc6c0c` (2026-08-20 19:46, commit `6894c47`) is the whole
story in two log lines:

```text
Executing user build command: npm run build          <- plain Next, no .open-next/
Executing user deploy command: npx wrangler versions upload
✘ [ERROR] The directory specified by the "assets.directory" field in your configuration file
  does not exist:  /opt/buildhome/repo/.open-next/assets
```

Nothing else in that build was wrong. It detected `npm@11.17.0, nodejs@24.18.1` from `.nvmrc`,
`npm clean-install` added 687 packages with 0 vulnerabilities, and `next build` finished with all
ten routes. The build environment is healthy; it was simply running the wrong script, so the
directory `wrangler.jsonc` points `assets.directory` at was never produced.

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

Measured on 2026-08-21 at `6894c47`, on macOS with Node 24.18.1, with all three `AVALORIA_*`
canaries exported **in the same shell for both commands** — which is what makes the scan
non-vacuous, since it drops unset names and still reports ok:

```text
$ npm run build:cloudflare
Worker saved in `.open-next/worker.js` 🚀
OpenNext build complete.                                  # exit 0
$ ls .open-next/assets | wc -l                            # 15 files
$ npm run check:cloudflare-bundle
cloudflare-bundle: ok (1176 files, 15 assets, 5 stub marker hit(s), 3 secret(s) scanned)
```

So the repository half of this ticket is proven: the build produces the directory
`wrangler.jsonc` asks for, `pg` is absent from the worker bundle, the fail-closed stubs are
present in it, and none of the three secrets reached it. GitHub CI agrees — `verify` and
`cloudflare-build` are both green on this head. What remains is entirely outside the repository.

## Configuration

- `wrangler.jsonc` — `main` is `cloudflare/worker.ts`, assets come from `.open-next/assets`,
  `nodejs_compat` is required by the OpenNext runtime. `vars.MCL_API_ORIGIN` is the VPS API base
  URL: a public hostname, not a secret.
- `open-next.config.ts` — `defineCloudflareConfig()` with no argument, which defaults every cache
  override to `dummy`. No R2 bucket, no Durable Object and no service binding is required.

No `AVALORIA_*` value belongs in either file, or in any other committed file. The family and admin
codes stay on the VPS, because that is where the API lives.

## Before the first deploy

1. Create the Worker and set its name to match `wrangler.jsonc` (`mc-legends`). Done — script tag
   `53b2d3393eec49d1b616e04181cd504d`. As of 2026-08-21 it still reports
   `last_deployed_from: "dash_template"` and `has_assets: false`, i.e. no real build has ever
   reached it.
2. Confirm `https://srv1308064.hstgr.cloud:8443` serves the API with a certificate the Worker
   accepts. This has not been verified from CI; it is the one runtime prerequisite this change does
   not prove. A `curl` from a laptop is not evidence — it uses the OS trust store, not workerd's.
3. Set all three command pairs in the table above.

### Setting them from the API instead of the UI

Needs a token with **Workers Builds : Edit** (an OAuth session scoped to read will return
`10000: Authentication error` on the PATCH while every GET still succeeds — observed 2026-08-21).

```bash
CF_ACCOUNT=5df20b674aaad543029ca9d3f9985fa6
SCRIPT_TAG=53b2d3393eec49d1b616e04181cd504d
MAIN_TRIGGER=a53580ef-8eb4-4d54-8991-cc6d7d7b6f26      # branch_includes: ["main"]
PREVIEW_TRIGGER=0dca07c9-20f3-4afa-91be-2234410c861e   # branch_excludes: ["main"]

curl -sS -X PATCH "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/builds/workers/$SCRIPT_TAG" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' \
  -d '{"production_settings":{"build_command":"npm run build:cloudflare","deploy_command":"npm run deploy:cloudflare"}}'

curl -sS -X PATCH "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/builds/triggers/$MAIN_TRIGGER" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' \
  -d '{"build_command":"npm run build:cloudflare","deploy_command":"npm run deploy:cloudflare"}'

curl -sS -X PATCH "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/builds/triggers/$PREVIEW_TRIGGER" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' \
  -d '{"build_command":"npm run build:cloudflare","deploy_command":"npx wrangler versions upload"}'
```

Read it back before believing it — the settings page and the trigger are different records:

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/builds/workers/$SCRIPT_TAG/triggers" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq '.result[] | {trigger_name, branch_includes, branch_excludes, build_command, deploy_command}'
```

To revert to exactly what was there before, set every `build_command` back to `npm run build`, the
production settings and `main` trigger `deploy_command` back to `npx wrangler deploy`, and the
preview trigger's back to `npx wrangler versions upload`.

## Rollback

The change is additive and gated on `MCL_CLOUDFLARE_BUILD`. Reverting the commit removes
`wrangler.jsonc`, `open-next.config.ts`, `cloudflare/`, the bundle check, the CI job and the four
npm scripts, and restores `next.config.ts`. Nothing in `src/`, `db/`, the VPS runbook or the running
VPS container is touched, so there is no VPS rollback step.

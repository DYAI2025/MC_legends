# MCL-64 — Family MVP go-live on the VPS under Coolify

Baseline SHA (canonical `origin/main`, verified 2026-08-23): `4a7dac007653f67dc558bf1efb849e6ce9b6ffe4`
Target host: `srv1308064.hstgr.cloud` · Control plane: Coolify 4.3.9 (already installed)

## Goal

A protected Family MVP that a child and an adult can actually use over HTTPS against the
real VPS runtime: sign in, see the active question, send a typed answer and a recorded
answer, both acknowledged by a real server receipt; an adult signs in with a *different*
credential, reads the text, plays the original recording, closes the question, and the
child is shown the next one. Text rows, audio metadata, the recordings themselves and the
lifecycle history survive a container restart and a Coolify redeploy.

## Non-goals

- MCL-65 (recurring automated off-VPS backup). This slice only *verifies* that the
  existing backup/restore mechanism works against the current schema. No scheduler.
- Cloudflare Workers / OpenNext / Fly.io. `fly.toml` stays in the repo, inert.
- DNS changes. `mclegends.dyai.cloud` has no A/AAAA record and will not get one here.
- Moving MCL onto port 443. That vhost belongs to an unrelated service (`127.0.0.1:3131`).
- Touching any unrelated container, database, volume or vhost on this shared host.

## Preconditions (verified read-only, 2026-08-23)

| Area | Observed |
|---|---|
| `origin/main` | `4a7dac0…` — equals the expected start SHA. No open PRs. |
| OS | Ubuntu 25.10, x86_64, up 30 days |
| Disk `/` | 96 G, 72 G used, **25 G free (75 %)** |
| Memory | 7.8 Gi total, ~2.3 Gi available, swap 2.0 Gi **fully consumed** |
| Load | 9–15 (from unrelated `openclaw`/`ollama`) |
| Docker | 29.4.2; 9 containers, all running; 6 volumes (3 unused, **not ours, not to be touched**) |
| Coolify | 4.3.9 healthy on `0.0.0.0:8082→8080`; `coolify-db` (pg15), `coolify-redis`, `coolify-realtime`. **Zero projects, zero applications.** One user, team `0` "Root Team", server `0` `localhost`. **No Traefik/Caddy proxy container running.** |
| nginx | 1.28.0 owns `:80`, `:443`, `:8443`, `:8088`. `sites-available/mc-legends` = `listen 8443 ssl`, `server_name srv1308064.hstgr.cloud`, LE cert, `proxy_pass 127.0.0.1:3010`, `X-Forwarded-Proto https` hard-coded, **no `client_max_body_size`** (⇒ nginx default 1 MiB). `sites-available/mclegends.dyai.cloud` = `listen 80`, same upstream, `X-Forwarded-Proto $scheme`. |
| ufw | default deny in; allows 22, 80, 443, **8443**, 8082, 8088, 3003, 10272, 8001. 5432 allowed from nowhere. |
| PostgreSQL | host 17.10, `listen_addresses=localhost`, socket `/var/run/postgresql`, port 5432. DBs `gbrain`, `mcl`, `mcl_review`, `postgres`. Login roles `gbrain`, `mcl_app`, `postgres`. |
| `mcl` schema | **only `0001_submission_inbox` applied.** Tables: `schema_migrations`, `submission_inbox`. **1 real text row** — production data, must survive. |
| MCL runtime | hand-started container `mc-legends`, image `mc-legends:a0d357a` (ancestor of main), `127.0.0.1:3010→3000`, binds `/opt/mc-legends/data:/data` and `/var/run/postgresql`. Env keys: `NODE_ENV PORT AVALORIA_FAMILY_ACCESS_CODE AVALORIA_ADMIN_ACCESS_CODE AVALORIA_SESSION_SECRET DATABASE_URL AVALORIA_INBOX_DIR`. **No `AVALORIA_MEDIA_DIR`** ⇒ recordings would land in the container's writable layer. Second container `mc-legends-review` on `:3011`. |
| Host paths | `/opt/mc-legends/{Dockerfile,app.env(0600),data/,src-checkout/}`; `data/inbox/`, `data/media/` (exists, **empty**), mode `0700 root:root`. |
| Reachability | `https://srv1308064.hstgr.cloud:8443/api/health` → `200`; `/api/health/ready` → `{"app":"ok","database":"ok"}`. IPv6 does not connect. `mclegends.dyai.cloud` does **not** resolve, **but** `curl -H 'Host: mclegends.dyai.cloud' http://76.13.130.224/api/health` → `200` — the plain-HTTP path to the app is live by IP + Host header. |

### Known gaps this plan must close

1. **MCL-61.** A productively reachable plain-HTTP route serves the whole app, including
   `POST /api/family/session` and `/api/admin/session`, with `X-Forwarded-Proto: http` —
   so the session cookies are issued **without `Secure`**.
2. Migrations `0002` (audio) and `0003` (question lifecycle) are **not applied** to `mcl`.
3. `AVALORIA_MEDIA_DIR` is unset in the running container — audio would not persist.
4. nginx on `:8443` has no `client_max_body_size`, so the 1 MiB default rejects almost
   every recording before the app sees it (product ceiling is 8 MiB).
5. Deployment is a hand-started container with no automation — the thing MCL-64 replaces.

## Ingress topology decision (authoritative)

```
Internet :8443/tcp → nginx (TLS, Let's Encrypt, X-Forwarded-Proto https)
                   → 127.0.0.1:3020 → Coolify-managed container :3000
```

Coolify's own proxy stays **off**. No Traefik container runs today and nginx already owns
80/443/8443 for nine unrelated vhosts; letting Coolify seize those ports would take down
unrelated production services. Coolify therefore manages build/deploy/lifecycle only, and
publishes a **loopback-bound** port mapping that nginx fronts. One proxy hop, no chain.

New port `3020` rather than reusing `3010`: the old container keeps serving until the new
one is proven, and stays available (stopped, not deleted) as the rollback.

## Task list

Each task states the evidence that closes it. `PASS` / `FAIL` / `not_run: <reason>` / `BLOCKED`.

### T1 — Backup before any mutation
- **Files/systems:** VPS `/opt/mc-legends/backups/`, local `~/Backups/mc-legends`
- **Do:** `pg_dump --format=custom mcl`, `pg_restore --list` TOC, SHA-256 manifest of
  `data/media`, tar of media. Pull the set to the MacBook with `scripts/backup-mc-legends.sh`.
- **Evidence:** dump file size > 0; TOC lists `submission_inbox`; local copy exists.

### T2 — Apply migrations 0002 and 0003 to `mcl`
- **Files:** `db/migrations/0002_submission_audio.sql`, `0003_question_lifecycle.sql`,
  `scripts/migrate.mjs`
- **Risk:** `0002` mutates `submission_inbox` (drops `NOT NULL` on `original_text`, adds a
  `kind_shape` CHECK). The single existing row is `kind='text'` with `original_text` set and
  all `media_*` NULL ⇒ satisfies the new constraint. Additive for `0003`.
- **Evidence:** `schema_migrations` holds exactly `0001,0002,0003`; second run reports no
  pending migration; `submission_inbox` row count unchanged (1); `question_lifecycle_event`
  exists.

### T3 — Mint a Coolify API token
- **Do:** Laravel Sanctum token for user `0` via `php artisan` inside the `coolify` container.
- **Evidence:** `GET /api/v1/servers` returns the `localhost` server. Token value never printed.

### T4 — Create the Coolify project / environment / application
- **Config:** public repo `https://github.com/DYAI2025/MC_legends`, branch `main`,
  build pack `dockerfile`, `ports_exposes=3000`, `ports_mappings=127.0.0.1:3020:3000`,
  no FQDN, proxy disabled, health check `/api/health`.
- **Evidence:** application UUID returned; `git_commit_sha` after deploy = `4a7dac0…`.

### T5 — Environment variables
- **Do:** copy the seven existing values out of `/opt/mc-legends/app.env` **server-side**
  into Coolify without rendering them; add `AVALORIA_MEDIA_DIR=/data/media`,
  `AVALORIA_INBOX_DIR=/data/inbox`, `AVALORIA_QUESTION_DIR=/data/questions`.
- **Evidence:** variable **names** listed from `docker inspect`; family and admin codes
  differ (proved by the admin gate not failing closed, not by comparing values).

### T6 — Persistent storage
- **Do:** bind mounts `/opt/mc-legends/data → /data` and `/var/run/postgresql → /var/run/postgresql`.
- **Evidence:** `docker inspect .Mounts` on the Coolify container shows both.

### T7–T8 — Deploy and smoke-test on loopback
- **Evidence:** container `Up`; `curl 127.0.0.1:3020/api/health` → 200;
  `/api/health/ready` → `{"app":"ok","database":"ok"}`.

### T9 — nginx: upload ceiling + upstream cutover
- **Files:** `/etc/nginx/sites-available/mc-legends`
- **Do:** add `client_max_body_size 12M;`, repoint `proxy_pass` to `127.0.0.1:3020`.
- **Evidence:** `nginx -t` ok; public `https://…:8443/api/health` → 200 served by the new
  container (correlate with container logs).

### T10 — MCL-61: close the plain-HTTP login path
- **Files:** `/etc/nginx/sites-available/mclegends.dyai.cloud`
- **Do:** replace the proxy with `return 301 https://srv1308064.hstgr.cloud:8443$request_uri;`.
  DNS-safe: the name resolves nowhere, so no user is affected; the change removes the
  reachable-by-IP insecure route. No other vhost is touched.
- **Evidence:** `curl -H 'Host: mclegends.dyai.cloud' http://<ip>/api/family/session` no
  longer reaches the app; family + admin `set-cookie` on `:8443` carry `Secure`.

### T11 — Real runtime acceptance (synthetic content only)
Run **from the VPS shell** against the public HTTPS URL so the codes never leave the host.
health · readiness · family login · wrong-credential rejection · active question ·
text receipt + DB identity · audio receipt + media file + DB metadata · admin login ·
admin text read · protected audio playback · close · rotate · archive · reopen without
focus steal · oversize rejection · duplicate/retry idempotence.

### T12 — Persistence proofs
Record identifiers first, then **(A)** Coolify restart, **(B)** Coolify redeploy; re-verify
rows, media file + SHA-256, lifecycle history, and that login/admin/playback still work.

### T13 — Backup/restore drill into an isolated target
Restore the T1+post-acceptance dump into a **scratch** database (`mcl_restore_drill`), never
over `mcl`. Verify `schema_migrations` = 0001–0003, required tables, synthetic identifiers,
media manifest digests, and reference→file consistency.

### T14 — Rollback
Document (and where non-destructive, verify) the path back: repoint nginx to `:3010` and
start the retained `mc-legends` container. No rollback step deletes rows, media or history.

### T15 — Retire the old runtime safely
`docker stop mc-legends` only **after** acceptance passes. Container and image retained.

## Risks and rollback notes

| Risk | Mitigation |
|---|---|
| Docker build OOMs (2.3 Gi free, swap exhausted, load 9–15) | Build is the same Next.js build the host has already produced before. If it fails, retry; do not kill unrelated processes to make room. |
| Disk exhaustion during build (25 G free) | Monitor `df` around the build. Only build/image cache may be reclaimed, and only if unreferenced. **No volume pruning** — 1.16 GB of unused volumes belong to other projects. |
| Migration `0002` rejects the existing row | Pre-checked: the row satisfies `kind_shape`. T1's dump is taken first regardless. |
| Two app containers writing the same DB during cutover | Safe: appends are idempotent on `submission_id`; the old image never writes `media_*`. Old container is stopped right after cutover. |
| nginx edit breaks an unrelated vhost | Only the two MCL vhost files are touched; `nginx -t` before every reload; originals copied to `.bak-mcl64` first. |
| Coolify redeploy wipes recordings | Exactly what T5/T6 prevent, and what T12-B proves. |

## Out of scope, handed to MCL-65

Scheduling the pull off-VPS, retention/pruning policy, restore rehearsal cadence, and
alerting on a failed backup run.

---

# Execution record (2026-08-23)

## Discovery corrections to the preconditions table above

- **8443 IS allowed by ufw** (rules 21 / 40). An earlier read truncated the rule list at 25
  lines and appeared to show it missing. `https://srv1308064.hstgr.cloud:8443` is publicly
  reachable over IPv4 and is the live MCL URL. IPv6 does not connect.
- **Docker's published ports bypass ufw on this host.** Measured: `ufw` holds
  `8080/tcp DENY IN` while `http://76.13.130.224:8080/` answers `200` (lpam-frontend).
  This is why the MCL port needed a `DOCKER-USER` rule rather than a ufw rule.
- Coolify self-upgraded 4.3.9 → 4.3.10 the moment its server record became reachable, and
  left its own container `Created` with no network and no port. Recovered by persisting
  `APP_PORT=8082` (never in `.env`; the original binding came from a one-off shell export)
  and re-running its compose. No unrelated service was affected at any point.

## Results

| Task | Result | Evidence |
|---|---|---|
| T1 backup before mutation | **PASS** | `mcl-pre-mcl64-20260822T235628Z.dump` 9463 B + TOC + media manifest; pulled to `~/Backups/mc-legends/mcl64-pre/` |
| T2 migrations 0002/0003 | **PASS** | `applied 2 migration(s)`; second run `no pending migrations`; `schema_migrations` = 0001,0002,0003; the pre-existing text row survived (count still 1) |
| T3 Coolify API token | **PASS** | Sanctum token with `team_id=0`; API enabled instance-wide (`is_api_enabled` was `f`) |
| T4 project/app created | **PASS** | project `xrotkpgwiolunb1mvmm0sdhi`, app `fafiugw3i1cxv5nvdmuiiryq` (`mcl-family`) |
| T5 env | **PASS** | 10 production variables; secret values copied server-side, never rendered |
| T6 bind mounts | **PASS** | `/opt/mc-legends/data → /data`, `/var/run/postgresql → /var/run/postgresql` |
| T9 nginx 12M ceiling | **PASS** | `client_max_body_size 12M` added to the 8443 vhost; `nginx -t` ok |
| T10 **MCL-61** | **PASS** | see below |

### MCL-61 — the finding and the fix

Before, against the real host by IP with `Host: mclegends.dyai.cloud`:

| route | status | cookie |
|---|---|---|
| `POST /api/family/session` over **HTTP** | 200 | `avaloria_family_session=…; HttpOnly; SameSite=Strict` — **no `Secure`** |
| `POST /api/admin/session` over **HTTP** | 200 | `avaloria_admin_session=…; HttpOnly; SameSite=Strict` — **no `Secure`** |
| same two over **HTTPS :8443** | 200 | … `Secure` present |
| wrong credential over HTTPS | 401 | — |

After replacing that vhost with a 301 to the canonical HTTPS URL: every plain-HTTP request
(`/`, `/api/family/session`, `/api/admin/session`) answers `301` with **no `set-cookie`**,
HTTPS still answers 200, and `gbrain`/`media`/`stars`/`bazodiac` all still answer 200.

### Repository changes (two PRs, both merged)

- **#35** `fix(MCL-64): declare a health probe the image can actually run` — head `761c231`,
  CI success, merged as `c7365bc`, post-merge CI success. `node:24-slim` has neither `curl`
  nor `wget`, so Coolify's injected probe failed 6/6 while the app served 200s and the first
  deployment ended `failed` with the container `Up (unhealthy)`.
- **#36** `fix(MCL-64): drop the syntax directive that blocks a secret-safe build` — head
  `f07bcb4`. Coolify prepends its own `# syntax=` when build secrets are on; two directives
  are a hard BuildKit error. Build secrets matter because without them Coolify passes every
  variable as an `ARG` and the session secret plus both access codes end up in
  `docker history`.

### Security findings for the human

1. **`AVALORIA_FAMILY_ACCESS_CODE` and `AVALORIA_ADMIN_ACCESS_CODE` are 4 characters long.**
   Measured as string length server-side; values never printed. The rate limiters slow but
   do not prevent enumeration of a 4-character space. Rotating both to long random values is
   a human action — the Coolify UI location is given in the delivery report.
2. Secrets were present in the first image's build history. Addressed by #36 + build secrets.
3. Coolify's own UI is on `0.0.0.0:8082`, world-reachable (ufw rule 18/37). Unrelated to the
   MCL data path, which stays behind nginx on 8443, but worth a decision.

### Disk

`docker builder prune -f` reclaimed 1.26 GB of **unused** build cache (0 active). Volumes,
rollback images (`mc-legends:a0d357a`, `:0acc4a6`) and all 10 containers untouched. Done
because Coolify's `force_docker_cleanup` fires at 80 % and the host sat at 78 % before a build.

## Final results

Deployed: Coolify app `mcl-family` (`fafiugw3i1cxv5nvdmuiiryq`), project `mc-legends`,
image `fafiugw3i1cxv5nvdmuiiryq:614966f215a07aac9cd8ac2d763308b03c64096f`,
`restart=unless-stopped`, URL `https://srv1308064.hstgr.cloud:8443`.

| Suite | Result |
|---|---|
| Core acceptance (health, auth, text, audio, admin, playback, oversize, static-exposure) | **31 / 31 PASS** |
| Duplicate/retry idempotence (first run) | PASS — retry answered 200 with the *original* receipt, no second row |
| Question lifecycle | **19 / 19** in substance (see note) |
| Persistence before restart | 14 / 14 |
| Persistence after Coolify **restart** | **14 / 14** |
| Persistence after Coolify **redeploy** | **14 / 14** |
| Backup / restore drill (isolated DB) | **20 / 20** |
| Off-VPS pull verified by `scripts/verify-media-archive.sh` | `ok: verified 1 file(s)`, exit 0 |

Lifecycle note: one assertion initially read as FAIL because `/api/admin/questions` returns
questions in **dataset** order, not the child's turn order. Re-measured on the child page:
after reopening, the render order is `druhen-protection` (active), `dragon-path`,
`behind-the-wall`, `amulet-power`, **`companion-animal` last** — the reopened question does
go behind the ones that never left, and it did not steal focus. Product correct, assertion wrong.

### T14 rollback — verified non-destructively

- **Path A** (pre-Coolify): `docker start mc-legends` → served `{"app":"ok","database":"ok"}`
  on `127.0.0.1:3010`; stopped again, nginx left on 3020. Container and image
  `mc-legends:a0d357a` are retained, not deleted.
- **Path B** (Coolify): two rollback images available — `614966f…` and `4a7dac0…`.
- After the rehearsal: 3 submission rows, 2 lifecycle events, 1 media file — unchanged.
  No rollback path deletes rows, media or history; they all share the same durable
  database and bind mount.

### Residual risk recorded honestly

The `DOCKER-USER` rule that keeps port 3020 private lives in `/etc/ufw/after.rules`, and
`ufw`/`docker` are both `enabled` at boot. A ufw **reload** was proven to reinstate it
exactly once. A full **reboot** and a **docker daemon restart** were NOT exercised — doing
either would have disturbed nine unrelated containers — so the ordering between
`docker.service` publishing the port and `ufw.service` applying `after.rules` at boot is
untested. Check `iptables -S DOCKER-USER | grep 3020` after the next reboot.

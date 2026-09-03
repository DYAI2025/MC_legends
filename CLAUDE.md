# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` first — it is the repository-wide operating contract (source-of-truth order, non-negotiable product rules, delivery rules, required checks). This file adds what you need to be productive in the code; it does not repeat those rules.

## Toolchain

Node `24.18.1` via `.nvmrc`; `engines` enforces `>=24.18.1 <25` / npm `>=11.16.0 <12` strictly (`engine-strict=true` in `.npmrc`): `source ~/.nvm/nvm.sh && nvm use` before any npm command. Next.js 16 App Router, React 19, TypeScript 6, Vitest 4, Playwright 1.62, `pg` 8. `@/*` → `src/*`.

## Commands

```bash
npm run dev                      # needs AVALORIA_FAMILY_ACCESS_CODE (+ AVALORIA_ADMIN_ACCESS_CODE for /admin) in .env — gates fail closed without them
npm run verify                   # check:foundation && check:secrets && lint && typecheck && test && build
npm run test                     # vitest: tests/**/*.test.ts = unit + architecture + integration (integration self-skips without MCL_TEST_DATABASE_URL)
npm run test:architecture        # only tests/architecture/boundaries.test.ts
npx vitest run tests/unit/deliver-submission.test.ts            # one file
npx vitest run tests/unit/inbox-route.test.ts -t "duplicate"    # one case by name substring
npm run test:e2e                 # playwright; starts its own dev server with the test codes from tests/support/*-access-code.ts
rm -rf .data && E2E_PORT=3199 npx playwright test               # preferred local form: clean file inbox, port nobody else holds
npx playwright test tests/e2e/world-detail.spec.ts -g "back"    # one spec / one test
npm run build && CI=1 npm run test:e2e                          # CI-equivalent: production server, no server reuse, 2 retries
```

PostgreSQL path (mirrors CI; needs a reachable DB and a *dedicated* test database — the suite `TRUNCATE`s it):

```bash
export MCL_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcl_test
DATABASE_URL="$MCL_TEST_DATABASE_URL" npm run db:migrate   # migrate.mjs reads DATABASE_URL, not MCL_TEST_DATABASE_URL
npm run test && npm run check:integration-ran               # second command FAILS if the integration suites skipped
```

Client-bundle secret scan (AGENTS.md: after the build, same `AVALORIA_*` values). What the script can and cannot check: it refuses only when *no* secret is set, a set one is < 8 chars, or `.next` is missing; unset names are silently dropped from the scan, and a value that differs from the build's passes vacuously — so set all three, identically, in one shell:

```bash
AVALORIA_FAMILY_ACCESS_CODE=… AVALORIA_SESSION_SECRET=… AVALORIA_ADMIN_ACCESS_CODE=… npm run build
AVALORIA_FAMILY_ACCESS_CODE=… AVALORIA_SESSION_SECRET=… AVALORIA_ADMIN_ACCESS_CODE=… npm run check:client-secrets
```

Command traps:

- **An exported `DATABASE_URL` in your shell flips the whole app — and the unit suite, and the Playwright dev server — to PostgreSQL.** The composition root selects Postgres whenever it is non-blank. Integration suites are gated by the *different* variable `MCL_TEST_DATABASE_URL` for exactly this reason. Keep `DATABASE_URL` unset locally unless you mean it.
- Green `npm run test` proves nothing about the Postgres adapter unless `check:integration-ran` also passed.
- Playwright locally has `reuseExistingServer: true`: a dev server already on port 3000 is reused *without* the test codes/raised rate limits, and every sign-in helper then fails with "the test server must accept the family code from playwright.config.ts". Stop that server or use `E2E_PORT`.
- `npm run check:foundation` reads a hard-coded list of 52 required paths (`scripts/check-foundation.mjs`) — renaming/moving a listed file fails it; a new load-bearing file is expected to be appended there. It also scans every `.md/.ts/.json/...` in the repo (this file included; exempt by substring match: `AGENTS.md`, `docs/architecture`, `tests/e2e`, and the script itself) for two of the franchise names AGENTS.md forbids (the bare one-word variant is not scanned — still never write it) — refer to them indirectly, never literally.

## Architecture — how the pieces actually fit

Layered monolith, dependency direction only downward; enforced by `tests/architecture/boundaries.test.ts` (regex scans of source, not lint):

```text
src/domain        submission.ts only. LOCAL_ONLY → SERVER_ACKNOWLEDGED, receipt required; deps (createId, now) injected
src/application   ports (interfaces) + use cases (plain async functions taking ports); no next, no adapters
src/adapters      access (HMAC gate, in-memory rate limiter) · http (guards, cookies, bounded JSON body, browser clients) · persistence (indexeddb, file JSONL, postgres)
src/composition   browser.ts (HTTP clients + IndexedDB) / server.ts (gates, stores, limiters) — the ONLY module in src that reads process.env
src/content       framework-free SSoT dataset: ideas, categories, open questions, truth→child status mapping, child-unsafe vocabulary; may not import next/react/adapters/app
src/app           Next delivery: pages, route handlers, 4 client components, total message tables
```

**Submission data flow (child side).** `FamilyExperience` (client) → `submitText` (domain create + `SubmissionRepository.save` → IndexedDB, status `LOCAL_ONLY`) → `deliverSubmission` (`SubmissionInbox.deliver` → `HttpSubmissionInbox` POST `/api/inbox/submissions` → server mints receipt → domain `acknowledgeSubmission` → save). `deliverSubmission` never throws; it returns `DeliveryOutcome` with reason `transport | refused | local-save`. A non-`SubmissionInboxError` throw is classified `transport` (retryable) — a new inbox adapter must throw `SubmissionInboxError("refused")` for permanent failures or the child-facing message (`childMessageFor`) invites a retry that can never succeed. Within `src` the literal `SERVER_ACKNOWLEDGED` may exist only in `src/domain/submissions/submission.ts` (tests may name it); everywhere else in `src` use `hasArrivedInProject()` / `submissionStatusLabel()`. Original text is stored untrimmed, byte-for-byte (validated trimmed, stored raw); receipt fields are trimmed.

**Server side has no use-case layer on purpose.** `POST /api/inbox/submissions` guards from headers first (`guardFamilyRequest`: cookie → gate → rate limit), then `readBoundedJson` (16 KiB), validates (refuses NUL, lone surrogates, years outside 1..9999 — never sanitises), then `SubmissionInboxStore.appendIfAbsent`. `{stored:false, existing}` is the idempotent-retry path → 200 with the *original* receipt; fresh append → 201. `SubmissionPayloadError` → 400; any other store throw → 503. Do not extract a use case without a second caller.

**Write port vs read port, one adapter class.** `SubmissionInboxStore` (write, `InboxRecord`, no status) and `SubmissionInboxReader` (read, `InboxEntry` with status `RECEIVED`, `MAX_INBOX_PAGE_SIZE = 200`) are deliberately separate ports; `FileSubmissionInboxStore` and `PostgresSubmissionInboxStore` each implement both. `server.ts` selects the store with one rule used for both sides: `DATABASE_URL?.trim() || null` → Postgres, else file store at `AVALORIA_INBOX_DIR?.trim() || ".data/inbox"` (`||`, never `??`: blank means unset). The file branch is MCL-48's rollback path — not dead code. Both adapters are proven by the shared contract suites `tests/unit/*-contract.ts` (`describeSubmissionInboxStoreContract` / `...ReaderContract`), run against the file adapter in unit tests and against real Postgres in `tests/integration/`.

**Access: two identities, one mechanism, one shared signing secret.** `HmacFamilyAccessGate` (stateless HMAC session token `v1.<exp>.<nonce>.<sig>`, 30-day TTL, code compared as HMACs) is instantiated twice by `server.ts`: family gate from `AVALORIA_FAMILY_ACCESS_CODE` (children write), admin gate from `AVALORIA_ADMIN_ACCESS_CODE` (adults read); both mix in optional `AVALORIA_SESSION_SECRET`. Missing/blank code ⇒ gate answers `unavailable` ⇒ 503 from every API route (pages just render the sign-in panel) — fail closed. Equal admin and family codes ⇒ tokens interchangeable ⇒ `createAdminAccessGate` refuses: fixed log string, admin surface fails closed, family keeps working. Cookies: `avaloria_family_session` / `avaloria_admin_session`, HttpOnly, SameSite=Strict, `Secure` only when `x-forwarded-proto`/URL says https. Guards are *siblings, not parameterised* (`guardFamilyRequest` / `guardAdminRequest`, `/api/family/session` / `/api/admin/session`) so no call site can pick the wrong identity. Gate outcomes are three-way (`granted | denied | unavailable`); the guards return `ProtectedRequestOutcome` = `granted | unauthorized | rate-limited | unavailable` (`denied` becomes `unauthorized` there) — `unavailable` (misconfiguration) is never folded into `denied`/`unauthorized`.

**Rate limiters are process singletons; gates and stores are per-request.** Six lazily-created `InMemoryRateLimiter`s in `server.ts` (inbox 30, family session 20 per address + 60 global constant-key, admin route 60, admin session 20 + 30 global; all per 60 s, overridable via `AVALORIA_*_RATE_LIMIT` / `AVALORIA_*_RATE_WINDOW_MS`). Per-address keys use spoofable `x-forwarded-for`; only the constant-key global limiters are a real ceiling. Tests call `resetRateLimitersForTest()`. AGENTS.md forbids describing limiter or file-store idempotency as distributed/production-grade — both are process-local.

**Pages and routes.** Child surface: `/` (`HomePage` server component reads the family cookie → boolean + `?thema=` filter → `FamilyExperience`), `/welt/[id]` (server-rendered idea detail, `notFound()` for unknown id, back link `overviewRoute(filter, id)`). Admin surface: `/admin` (`force-dynamic`, swaps `AdminAccessGate`/`AdminInboxView`), `GET /api/admin/inbox/submissions` (refuses — 400 — rather than clamps: unknown status/kind, blank questionId, `limit` outside 1..200, empty `status=`; the client omits unset filters). `GET /api/health` is liveness and must stay 200 with the DB down; `GET /api/health/ready` (`force-dynamic`) reports `database: ok | not-configured | unavailable`, 503 only on `unavailable`. Server components decide what to render from the cookie; after a granted sign-in the client calls `router.refresh()`. The API routes are the access boundary, the page render is not.

**MCL-47 world addressing lives in `src/content`, typed once in `src/app/world-routes.ts`.** Idea ids are stable slugs; `ideaAnchorId(id)` = `idee-<id>`; category slugs are a total table; query param `THEMA_PARAM = "thema"`; `overviewHref` yields `/?thema=<slug>#idee-<id>` with "Alle Ideen" deliberately absent from the URL; `ideaDetailHref` yields `/welt/<id>?thema=<slug>`; unknown slug falls back to all, never errors. Because `src/content` may not import `next`, widening to `typedRoutes`' `Route` happens only in `world-routes.ts` — no `as Route` casts in components. Category selection is URL state (`router.replace(..., {scroll:false})`), not local state. `focusQuestion()` throws at module load of `family-experience.tsx` unless exactly one open question has `focus: true`. `IdeaEmblem` is a deterministic abstract voxel SVG per id — blocks only, no lore, per `docs/image-negative-list.md`.

**Truth vocabulary.** Internal `TruthStatus` (`STATED|TENTATIVE|AMBIGUOUS|CONFLICT|OPEN`) maps via `childStatusFor` to `ChildStatus` (`in-world|idea|open`; the fourth member `tryout` sits in the legend/palette tables but no `TruthStatus` produces it); only a server receipt may make a submission read as arrived, and submissions never wear the idea legend's `status-*` classes. Every child-facing string (datasets, message tables, e2e page text) is checked with `expectChildSafe` from `tests/support/child-safe.ts` (= `childUnsafeVocabulary` in `content-source.ts` + HTTP/500/503/fetch/Timeout/Stack, word-bounded, case-insensitive). Child copy is German; code, commits, runbooks English.

## Invariants the test suite enforces (you will hit these)

- Secrets `AVALORIA_FAMILY_ACCESS_CODE` / `AVALORIA_SESSION_SECRET` / `AVALORIA_ADMIN_ACCESS_CODE` may be *named* only in `src/composition/server.ts` — even in a comment. `NEXT_PUBLIC_` may appear nowhere in `src`.
- `src/composition/browser.ts` must not import `@/composition/server` or `node:`; must contain `/api/admin/session` and must **not** contain `/api/family/session`.
- The list of client components checked for server-root/`node:` imports is hard-coded in `boundaries.test.ts` — a new `"use client"` file must be added there or it is silently uncovered. A new secret env var must be added to `boundaries.test.ts`, `scripts/check-client-secrets.mjs`, and *both* the Build and Client-bundle-scan steps in `.github/workflows/ci.yml` (the scan drops unset names and still reports ok).
- No test file may assign `process.env = ...` (breaks `vi.stubEnv` unset semantics for every later test in the process). Use `vi.stubEnv` + `vi.unstubAllEnvs()`; add `vi.resetModules()` + dynamic `import()` when the module reads env at load; call `resetRateLimitersForTest()` when hitting routes.
- Total tables with `as const satisfies Record<Union, T>` are the pattern for every union → string/palette/slug mapping (`*-message.ts`, `categorySlugs`, `childStatusPresentations`, `emblemPalettes`, `MAX_LENGTHS`); a new union member is a compile error, never a runtime fallback.
- Route handlers answer machine-readable codes through a local `refuse(status, code)`; the caught cause (full error, stack included) goes to `console.error` under a fixed log string server-side; a response is never more than the code — no stack, path, secret, or child text reaches the client, and secrets/child text never reach a log (rate-limit keys use a truncated sha256 of the session).

## Testing conventions

- Vitest: `tests/unit`, `tests/architecture`, `tests/integration` (`*.test.ts`, node env). Playwright: `tests/e2e/*.spec.ts`, chromium only. `*-contract.ts` are reusable suites, not tests.
- Route handlers are tested in-process: `import { POST } from "@/app/api/.../route"` and call with `new Request(...)` — set `content-length` explicitly.
- Sessions in tests are minted through the real gate (`tests/support/family-session-header.ts`, `HmacFamilyAccessGate.openSession`), never hand-written tokens. E2E signs in via `signInAsFamily`/`signInAsAdmin` (`page.request.post`) except in tests about the form itself. Test codes (`TEST_FAMILY_ACCESS_CODE`, `TEST_ADMIN_ACCESS_CODE`) are invented constants in `tests/support/*-access-code.ts` (import nothing so `playwright.config.ts` can load them) and are deliberately different from each other.
- Filesystem tests use `mkdtemp` per test + `rm` in `afterEach`; the only fake-indexeddb user is `tests/unit/indexeddb-submission-repository.test.ts` (`import "fake-indexeddb/auto"` first line).
- Integration files share one gate shape: `const CONNECTION_STRING = process.env.MCL_TEST_DATABASE_URL?.trim() ?? ""; describe.skipIf(!ENABLED)`; the two that go through the composition root (store-selection, health-ready) then `vi.stubEnv("DATABASE_URL", CONNECTION_STRING)` per case, the adapter suite passes it to the constructor. Postgres pool is a module Map keyed by connection string — `closePostgresSubmissionInboxPools()` in `afterAll` or the worker holds a socket.
- Newer tests/scripts carry a prose header saying which failure they pin (some with "Measured:" evidence); older Sprint-1/2 files do not — add one to anything new. The `check:*` scripts print `<name>: ok` and refuse (throw / exit 1) rather than pass on empty input; `migrate.mjs` / `import-inbox-jsonl.mjs` report what they applied.
- Local Postgres: 15.x on 5432 holds `mcl_test`; production is 17.x (CI runs postgres:17 — the only place the production major is exercised). Do not `brew services start postgresql@17`; PG17 belongs on 5433 for restore drills only (`docs/ops/MCL-48-backup-restore.md`).

## Environment variables (all read only in `src/composition/server.ts`; documented in `.env.example`)

`AVALORIA_FAMILY_ACCESS_CODE` (required), `AVALORIA_ADMIN_ACCESS_CODE` (required for `/admin`, must differ), `AVALORIA_SESSION_SECRET` (optional, shared by both gates; rotating it or either code logs everyone out), `AVALORIA_INBOX_DIR` (default `.data/inbox`, git-ignored), `DATABASE_URL` (selects Postgres; production uses a Unix socket URL), and the `AVALORIA_{INBOX,SESSION,SESSION_GLOBAL,ADMIN,ADMIN_SESSION,ADMIN_SESSION_GLOBAL}_RATE_LIMIT/_RATE_WINDOW_MS` pairs. Blank counts as unset everywhere.

## Jira keys, branches, docs

- Jira project `MCL`; branch `feat/MCL-<n>-<slug>`; commits `type(MCL-<n>): imperative sentence` (`feat|fix|test|chore|ci|refactor`); one story per PR. Keys you will meet: MCL-1 product-format decision (docs/AGENTS only — open, blocks any loader/engine choice); in code comments: MCL-34 family access gate, MCL-47 world detail route (`/welt/[id]`), MCL-48 Postgres persistence + backup/restore, MCL-49 audio (future), MCL-50 protected admin read with separate credential.
- Plans: `docs/plans/YYYY-MM-DD-mcl-<n>-<slug>.md` — Goal / Architecture / Tech Stack / Baseline (SHA) / recorded decisions (MCL-47's are marked "do not re-litigate") / tasks with failing-test-first steps and explicit commit commands. Verification results use `PASS` / `FAIL` / `not_run: <reason>` / `BLOCKED` (stated in the 2026-08-14 plan; older plans use PASS/FAIL only). Worktree paths inside plans are point-in-time.
- Living runbooks: `docs/security/MCL-34-family-access.md` (auth model, honest limits), `docs/deploy/vps-mc-legends.md` (single hand-started Docker container on the VPS, nginx → 127.0.0.1:3010, migrations run *inside* the container via `docker exec mc-legends npm run db:migrate` because host Node is v22, verify the deployed artefact via both health endpoints + one real submission + restart), `docs/ops/MCL-48-backup-restore.md` (pull backups from the MacBook, manual, drills into scratch DBs — never over `mcl`; every drill gets a row).
- Snapshots, not current truth: `README.md` (still says only one env var, no lockfile, Next 16.2, page is a shell), `docs/architecture/*` (2026-08-11 bootstrap generator output — `VALIDATION.md`, `C4.md`, the `.json` files; four of the JSONs are required by `check:foundation`), `docs/project/JIRA_BASELINE_2026-08-11.md`, `SECURITY.md` ("does not yet implement authentication"). Parts of `MCL-34-family-access.md` predate MCL-48/50 (says no Postgres credential, no read path). When a doc and the code disagree, the code and tests win; say so in the handoff rather than silently trusting either.

## Handoff rule

Every handoff must separate:

- observed/implemented facts,
- Jira-planned behavior,
- assumptions,
- blockers/not-run validation.

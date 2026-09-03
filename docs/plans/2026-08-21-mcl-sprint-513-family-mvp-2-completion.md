# Sprint 513 "Family MVP 2" Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the sprint goal of MCL Sprint 2 (board 370, sprint id 513) demonstrably true for **audio as well as text** — a child records an answer, sends it, and is told "Im Projekt angekommen" only after the original audio is durably stored in private server-side storage; an authorised adult can find, understand and *listen to* that answer; and an adult can close a question so the next one rotates into the child's view.

**Architecture:** Three vertical slices on the existing layered monolith (`domain → application → adapters → composition → app`), each one Jira story, each its own branch and PR:

1. **MCL-49** — a new `AudioArtifactStore` / `AudioArtifactReader` port pair with a private filesystem adapter (content-addressed, `0600`, outside the web root), the `InboxRecord`/`InboxEntry` `kind` union widened from `"text"` to `"text" | "audio"`, migration `0002` adding audio metadata columns under a payload CHECK constraint, a family-gated raw-bytes upload route, an admin-gated playback route, and readiness reporting storage writability.
2. **MCL-30B** — the browser send path: `AudioSubmissionInbox` port + HTTP adapter, local blob persistence in IndexedDB so a failed send survives a reload, `deliverAudioSubmission` use case, and the send/retry UI on the existing MCL-30A recorder.
3. **MCL-35** — a `QuestionStateStore` / `QuestionStateReader` port pair (file + PostgreSQL adapters, one shared contract suite), migration `0003`, an admin-gated question lifecycle route, an admin questions surface, and a server-side projection that turns the compile-time question catalogue plus the durable closed-set into "the one active question" for the child view.

The compile-time question catalogue in `src/content/open-questions.ts` stays the only source of question *wording*. Lifecycle state is an **overlay**, never an edit to the dataset — that is what keeps "no invented content" intact and keeps the existing dataset invariants (≥3 open questions, one uncovered category) unbroken.

**Tech Stack:** Node 24.18.1, Next.js 16.3 App Router, React 19, TypeScript 6, Vitest 4, Playwright 1.62, `pg` 8, PostgreSQL 17 (CI) / 15.18 (local), `node:crypto` for SHA-256, `node:fs/promises` for the artifact store. No new runtime dependency.

---

## Baseline — measured, not assumed

Measured on **2026-08-21** in `/Users/benjaminpoersch/Projects/MC_legends` on branch `main`:

| Fact | Value | How it was measured |
|---|---|---|
| Base SHA | `108441783052d1695b636579004677d0c85cb04b` (`1084417`) | `git log --oneline -1` |
| Confluence's "kanonischer GitHub-Head" | same SHA | MLOA page 09, page 13 |
| `npm run verify` | **PASS** (exit 0) | full run, 29 files / 365 tests passed, 4 files / 23 tests skipped (no DB), `next build` green |
| Unit+integration with PostgreSQL | **PASS** — 33 files / 404 tests, 0 skipped | `MCL_TEST_DATABASE_URL=postgresql://benjaminpoersch@localhost:5432/mcl_test npm run test` |
| `npm run check:integration-ran` | **PASS** — `total=39 passed=39 failed=0 skipped=0` | same env |
| Playwright e2e | **PASS** — 86 passed in 37.0s | `rm -rf .data && E2E_PORT=3199 npx playwright test` |
| Local PostgreSQL | 15.18 (Homebrew), db `mcl_test` reachable as role `benjaminpoersch` | `psql -tAc 'show server_version'` |
| Routes built | `/`, `/admin`, `/welt/[id]`, `/api/{admin/inbox/submissions,admin/session,family/session,health,health/ready,inbox/submissions}` | `next build` route table |

**Local environment notes that will bite you:**

- `psql` is not on `PATH`. Prefix with `export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"`.
- The local connection string is `postgresql://benjaminpoersch@localhost:5432/mcl_test` — **not** the `postgres:postgres@` string from CI.
- Running Playwright rewrites two tracked files (`next dev` regenerates them): `AGENTS.md` gains a `<!-- BEGIN:nextjs-agent-rules -->` block and `next-env.d.ts` changes. **`git checkout -- AGENTS.md next-env.d.ts` before every commit.** CI has a step `Require committed next-env types` that fails on a dirty `next-env.d.ts`.
- `CLAUDE.md` is modified in the working tree (an `/init` refresh, not committed). Leave it; commit it separately if wanted.
- `scripts/check-foundation.mjs` walks the **whole repo** including `docs/plans/` and refuses on two literal franchise names. Never write them literally in any file, this plan included.

---

## Sprint goal, decomposed into claims that can be proven or disproven

Sprint 513 goal, verbatim:

> „Eingegangene Ideen liegen dauerhaft und geschützt im Projekt, können von einer berechtigten Projektperson nachvollziehbar gelesen werden, und die Kinder können die Spielwelt-Kacheln endlich wirklich öffnen und vertiefen."

| # | Claim | Text | Audio | Owner |
|---|---|---|---|---|
| G1 | ideas lie **durably and protected** in the project | ✅ MCL-48 + MCL-34 (PostgreSQL, ACK after commit, gate fails closed) | ❌ **nothing arrives at all** | **MCL-49 + MCL-30B** |
| G2 | an authorised project person can read them **comprehensibly** | ✅ MCL-50 (`/admin`, separate credential, filters, receipts) | ❌ no entry, no playback | **MCL-49** |
| G3 | children can **really open and deepen** the world tiles | ✅ MCL-47 (`/welt/[id]`, 86 e2e assertions green) | n/a | done |
| G4 | *(sprint backlog item beyond the goal text)* questions close, rotate, archive | ❌ | ❌ | **MCL-35** |

**The honest current state of audio**, verified in code: `src/app/components/audio-answer-recorder.tsx:64-67` tells the child, in German, *"Deine Aufnahme bleibt nur auf diesem Gerät, solange die Seite offen ist. Abschicken kannst du sie noch nicht - das kommt später."* `src/adapters/media/audio-capture-controller.ts:7-10` states the same rule for the module. `grep -rn "audio" src/application src/adapters/persistence src/app/api src/composition` finds **only comments and one import**. So a child can record, listen and discard — and nothing else. Sprint claim G1 is false for audio.

---

## Governance flags — read before starting, these are the Product Owner's calls, not the implementer's

These are stated, not resolved by this plan:

- **F1 — WIP=1 vs. this plan.** Confluence MLOA pages 09 and 13 declare `MCL-63` (Cloudflare/OpenNext) the single current WIP slice and say *"Keine neue fachliche Story parallel öffnen."* MCL-63 is **not in sprint 513**. PR #30 is **open and red** (Cloudflare Workers Builds: 4 builds, 4 failures; the dashboard build command is `npm run build` where `npm run build:cloudflare` is required — a change only a human with dashboard access can make). MCL-63 also rewrites `package.json`, `next.config.ts`, `.github/workflows/ci.yml`, `scripts/check-foundation.mjs` and ~16k lines of `package-lock.json` — **the exact four files every slice in this plan must also edit**. Whichever merges second pays a manual merge on the gate machinery `AGENTS.md` forbids bypassing. Decide explicitly: finish MCL-63 first, or suspend WIP=1 for the sprint.
- **F2 — MCL-41 keeps the release gate shut.** `src/app/layout.tsx:6` still ships `title: "Avaloria"`. MCL-41 (Highest, release blocker) is not in the sprint and has no repo footprint. **Nothing in this plan may be publicly released**, however green it is. Internal review/staging is unaffected.
- **F3 — retention policy for children's voice recordings does not exist.** MCL-49's own *Out of Scope* says deletion/retention stays an open product/privacy policy. This plan stores original audio of children behind that open policy. It writes the gap into `docs/ops/`, it does not close it. `KEEP_DAYS=90` in the backup script is flagged in `docs/ops/MCL-48-backup-restore.md` §5 as *"in the script because somebody had to write a number, not because anyone chose 90 days"*.
- **F4 — MCL-32 overlaps *both* MCL-35 and MCL-30.** `MCL-32 [Web] Offene Fragen rotieren und manuell abschließen` (Story, Zu erledigen, High) is not in the sprint; it duplicates MCL-35's rotation behaviour **and** carries the AC *"Antwort per Text oder Audio möglich"*, which this sprint's MCL-30 work also delivers. Finishing MCL-30 and MCL-35 leaves MCL-32 open covering both. Needs a Jira decision (close as duplicate, or link). Related: **no Jira issue links exist anywhere in the project** — every one of the nine issues fetched has `issuelinks: []`, so every dependency in this backlog is free text inside a description and is invisible to the board, the burndown and any automation.
- **F5 — backups do not currently cover blobs, and are not running.** `docs/ops/MCL-48-backup-restore.md:528` says `pg_dump` will not cover files and *"this document needs a second stream for those files"*. Measured 2026-08-21: the LaunchAgent `com.dyai.mcl-backup` does not exist and `~/Backups/mc-legends` holds one dump dated 14 Aug — 7 days stale, which the doc's own rubric calls "the schedule is not firing".
- **F6 — VPS disk headroom is unverified for audio.** `docs/deploy/vps-mc-legends.md:25` records 96 G total / 22 G free / **78 % used** on 2026-08-13, and :618 requires re-checking capacity and backup sizing *before* MCL-49 starts. Nobody has re-run `df -h /` since. **Task A0 does this.**
- **F7 — MCL-30 ⟷ MCL-49 is circular in Jira.** MCL-49 lists MCL-30 as a dependency; MCL-30's AC *"Originalaudio bleibt unverändert gespeichert"* cannot be met without MCL-49. This plan breaks the cycle by sequencing **MCL-49 (server) → MCL-30B (client)** and by treating MCL-30's storage AC as satisfied by MCL-49's store. Record that on the Jira issues.

---

## Recorded decisions — do not re-litigate during execution

| # | Decision | Why | Rejected alternatives |
|---|---|---|---|
| **D1** | Original audio lives in a **private filesystem directory on the same VPS**, not in cloud object storage. | Confluence MLOA page 12: *"Für den MVP ist ein zusätzlicher Cloud-Object-Storage nicht zwingend."* The container already bind-mounts `/opt/mc-legends/data:/data`, so a persistent private volume exists today, and `AVALORIA_INBOX_DIR` already proves the pattern. | **Cloudflare R2** — and this is a real option, not a straw man: the account already holds a `dyai-media` bucket (created 2026-03-04). Rejected because (a) it needs an S3-style credential that must be registered in **five** gate locations (`src/composition/server.ts`, `tests/architecture/boundaries.test.ts:96-105`, `scripts/check-client-secrets.mjs:25-32`, and **both** literal env blocks in `.github/workflows/ci.yml:93-96` and `:100-103`) or the client-bundle scan passes vacuously; (b) MCL-63's own boundary says the Worker never touches persistence, so R2 would be reached from the VPS anyway — a network hop bought for nothing. **PostgreSQL `bytea`** is not a trade-off at all: MCL-49's Ziel says *"außerhalb der relationalen Datenbank"*, and per `AGENTS.md:5` Jira owns scope. |
| **D2** | The object key is **content-addressed**: `sha256[0..2]/sha256 + extension`, where both the hash and the extension are **server-derived**. | Zero client-controlled input reaches a filesystem path, so path traversal is impossible *by construction* rather than by sanitising. Identical bytes de-duplicate, which is correct for immutable artifacts. | Keying by `submissionId` — that value is client-supplied and would need traversal validation on every read and write. |
| **D3** | The upload is **raw audio bytes in the body + identifiers in custom `x-avaloria-*` request headers**, on a dedicated route `POST /api/inbox/submissions/audio`. | (a) Bytes stay byte-exact with no encode/decode step, which is what *"Originalaudio unverändert"* means. (b) It reuses the existing streaming byte cap (`readBoundedBody`) instead of a multipart parser. (c) A custom header forces a CORS preflight, so a cross-origin *simple* POST cannot reach the route at all — a security gain the JSON route does not have. | multipart/form-data (`request.formData()` buffers before any cap can apply, and adds a parser to audit); base64 in JSON (+33 % body, doubles peak memory, and re-encodes the child's bytes). |
| **D4** | `kind` is widened to a **discriminated union** `TextInboxRecord \| AudioInboxRecord`, not an optional-fields record. | `src/application/submissions/submission-inbox-store.ts:4-8` already says this is the intent: *"Widening this union later makes the compiler find every site that has to choose."* A union makes `originalText` absent on audio instead of empty — an empty original text is exactly the lie the schema forbids. | Nullable `originalText` + nullable audio columns with no CHECK — lets a row be neither and be both. |
| **D5** | The blob is written **before** the inbox row, and the row is what mints the receipt. | An inbox row must never reference an object that is not on disk. The opposite failure — an orphan blob with no row — is harmless and self-heals: a retry re-uploads identical bytes to the identical key. | Row-first (a crash leaves the admin view pointing at nothing). |
| **D6** | Playback is served with the **real allowlisted audio MIME**, plus `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. | MCL-49 AC *"nicht als ausführbarer Webinhalt ausgeliefert"* is satisfied because the Content-Type comes from a closed server-side allowlist that contains only audio types — it can never be `text/html` — and `nosniff` forbids re-interpretation. An adult can then actually listen, which is what makes sprint claim G2 true for audio. | `application/octet-stream` + `Content-Disposition: attachment` — browsers largely ignore disposition for media elements, so it would neither play reliably nor add real safety. |
| **D7** | Question lifecycle is a **durable overlay** on the compile-time catalogue; the dataset file is never mutated to close a question. | Keeps *"nichts wird für die Website erfunden"* intact, keeps the two dataset invariants in `tests/unit/open-questions.test.ts` (≥3 open questions; ≥1 category with no question) unbroken, and makes closing a question an **operation** rather than a redeploy. | Editing `state: "closed"` into `src/content/open-questions.ts` — that is a rebuild + redeploy per question, and `focus: true` on a closed entry crashes both child surfaces (`focusQuestion()` counts zero and throws). |
| **D8** | The active question is chosen **on the server** and passed to `FamilyExperience` as a prop. | `src/app/family-experience.tsx:39` calls `focusQuestion()` at *module scope* of a `"use client"` file, and `tests/architecture/boundaries.test.ts:118` forbids that file from importing `@/composition/server` or `node:`. A client component cannot read the overlay. `src/app/welt/[id]/page.tsx:61` is already a server component and reads it directly. | Fetching questions from the client (an extra round trip on first paint, and a child briefly sees the wrong question). |
| **D9** | Audio uploads get their **own** rate limiter (`AVALORIA_AUDIO_RATE_LIMIT`, default 10 / 60 s). | An 8 MiB upload is ~270× the cost of a 30 KiB text POST. Sharing the inbox bucket (30/min) would permit ~240 MiB/min of writes on a VPS at 78 % disk. | Reusing `createProtectedRouteRateLimiter()`. |
| **D10** | A failed audio send keeps the **bytes** locally in IndexedDB, in a separate object store, so retry survives a reload. | This is what makes the audio path honestly match the text path: Confluence stage 2 requires *"bei Fehler bleibt die lokale Submission erhalten und erneut versendbar"*. Without it, a failed send loses a child's recording. | Keeping the blob in React state only (lost on reload, and "Meine Ideen" could not list it). |
| **D11** | `POST /api/inbox/submissions` (text) **and** the audio route validate `questionId` against the question catalogue and refuse a **closed** question with `400 invalid-payload`. | Without it, closing a question does not stop answers: `src/app/api/inbox/submissions/route.ts:56-88` checks only type/blank/length/NUL/surrogate, and IndexedDB retries re-post the original `questionId` forever. | Accepting answers to closed questions (they would be stored `RECEIVED` and silently pollute the archive). |
| **D12** | Every new persistence port ships **two adapters** (file + PostgreSQL) proven by **one shared contract suite**, matching `tests/unit/submission-inbox-*-contract.ts`. | `src/composition/server.ts:35-42` documents the file branch as MCL-48's **rollback path**, not dead code. A port with only a PostgreSQL adapter silently removes that rollback. | PostgreSQL only. |

---

## Traps that a first draft of this work gets wrong — each one measured on `1084417`

Read this list before Task A1. Every entry is something the code does today that quietly breaks an audio slice.

| # | Trap | Where | What it costs if missed |
|---|---|---|---|
| T1 | **nginx rejects the upload before the app ever sees it. Measured against production on 2026-08-21, not inferred.** `POST https://srv1308064.hstgr.cloud:8443/api/inbox/submissions` with a 1000 KB body → `401` (it reached the app's own guard); with a 1100 KB body → `413` with nginx's `<title>413 Request Entity Too Large</title>`. `grep -n 'client_max_body_size' docs/deploy/vps-mc-legends.md` → no match; `next.config.ts` is 12 lines and sets no limit either. | production vhost `8443`; `docs/deploy/vps-mc-legends.md:38` is the only nginx row | The proxy ceiling is ~1 MB. A 30-second webm/opus voice note is ~60–100 KB and fits; an `.m4a` a child picks from a phone often does not. **Every local test would pass while production returns 413.** Task **D2** sets `client_max_body_size 9m;` on that vhost *and* verifies it with a real 2 MB upload that must come back `400`/`401` from the app, never `413` from nginx. |
| T2 | **`scripts/import-inbox-jsonl.mjs:146-148` refuses any line whose `kind` is not `"text"`.** Its own comment: *"MCL-49 will widen this union, at which point the importer must be revisited deliberately."* `toValues` binds exactly 7 columns. | `scripts/import-inbox-jsonl.mjs` | The JSONL→PostgreSQL cutover path silently drops every audio answer. Task **A6b** widens it. |
| T3 | **`readInboxRecord` marks any non-`"text"` kind as a damaged line**, and `readAll()` skips damaged lines with one `console.error` per read. | `src/adapters/persistence/inbox-record-shape.ts:~95`, `file-submission-inbox-store.ts:228-244` | On MCL-48's **rollback path** — the moment somebody is already in trouble — audio answers would vanish from duplicate checks and from the admin list. Widen it in A6. |
| T4 | **`HttpSubmissionInbox` aborts after 10 s** (`AbortSignal.timeout`). | `src/adapters/http/http-submission-inbox.ts:7,57,75` | An 8 MiB upload on a slow tablet connection is a guaranteed `transport` failure. The audio adapter (B1) needs its own, larger budget — and it must still have one. |
| T5 | **CI runs e2e with no `env:` block at all**, so browser tests never touch PostgreSQL. | `.github/workflows/ci.yml:109-116` | The audio journeys are proven only against `FileSubmissionInboxStore` + `FileAudioArtifactStore`. That is acceptable — both are real adapters — but the plan must not claim e2e proves the PostgreSQL path. The contract suites (A4, A6) are what prove that. |
| T6 | **Playwright is `fullyParallel` against one shared `.data/inbox`, never cleaned by the harness.** | `playwright.config.ts` (no `globalSetup`, no `AVALORIA_INBOX_DIR`), `tests/e2e/admin-inbox.spec.ts:112-115` | Any new assertion of the form "the list has N entries" is racy. **Filter on a unique `submissionId`**, the way the existing admin spec already does. The same applies to `.data/media`. |
| T7 | **`vitest.config.ts` collects only `tests/**/*.test.ts` — not `.tsx`.** | `vitest.config.ts` | A component test named `*.test.tsx` is silently never run and `npm run test` stays green. Name every new test `.ts`. Likewise a contract suite accidentally named `*-contract.test.ts` would run with zero cases and pass. |
| T8 | **`npm run verify` omits three of the eight checks `AGENTS.md` requires**: `check:client-secrets`, `check:integration-ran`, `test:e2e`. | `package.json`, `AGENTS.md:29-46` | "verify is green" is not "the gate is green". Every gate block in this plan runs all eight explicitly. |
| T9 | **Nothing constrains `src/adapters/media`.** `tests/architecture/boundaries.test.ts` covers `src/domain`, `src/application`, `src/composition/browser.ts`, `src/content` and a hard-coded client-component list — the media adapter may import `next` or `react` freely. | `tests/architecture/boundaries.test.ts` | Add a rule for `src/adapters` as a whole in A13: no `next`, no `react`. |
| T10 | **`scripts/check-foundation.mjs` does not list the MCL-50 admin surface at all** — 11 existing load-bearing files including `src/app/admin/page.tsx`, both admin routes, both admin components and `src/app/world-routes.ts`. The list holds **56** paths, not the 52 `CLAUDE.md` claims. | `scripts/check-foundation.mjs:4-59` | The structural gate is describing a foundation that is already smaller than reality. A13 appends the missing paths alongside the new ones. |
| T11 | **A recording is destroyed by ordinary in-app navigation**, not only by reload: opening an idea tile unmounts `FamilyExperience`, which unmounts the recorder, which calls `release()`. The child-facing sentence says *"solange die Seite offen ist"*, which a child may reasonably read as covering a click inside the same site. | `family-experience.tsx:297-322`, `audio-answer-recorder.tsx:43`, `audio-capture-controller.ts:343-347` | Decision **D10** (local blob persistence) is what fixes this, not just the reload case. Journey **J2c** pins it. |
| T12 | **There is no size ceiling anywhere in the capture path.** `AudioCaptureController` accepts a chosen file of any size and hands it an object URL. | `audio-capture-controller.ts:151-157, 409-418` | A large file is a tab crash on a tablet with no entry in the failure taxonomy. Task **B6b** adds a `file-too-large` reason and a child-safe sentence, checked before an object URL is created. |
| T13 | **`deliverSubmission` already documents that a local-save failure after a real ACK can leave two inbox lines for one `submissionId`.** With audio the duplicate is a second **stored blob**. | `deliver-submission.ts:36-41` | Content-addressing (decision D2) makes the second blob the *same* object, so the cost is one extra row, not one extra file. Say so in the audio version of that comment. |
| T14 | **The MCL-30A honesty copy lives in three places at once** and all three must change together: the controller header, the message table, and the component note. Two of them are pinned by tests that a reword would not catch. | `audio-capture-controller.ts:7-10`, `audio-capture-message.ts:7-15`, `audio-answer-recorder.tsx:12-24, 64-67` | Leaving one behind tells a child "only on this device" for a recording that was uploaded — the inverse of the `AGENTS.md` arrival rule. |
| T15 | **Widening `kind` touches eight individually load-bearing compile sites.** Widen the union — do **not** add a parallel audio type beside it, or the compiler stops finding them. | domain:12, inbox-store port:8, reader port:30 and :47, `inbox-record-shape:~95`, `inbox route:187`, `admin route isKnownKind:78`, `migration 0001:19` | This is exactly what the comment at `submission-inbox-store.ts:4-7` was written to enable. |
| T16 | **The PostgreSQL `appendIfAbsent` is a single-statement `ON CONFLICT` and opens no transaction.** | `postgres-submission-inbox-store.ts:42-47, 136-138` | This is a positive argument for decision **D4**: audio metadata as columns on the *same* row keeps the write a single atomic statement. A separate `submission_audio` table would need an explicit transaction that adapter does not have. |

---

## Story A — MCL-49: original audio in private durable storage

**Branch:** `feat/MCL-49-private-audio-artifact-store` off `main` (`1084417`).

**Jira AC being satisfied** (verbatim from MCL-49):
- Audio wird in privatem Object Storage oder gleichwertigem nicht-öffentlichem Filespeicher abgelegt → A3, A4
- DB speichert mindestens objectKey, submissionId, MIME-Type, Dateiendung, Größe, SHA-256 und createdAt → A5, A6
- strikte Allowlist für zulässige Audio-MIME-Typen und passende Dateiendungen → A2
- Uploadgröße ist begrenzt und dokumentiert → A2, A8
- gespeicherte Audios werden nicht als ausführbarer Webinhalt ausgeliefert → A10
- Originalbytes werden bei späterer Transkription oder KI-Auswertung nicht verändert → A4 (write-once, content-addressed), A10 (read-only reader port)
- Zugriff ist über serverseitige Autorisierung geschützt; keine öffentlichen Bucket-URLs → A8 (family gate), A10 (admin gate)
- Lösch-/Retention-Verhalten ist als offene Produkt-/Privacy-Policy markiert → A13

---

### Task A0: Prove the VPS can hold audio before writing a line of code

`docs/deploy/vps-mc-legends.md:618` makes this a precondition of MCL-49, and the last disk reading is 8 days old.

**Step 1: Read the current disk and the existing data volume**

```bash
ssh -i ~/.ssh/id_ed25519 root@srv1308064.hstgr.cloud \
  'df -h / && echo "--- data volume ---" && du -sh /opt/mc-legends/data && ls -la /opt/mc-legends/data && echo "--- container ---" && docker inspect mc-legends --format "{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}" && docker inspect mc-legends --format "{{range .Config.Env}}{{println .}}{{end}}" | cut -d= -f1'
```

**Step 2: Record the answers in this plan**

Append a `### A0 result` block below this task with: free bytes on `/`, current size of `/opt/mc-legends/data`, the confirmed mount `/opt/mc-legends/data -> /data`, and whether `AVALORIA_ADMIN_ACCESS_CODE` appears in the container env key list (recon found it *absent* from the documented list at `docs/deploy/vps-mc-legends.md:37` — if it is genuinely unset, `/admin` is failing closed in production and that is a finding for the sprint review).

**Step 3: Gate**

If free space on `/` is **below 5 GB**, stop and report `BLOCKED: insufficient disk for audio artifacts` — do not start A1. Otherwise record `PASS` and continue. Budget: at 8 MiB max per upload, 5 GB is ~640 maximum-size recordings; real child answers of a few seconds are ~10–100 KiB.

> If the VPS is unreachable from this session, record `not_run: no ssh access from this session` and continue with A1 — but Story A **must not be deployed** until A0 has a real answer.

---

### Task A1: Widen the domain so an audio submission can exist

**Files:**
- Modify: `src/domain/submissions/submission.ts`
- Test: `tests/unit/submission.test.ts`

**Step 1: Write the failing tests**

Append to `tests/unit/submission.test.ts`:

```ts
describe("createAudioSubmission", () => {
  const deps = { createId: () => "audio-1", now: () => new Date("2026-08-21T10:00:00.000Z") };
  const audio = { mimeType: "audio/webm", byteSize: 2048 } as const;

  it("starts local-only, exactly like a text answer", () => {
    const submission = createAudioSubmission({ questionId: "companion-animal", audio }, deps);
    expect(submission.kind).toBe("audio");
    expect(submission.status).toBe("LOCAL_ONLY");
    expect(hasArrivedInProject(submission.status)).toBe(false);
    expect(submission.audio).toEqual(audio);
  });

  it("refuses a recording of no bytes - there is nothing to send", () => {
    expect(() => createAudioSubmission({ questionId: "q", audio: { ...audio, byteSize: 0 } }, deps))
      .toThrow(/byteSize/);
  });

  it("refuses a blank questionId, like the text factory does", () => {
    expect(() => createAudioSubmission({ questionId: "  ", audio }, deps)).toThrow(/questionId/);
  });

  it("only a real receipt makes an audio answer read as arrived", () => {
    const submission = createAudioSubmission({ questionId: "q", audio }, deps);
    const acknowledged = acknowledgeSubmission(submission, {
      receiptId: " r-1 ",
      receivedAt: " 2026-08-21T10:00:01.000Z ",
    });
    expect(hasArrivedInProject(acknowledged.status)).toBe(true);
    // Still an audio submission afterwards - acknowledge must not flatten the union.
    expect(acknowledged.kind).toBe("audio");
    expect(acknowledged.audio).toEqual(audio);
    expect(acknowledged.receipt).toEqual({ receiptId: "r-1", receivedAt: "2026-08-21T10:00:01.000Z" });
  });
});
```

Add `createAudioSubmission` to the import list at the top of the file.

**Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/submission.test.ts
```
Expected: FAIL — `createAudioSubmission is not exported` / TS2305.

**Step 3: Implement**

In `src/domain/submissions/submission.ts`, after `TextSubmission`:

```ts
/**
 * What the *browser* knows about a recording before it is sent. Deliberately not the
 * server's view: there is no sha256 here, because a hash a client supplies is a hash
 * nobody may trust. The server computes its own from the bytes it actually received,
 * and that one lives in the inbox record, never here.
 */
export type LocalAudioArtifact = Readonly<{
  /** The recorder's own output type, or the chosen file's type. Never rewritten. */
  mimeType: string;
  byteSize: number;
}>;

export type AudioSubmission = Readonly<{
  id: SubmissionId;
  kind: "audio";
  questionId: string;
  createdAt: string;
  status: SubmissionStatus;
  audio: LocalAudioArtifact;
  profileId?: string;
  /** Only present once the server really acknowledged this submission. */
  receipt?: ServerReceipt;
}>;

/**
 * Either kind of answer a child can send. A union rather than one type with optional
 * fields: an audio answer has no original text, and a text answer has no recording -
 * an empty string for the first would be exactly the invented content the project
 * forbids.
 */
export type Submission = TextSubmission | AudioSubmission;

export type CreateAudioSubmissionInput = Readonly<{
  questionId: string;
  audio: LocalAudioArtifact;
  profileId?: string;
}>;

export function createAudioSubmission(
  input: CreateAudioSubmissionInput,
  dependencies: SubmissionFactoryDependencies,
): AudioSubmission {
  if (input.questionId.trim().length === 0) {
    throw new Error("questionId must not be blank");
  }

  // A recording of nothing is not an answer. The capture controller already refuses an
  // empty blob ("empty-recording"), but the domain must not depend on that being the
  // only caller.
  if (!Number.isInteger(input.audio.byteSize) || input.audio.byteSize <= 0) {
    throw new Error("audio byteSize must be a positive integer");
  }

  if (input.audio.mimeType.trim().length === 0) {
    throw new Error("audio mimeType must not be blank");
  }

  const id = dependencies.createId();
  if (id.trim().length === 0) {
    throw new Error("generated submission id must not be blank");
  }

  return Object.freeze({
    id,
    kind: "audio" as const,
    questionId: input.questionId,
    createdAt: dependencies.now().toISOString(),
    status: "LOCAL_ONLY" as const,
    audio: Object.freeze({ ...input.audio }),
    ...(input.profileId ? { profileId: input.profileId } : {}),
  });
}
```

Then make `acknowledgeSubmission` generic so it does not flatten the union — change its signature and nothing else:

```ts
export function acknowledgeSubmission<S extends Submission>(
  submission: S,
  receipt: ServerReceipt,
): S {
```

and the return becomes `Object.freeze({ ...submission, status: "SERVER_ACKNOWLEDGED" as const, receipt: ... }) as S;`.

**Step 4: Run the tests**

```bash
npx vitest run tests/unit/submission.test.ts tests/unit/deliver-submission.test.ts && npm run typecheck
```
Expected: PASS, and `typecheck` clean — the generic must not break `deliverSubmission`.

**Step 5: Commit**

```bash
git add src/domain/submissions/submission.ts tests/unit/submission.test.ts
git commit -m "feat(MCL-49): let the domain hold a recorded answer, not only a written one"
```

---

### Task A2: The audio type allowlist and the size cap

**Files:**
- Create: `src/application/submissions/audio-artifact.ts`
- Test: `tests/unit/audio-artifact.test.ts`

**Step 1: Write the failing test** (`tests/unit/audio-artifact.test.ts`)

```ts
/**
 * Pins the allowlist MCL-49 requires: a *closed* set of audio types, each mapped to
 * exactly one file extension the server chooses. What makes this worth its own test is
 * the negative half - a browser is free to send "audio/webm;codecs=opus", and a type
 * that is not on the list must be refused rather than stored under a guessed name.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_AUDIO_BYTES,
  audioExtensionFor,
  normaliseAudioMimeType,
} from "@/application/submissions/audio-artifact";

describe("audio type allowlist", () => {
  it("accepts the types a browser recorder actually produces", () => {
    expect(audioExtensionFor("audio/webm")).toBe(".webm");
    expect(audioExtensionFor("audio/ogg")).toBe(".ogg");
    expect(audioExtensionFor("audio/mp4")).toBe(".m4a");
    expect(audioExtensionFor("audio/mpeg")).toBe(".mp3");
    expect(audioExtensionFor("audio/wav")).toBe(".wav");
  });

  it("drops codec parameters and casing before matching", () => {
    expect(normaliseAudioMimeType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normaliseAudioMimeType(" AUDIO/WEBM ; codecs=opus ")).toBe("audio/webm");
    expect(audioExtensionFor(normaliseAudioMimeType("audio/webm;codecs=opus") ?? "")).toBe(".webm");
  });

  it("refuses everything that is not on the list, including things that could execute", () => {
    for (const refused of [
      "text/html",
      "application/javascript",
      "image/svg+xml",
      "application/octet-stream",
      "audio/x-made-up",
      "",
      "audio",
    ]) {
      expect(audioExtensionFor(refused), refused).toBeNull();
    }
  });

  it("refuses a type that only looks like an audio type", () => {
    expect(normaliseAudioMimeType("audio/webm/../../etc/passwd")).toBe("audio/webm/../../etc/passwd");
    expect(audioExtensionFor("audio/webm/../../etc/passwd")).toBeNull();
  });

  it("documents the upload ceiling as a number, not a comment", () => {
    expect(MAX_AUDIO_BYTES).toBe(8 * 1024 * 1024);
  });
});
```

**Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/audio-artifact.test.ts
```
Expected: FAIL — module not found.

**Step 3: Implement** (`src/application/submissions/audio-artifact.ts`)

```ts
/**
 * What the server is willing to store as an original recording (MCL-49).
 *
 * A closed table, in the application layer rather than in the route, because two
 * callers need exactly the same answer: the upload route deciding whether to accept
 * bytes, and the playback route deciding what Content-Type to serve them back under.
 * Two copies would eventually disagree, and the disagreement would be a file stored as
 * one thing and served as another - which is the shape of every "uploaded file executes"
 * bug there is.
 *
 * The extension is the *server's* choice, never the client's. It becomes part of a
 * filesystem path, so nothing a caller sends may reach it.
 */
const audioTypes = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
} as const satisfies Record<string, string>;

export type AllowedAudioMimeType = keyof typeof audioTypes;

/**
 * The ceiling on one upload, and the reason for the number.
 *
 * 8 MiB is roughly sixteen minutes of Opus at the bitrate a browser recorder picks for
 * speech, and far more than the few seconds a child's answer actually is. It is small
 * enough that a request this server *rejects* cannot cost it its memory, and small
 * enough that the VPS disk budget in docs/ops/ stays legible: 640 maximum-size uploads
 * per 5 GB.
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/**
 * The type without its parameters, lowercased.
 *
 * MediaRecorder reports "audio/webm;codecs=opus", and the parameter is real information
 * about the bytes - but it is not part of the identity the allowlist matches on, and
 * keeping it would make an allowlist entry per codec. Trimmed and lowercased because a
 * header is written by a client and RFC 9110 makes the type case-insensitive.
 */
export function normaliseAudioMimeType(headerValue: string): string {
  return headerValue.split(";")[0].trim().toLowerCase();
}

/** The one extension this server stores the given type under, or null if it will not. */
export function audioExtensionFor(mimeType: string): string | null {
  return Object.hasOwn(audioTypes, mimeType)
    ? audioTypes[mimeType as AllowedAudioMimeType]
    : null;
}

/** True only for a type this server both stores and is willing to serve back. */
export function isAllowedAudioMimeType(value: string): value is AllowedAudioMimeType {
  return Object.hasOwn(audioTypes, value);
}
```

> `Object.hasOwn` rather than `audioTypes[value] !== undefined`: the second answers `".webm"` for the string `"constructor"` on a plain object literal in some engines' prototype chains, and an allowlist that can be fooled by a prototype key is not an allowlist.

**Step 4: Run the tests**

```bash
npx vitest run tests/unit/audio-artifact.test.ts
```
Expected: PASS (6 tests).

**Step 5: Commit**

```bash
git add src/application/submissions/audio-artifact.ts tests/unit/audio-artifact.test.ts
git commit -m "feat(MCL-49): decide once which recordings this server will hold"
```

---

### Task A3: The artifact store port

**Files:**
- Create: `src/application/submissions/audio-artifact-store.ts`

No test of its own — it is types plus one error class; the contract suite in A4 is what proves it. This is the same shape as `submission-inbox-store.ts`.

**Step 1: Write it**

```ts
/**
 * The boundary between "a recording arrived" and "wherever recordings are kept"
 * (MCL-49).
 *
 * Two ports, not one, for the same reason SubmissionInboxStore and
 * SubmissionInboxReader are two: children reach the write side through the family gate,
 * and only an adult reaches the read side through the admin gate. One interface with
 * both methods would make that separation a matter of discipline in the composition
 * root instead of something a route structurally cannot get wrong.
 */

/** What the server derived from the bytes it received. None of it is client-supplied. */
export type AudioArtifactDescriptor = Readonly<{
  /** Lowercase hex, 64 characters. Computed here, never sent by a caller. */
  sha256: string;
  /** An allowlisted type - see audio-artifact.ts. */
  mimeType: string;
  /** The extension this server chose for that type. */
  fileExtension: string;
  byteSize: number;
}>;

/**
 * What one write attempt did.
 *
 * `stored: false` is not a failure and not an error: identical bytes are one artifact,
 * so a retry of the same recording finds the object already there. The key is returned
 * either way, because the caller needs it to write the inbox row regardless of which of
 * the two happened.
 */
export type ArtifactWriteOutcome = Readonly<{ stored: boolean; objectKey: string }>;

/**
 * The store refused these bytes or this descriptor. Retrying is pointless.
 *
 * On the port and not in one adapter, for the same reason SubmissionPayloadError is:
 * the caller must tell "this recording is not storable" (a 400 that ends there) from
 * "the storage is unavailable" (a 503 worth retrying) without knowing which adapter it
 * was handed.
 */
export class AudioArtifactError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AudioArtifactError";
  }
}

export interface AudioArtifactStore {
  /**
   * Writes the bytes if this server does not already hold them, and answers under which
   * key they now live. Write-once: an existing object is never overwritten, because the
   * original artifact is immutable by project rule.
   */
  putIfAbsent(
    descriptor: AudioArtifactDescriptor,
    bytes: Uint8Array,
  ): Promise<ArtifactWriteOutcome>;

  /**
   * Whether this store could accept a write right now. Used by readiness, so a full or
   * unmounted volume is visible before a child is told their answer arrived.
   */
  checkWritable(): Promise<void>;
}

export type StoredAudioArtifact = Readonly<{
  bytes: Uint8Array;
  byteSize: number;
}>;

export interface AudioArtifactReader {
  /** The stored bytes, or null when this server does not hold that key. */
  read(objectKey: string): Promise<StoredAudioArtifact | null>;
}
```

**Step 2: Commit**

```bash
git add src/application/submissions/audio-artifact-store.ts
git commit -m "feat(MCL-49): name the boundary a recording crosses to become durable"
```

---

### Task A4: The private filesystem adapter, proven by a contract suite

**Files:**
- Create: `src/adapters/persistence/file-audio-artifact-store.ts`
- Create: `tests/unit/audio-artifact-store-contract.ts` (reusable suite, not a test file)
- Create: `tests/unit/file-audio-artifact-store.test.ts`

**Step 1: Write the contract suite** (`tests/unit/audio-artifact-store-contract.ts`)

```ts
/**
 * The behaviour every audio artifact store must have, whichever medium it uses.
 *
 * A shared suite rather than duplicated cases, so the filesystem adapter and any later
 * one cannot drift: MCL-49's promises - write-once, byte-exact, private, refuses a key
 * it did not mint - are properties of the boundary, not of one implementation.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AudioArtifactReader,
  AudioArtifactStore,
} from "@/application/submissions/audio-artifact-store";

export type ArtifactHarness = Readonly<{
  store: AudioArtifactStore;
  reader: AudioArtifactReader;
}>;

function descriptorFor(bytes: Uint8Array) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType: "audio/webm",
    fileExtension: ".webm",
    byteSize: bytes.byteLength,
  };
}

export function describeAudioArtifactStoreContract(
  name: string,
  createHarness: () => Promise<ArtifactHarness>,
): void {
  describe(`${name} - audio artifact contract`, () => {
    it("gives back exactly the bytes it was handed", async () => {
      const { store, reader } = await createHarness();
      // Deliberately not text: an artifact store that only survives ASCII is one that
      // has silently decoded something.
      const bytes = new Uint8Array([26, 69, 223, 163, 0, 255, 128, 1, 0, 0]);

      const outcome = await store.putIfAbsent(descriptorFor(bytes), bytes);
      expect(outcome.stored).toBe(true);

      const stored = await reader.read(outcome.objectKey);
      expect(stored).not.toBeNull();
      expect(Array.from(stored!.bytes)).toEqual(Array.from(bytes));
      expect(stored!.byteSize).toBe(bytes.byteLength);
    });

    it("holds identical bytes once and reports the second write as already there", async () => {
      const { store, reader } = await createHarness();
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const descriptor = descriptorFor(bytes);

      const first = await store.putIfAbsent(descriptor, bytes);
      const second = await store.putIfAbsent(descriptor, bytes);

      expect(first.stored).toBe(true);
      expect(second.stored).toBe(false);
      expect(second.objectKey).toBe(first.objectKey);
      expect((await reader.read(first.objectKey))!.byteSize).toBe(4);
    });

    it("keeps two different recordings apart", async () => {
      const { store, reader } = await createHarness();
      const one = new Uint8Array([1, 1, 1]);
      const two = new Uint8Array([2, 2, 2]);

      const a = await store.putIfAbsent(descriptorFor(one), one);
      const b = await store.putIfAbsent(descriptorFor(two), two);

      expect(a.objectKey).not.toBe(b.objectKey);
      expect(Array.from((await reader.read(a.objectKey))!.bytes)).toEqual([1, 1, 1]);
      expect(Array.from((await reader.read(b.objectKey))!.bytes)).toEqual([2, 2, 2]);
    });

    it("answers null for a key it does not hold, instead of throwing", async () => {
      const { reader } = await createHarness();
      const absent = `ab/${"a".repeat(64)}.webm`;
      await expect(reader.read(absent)).resolves.toBeNull();
    });

    it("refuses every key shape it did not mint itself", async () => {
      const { reader } = await createHarness();
      for (const hostile of [
        "../../etc/passwd",
        "ab/../../../etc/passwd",
        "ab/" + "a".repeat(64) + ".webm/../../secret",
        "/etc/passwd",
        "ab/NOTHEX" + "a".repeat(58) + ".webm",
        "ab/" + "a".repeat(64) + ".sh",
        "",
      ]) {
        await expect(reader.read(hostile), hostile).resolves.toBeNull();
      }
    });

    it("says so when it cannot write, rather than pretending it can", async () => {
      const { store } = await createHarness();
      await expect(store.checkWritable()).resolves.toBeUndefined();
    });
  });
}
```

**Step 2: Run it and watch it fail**

Create `tests/unit/file-audio-artifact-store.test.ts`:

```ts
/**
 * The filesystem adapter against the shared contract, plus the two properties only a
 * filesystem can have: the bytes are not world-readable, and they are not written
 * anywhere a web server would serve them.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { FileAudioArtifactStore } from "@/adapters/persistence/file-audio-artifact-store";
import { describeAudioArtifactStoreContract } from "./audio-artifact-store-contract";

const directories: string[] = [];

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcl-audio-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describeAudioArtifactStoreContract("FileAudioArtifactStore", async () => {
  const store = new FileAudioArtifactStore(await freshDirectory());
  return { store, reader: store };
});

it("writes the recording so only the process owner can read it", async () => {
  const store = new FileAudioArtifactStore(await freshDirectory());
  const bytes = new Uint8Array([9, 9, 9, 9]);
  const outcome = await store.putIfAbsent(
    {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mimeType: "audio/webm",
      fileExtension: ".webm",
      byteSize: 4,
    },
    bytes,
  );

  const written = await stat(join(store.rootDirectory, outcome.objectKey));
  // 0o600. A child's voice must not be readable by every account on a shared VPS.
  expect(written.mode & 0o777).toBe(0o600);
});
```

```bash
npx vitest run tests/unit/file-audio-artifact-store.test.ts
```
Expected: FAIL — `FileAudioArtifactStore` not found.

**Step 3: Implement** (`src/adapters/persistence/file-audio-artifact-store.ts`)

```ts
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AudioArtifactError,
  type ArtifactWriteOutcome,
  type AudioArtifactDescriptor,
  type AudioArtifactReader,
  type AudioArtifactStore,
  type StoredAudioArtifact,
} from "@/application/submissions/audio-artifact-store";

/**
 * The only key shape this adapter will ever look at.
 *
 * Two hex characters, a slash, sixty-four hex characters, a lowercase extension. Every
 * part of it is minted by objectKeyFor() below from a hash this server computed and an
 * extension it chose from a closed table - so a key that does not match this pattern is,
 * by construction, not a key this store issued. Checked before any path is built rather
 * than after, because "…/../.." only has to reach join() once.
 */
const OBJECT_KEY = /^[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]{2,5}$/;

/**
 * Private, durable storage for original recordings (MCL-49).
 *
 * Content-addressed on purpose. The path is derived entirely from bytes this server
 * hashed, so nothing a caller sends can influence where a file lands - which is a
 * stronger statement than "we sanitise the submission id", and it is the same reason
 * the receipt is minted server-side rather than accepted from a payload. Identical
 * recordings de-duplicate, which is correct: an immutable artifact has one identity.
 *
 * Write-once. An existing object is never rewritten, so "Originalbytes werden bei
 * späterer Transkription oder KI-Auswertung nicht verändert" is a property of the
 * adapter and not a rule somebody has to remember.
 *
 * NOT distributed and NOT production-grade: two processes writing the same directory can
 * both see a key as absent and both write it. That is harmless *here* only because the
 * bytes are identical by construction - a content-addressed write is idempotent even
 * when it races. Nothing else about this adapter may be described as a durability
 * guarantee.
 */
export class FileAudioArtifactStore implements AudioArtifactStore, AudioArtifactReader {
  constructor(readonly rootDirectory: string) {}

  private objectKeyFor(descriptor: AudioArtifactDescriptor): string {
    if (!/^[0-9a-f]{64}$/.test(descriptor.sha256)) {
      throw new AudioArtifactError("sha256 must be 64 lowercase hex characters");
    }
    if (!/^\.[a-z0-9]{2,5}$/.test(descriptor.fileExtension)) {
      throw new AudioArtifactError("fileExtension must be a short lowercase extension");
    }
    return `${descriptor.sha256.slice(0, 2)}/${descriptor.sha256}${descriptor.fileExtension}`;
  }

  async putIfAbsent(
    descriptor: AudioArtifactDescriptor,
    bytes: Uint8Array,
  ): Promise<ArtifactWriteOutcome> {
    if (bytes.byteLength !== descriptor.byteSize) {
      throw new AudioArtifactError("descriptor byteSize does not match the bytes given");
    }
    if (bytes.byteLength === 0) {
      throw new AudioArtifactError("an empty recording is not an artifact");
    }

    const objectKey = this.objectKeyFor(descriptor);
    const target = join(this.rootDirectory, objectKey);

    await mkdir(dirname(target), { recursive: true, mode: 0o700 });

    try {
      await access(target, constants.F_OK);
      // Already held. Content-addressed, so it is the same recording by definition and
      // there is nothing to write.
      return { stored: false, objectKey };
    } catch {
      // Not there yet - fall through and write it.
    }

    // Written beside the target and moved into place, so a crash mid-write cannot leave
    // a truncated file under a key that claims to hold the whole recording. `wx` so two
    // concurrent writers do not share one temporary name.
    const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;

    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      // EEXIST on the rename target means another writer won the race with identical
      // bytes. That is the outcome we wanted, not a failure.
      if ((cause as NodeJS.ErrnoException)?.code === "EEXIST") {
        return { stored: false, objectKey };
      }
      throw cause;
    }

    return { stored: true, objectKey };
  }

  async checkWritable(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await access(this.rootDirectory, constants.W_OK);
  }

  async read(objectKey: string): Promise<StoredAudioArtifact | null> {
    // Shape first, filesystem second. A key this store did not mint is answered "not
    // here" rather than refused, because the caller is an admin route asking about a
    // row it read - and the honest answer to "is this artifact present" is no.
    if (!OBJECT_KEY.test(objectKey)) {
      return null;
    }

    const target = join(this.rootDirectory, objectKey);

    try {
      const bytes = new Uint8Array(await readFile(target));
      const size = (await stat(target)).size;
      return { bytes, byteSize: size };
    } catch {
      return null;
    }
  }
}
```

**Step 4: Run the tests**

```bash
npx vitest run tests/unit/file-audio-artifact-store.test.ts
```
Expected: PASS — 6 contract cases + 1 permission case.

**Step 5: Commit**

```bash
git add src/adapters/persistence/file-audio-artifact-store.ts tests/unit/audio-artifact-store-contract.ts tests/unit/file-audio-artifact-store.test.ts
git commit -m "feat(MCL-49): keep original recordings private, write-once and byte-exact"
```

---

### Task A5: Migration 0002 — audio metadata in PostgreSQL

**Files:**
- Create: `db/migrations/0002_submission_audio.sql`

**Step 1: Write the migration**

```sql
-- 0002_submission_audio.sql
-- Audio submissions in the durable inbox (MCL-49).
--
-- The bytes do NOT live here. PostgreSQL holds the reference and the metadata; the
-- unchanged recording lives in the private filesystem store, which is what MCL-49 asks
-- for ("außerhalb der relationalen Datenbank"). What this migration has to guarantee is
-- that a row can never be half of both kinds - a text row with an object key, or an
-- audio row with an original text - because either would make "the original artifact"
-- ambiguous at the one place somebody reads a child's answer.

ALTER TABLE submission_inbox DROP CONSTRAINT submission_inbox_kind_known;
ALTER TABLE submission_inbox
  ADD CONSTRAINT submission_inbox_kind_known CHECK (kind IN ('text', 'audio'));

-- An audio row has no original text. NULL rather than '' - an empty string would be a
-- claim that the child wrote nothing, which is different from not having written.
ALTER TABLE submission_inbox ALTER COLUMN original_text DROP NOT NULL;

ALTER TABLE submission_inbox
  ADD COLUMN audio_object_key   text,
  ADD COLUMN audio_mime_type    text,
  ADD COLUMN audio_file_ext     text,
  ADD COLUMN audio_byte_size    bigint,
  ADD COLUMN audio_sha256       text;

-- The other half of DROP NOT NULL. Exactly one payload per row, enforced by the
-- database rather than by whichever writer happens to be running: the POST route today,
-- an import script tomorrow, a manual psql fix at 3am.
ALTER TABLE submission_inbox ADD CONSTRAINT submission_inbox_kind_payload CHECK (
  (kind = 'text'
     AND original_text    IS NOT NULL
     AND audio_object_key IS NULL
     AND audio_mime_type  IS NULL
     AND audio_file_ext   IS NULL
     AND audio_byte_size  IS NULL
     AND audio_sha256     IS NULL)
  OR
  (kind = 'audio'
     AND original_text    IS NULL
     AND audio_object_key IS NOT NULL
     AND audio_mime_type  IS NOT NULL
     AND audio_file_ext   IS NOT NULL
     AND audio_byte_size  IS NOT NULL
     AND audio_sha256     IS NOT NULL)
);

-- The digest is what proves the stored bytes are the bytes that arrived. A value that
-- is not a SHA-256 could not prove anything, so it does not belong in the column.
ALTER TABLE submission_inbox ADD CONSTRAINT submission_inbox_audio_sha256_shape
  CHECK (audio_sha256 IS NULL OR audio_sha256 ~ '^[0-9a-f]{64}$');

-- Mirrors MAX_AUDIO_BYTES in src/application/submissions/audio-artifact.ts, for the same
-- reason the text length limits are in migration 0001: the route is not the only writer
-- this table will ever have.
ALTER TABLE submission_inbox ADD CONSTRAINT submission_inbox_audio_byte_size_bounded
  CHECK (audio_byte_size IS NULL OR (audio_byte_size > 0 AND audio_byte_size <= 8388608));

ALTER TABLE submission_inbox ADD CONSTRAINT submission_inbox_audio_object_key_shape
  CHECK (audio_object_key IS NULL OR audio_object_key ~ '^[0-9a-f]{2}/[0-9a-f]{64}\.[a-z0-9]{2,5}$');

-- The admin playback route looks a row up by submission_id, which is already the primary
-- key, so no index is added here. This one answers "show me only the recordings",
-- newest first, without reading the text rows at all.
CREATE INDEX submission_inbox_audio_recent_idx
  ON submission_inbox (received_at DESC) WHERE kind = 'audio';
```

**Step 2: Apply it locally and prove it is idempotent**

```bash
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
export MCL_TEST_DATABASE_URL="postgresql://benjaminpoersch@localhost:5432/mcl_test"
DATABASE_URL="$MCL_TEST_DATABASE_URL" npm run db:migrate
DATABASE_URL="$MCL_TEST_DATABASE_URL" npm run db:migrate
```
Expected: first run `applied 0002_submission_audio` / `applied 1 migration(s)`; second run `no pending migrations`.

**Step 3: Prove the CHECK actually refuses a half-formed row**

```bash
psql "$MCL_TEST_DATABASE_URL" -v ON_ERROR_STOP=0 -c "INSERT INTO submission_inbox (submission_id,kind,question_id,created_at,received_at,receipt_id,original_text) VALUES ('x','audio','q',now(),now(),'r','hallo');"
```
Expected: `ERROR:  new row for relation "submission_inbox" violates check constraint "submission_inbox_kind_payload"`.

**Step 4: Commit**

```bash
git add db/migrations/0002_submission_audio.sql
git commit -m "feat(MCL-49): give the inbox a place for a recording's reference and metadata"
```

---

### Task A6: Widen `InboxRecord` and `InboxEntry` to the audio union

**Files:**
- Modify: `src/application/submissions/submission-inbox-store.ts`
- Modify: `src/application/submissions/submission-inbox-reader.ts`
- Modify: `src/adapters/persistence/inbox-record-shape.ts`
- Modify: `src/adapters/persistence/file-submission-inbox-store.ts`
- Modify: `src/adapters/persistence/postgres-submission-inbox-store.ts`
- Modify: `tests/unit/submission-inbox-store-contract.ts`, `tests/unit/submission-inbox-reader-contract.ts`

This is the compiler-driven change `submission-inbox-store.ts:4-8` predicted. **Work it by running `npm run typecheck` and fixing every error it names** — that is the mechanism the comment was written for.

**Step 1: Add the failing contract cases first**

In `tests/unit/submission-inbox-store-contract.ts`, add to the shared suite:

```ts
it("stores a recording's reference and gives it back on a retry", async () => {
  const store = await createStore();
  const record = {
    kind: "audio" as const,
    receiptId: "receipt-audio-1",
    receivedAt: "2026-08-21T10:00:00.000Z",
    submissionId: "audio-submission-1",
    questionId: "companion-animal",
    createdAt: "2026-08-21T09:59:00.000Z",
    audio: {
      objectKey: `ab/${"c".repeat(64)}.webm`,
      mimeType: "audio/webm",
      fileExtension: ".webm",
      byteSize: 4096,
      sha256: "c".repeat(64),
    },
  };

  expect(await store.appendIfAbsent(record)).toEqual({ stored: true });

  const retry = await store.appendIfAbsent({ ...record, receiptId: "receipt-audio-2" });
  expect(retry.stored).toBe(false);
  // The receipt a child was already told, not the one this attempt minted.
  expect(retry.stored === false && retry.existing.receiptId).toBe("receipt-audio-1");
  expect(retry.stored === false && retry.existing.kind).toBe("audio");
});

it("keeps a recording and a written answer apart under the same question", async () => {
  const store = await createStore();
  await store.appendIfAbsent({ /* the text record already used above, id "t-1" */ } as never);
  await store.appendIfAbsent({ /* the audio record above, id "a-1" */ } as never);
  // proven through the reader contract below
});
```

In `tests/unit/submission-inbox-reader-contract.ts`, add:

```ts
it("reads a recording back as an audio entry with no original text field", async () => {
  const { reader } = await seedWithAudio();
  const page = await reader.list({ kind: "audio" });
  expect(page.total).toBe(1);
  const entry = page.entries[0];
  expect(entry.kind).toBe("audio");
  expect(entry.kind === "audio" && entry.audio.sha256).toMatch(/^[0-9a-f]{64}$/);
  // The union means this does not compile as a property access, which is the point:
  // nothing downstream can read an original text off an audio entry.
  expect(Object.hasOwn(entry, "originalText")).toBe(false);
});

it("filters recordings out of a text-only query and the other way round", async () => {
  const { reader } = await seedWithBothKinds();
  expect((await reader.list({ kind: "text" })).total).toBe(1);
  expect((await reader.list({ kind: "audio" })).total).toBe(1);
  expect((await reader.list({})).total).toBe(2);
});
```

**Step 2: Run and watch it fail**

```bash
npx vitest run tests/unit/file-submission-inbox-store.test.ts && npm run typecheck
```
Expected: FAIL — `kind: "audio"` is not assignable to `"text"`.

**Step 3: Implement the union**

`src/application/submissions/submission-inbox-store.ts` — replace `InboxRecord` with:

```ts
/** Everything both kinds of answer carry. The receipt fields are minted server-side. */
type InboxRecordBase = Readonly<{
  receiptId: string;
  receivedAt: string;
  submissionId: string;
  questionId: string;
  createdAt: string;
}>;

export type TextInboxRecord = InboxRecordBase &
  Readonly<{
    kind: "text";
    /** Unchanged original text as submitted. */
    originalText: string;
  }>;

/** The reference and the metadata. The bytes themselves are in the artifact store. */
export type AudioInboxRecord = InboxRecordBase &
  Readonly<{
    kind: "audio";
    audio: Readonly<{
      objectKey: string;
      mimeType: string;
      fileExtension: string;
      byteSize: number;
      /** Lowercase hex digest of the stored bytes, computed by this server. */
      sha256: string;
    }>;
  }>;

/**
 * One line in the inbox.
 *
 * A discriminated union, exactly as the earlier note here anticipated: widening `kind`
 * makes the compiler visit every site that has to choose, and it makes `originalText`
 * *absent* on a recording rather than empty. An empty original text would be a claim
 * the child wrote nothing, which is not the same as not having written.
 */
export type InboxRecord = TextInboxRecord | AudioInboxRecord;
```

`src/application/submissions/submission-inbox-reader.ts` — the same split for `InboxEntry`, and widen the query:

```ts
export type InboxEntryKind = "text" | "audio";
export type InboxQuery = Readonly<{
  status?: InboxEntryStatus;
  kind?: InboxEntryKind;
  questionId?: string;
  limit?: number;
}>;
```

and add a lookup the playback route needs:

```ts
export interface SubmissionInboxReader {
  list(query: InboxQuery): Promise<InboxPage>;
  /**
   * One entry by its submission id, or null.
   *
   * A separate method rather than `list({ submissionId })`: the playback route needs
   * exactly one row and must not be able to ask for a page by accident, and a filter
   * that returns "a page of one" would make the caller unwrap something that can be
   * empty, of length one, or - if the id were ever not unique - longer.
   */
  find(submissionId: string): Promise<InboxEntry | null>;
}
```

Then follow `npm run typecheck` through the two adapters and `inbox-record-shape.ts`. Key points for each:

- **`inbox-record-shape.ts`** — the JSONL parser must branch on `kind` and refuse a line that is neither, and refuse an audio line missing any audio field. The existing `readInboxRecord` already refuses unknown shapes; extend the same way, never widen it to "accept and hope".
- **`file-submission-inbox-store.ts`** — `matches()` already compares `record.kind !== query.kind`, which keeps working. `toEntry()` needs the branch. The `status` comment stays true.
- **`postgres-submission-inbox-store.ts`** — the INSERT gains the five audio columns; bind `null` for the columns the other kind does not use, so the CHECK constraint does the enforcing. The SELECT maps a row back into the right union member by its `kind` column.

**Step 4: Run everything**

```bash
export MCL_TEST_DATABASE_URL="postgresql://benjaminpoersch@localhost:5432/mcl_test"
npm run typecheck && npm run test && npm run check:integration-ran
```
Expected: PASS; the integration gate must still report `failed=0 skipped=0`.

**Step 5: Commit**

```bash
git add src/application/submissions/submission-inbox-store.ts src/application/submissions/submission-inbox-reader.ts src/adapters/persistence/ tests/unit/submission-inbox-store-contract.ts tests/unit/submission-inbox-reader-contract.ts
git commit -m "feat(MCL-49): widen the inbox from written answers to recorded ones"
```

---

### Task A6b: The JSONL importer must not drop recordings (trap T2)

**Files:**
- Modify: `scripts/import-inbox-jsonl.mjs`
- Modify: `tests/integration/import-inbox-jsonl.test.ts`

`scripts/import-inbox-jsonl.mjs:146-148` refuses any line whose `kind` is not `"text"`, and its own comment says MCL-49 must revisit it deliberately. `toValues` binds exactly seven columns.

**Step 1: Failing test first** — add a case to `tests/integration/import-inbox-jsonl.test.ts` that writes one text line and one audio line into a JSONL file, imports it, and asserts **two** rows land in `submission_inbox` with the audio row's five audio columns populated and its `original_text` NULL.

**Step 2: Run it**

```bash
export MCL_TEST_DATABASE_URL="postgresql://benjaminpoersch@localhost:5432/mcl_test"
npx vitest run tests/integration/import-inbox-jsonl.test.ts
```
Expected: FAIL — the audio line is refused / only one row imported.

**Step 3: Widen the importer** — accept both kinds, bind twelve columns, and keep the existing behaviour of *refusing* (not silently skipping) a line that is neither. The importer's job is to report what it applied; a line it cannot read must still be a loud failure.

**Step 4: Commit**

```bash
git add scripts/import-inbox-jsonl.mjs tests/integration/import-inbox-jsonl.test.ts
git commit -m "fix(MCL-49): stop the JSONL cutover importer from dropping recordings"
```

---

### Task A7: Wire the artifact store into the composition root

**Files:**
- Modify: `src/composition/server.ts`
- Modify: `.env.example`
- Test: `tests/unit/composition-audio-store.test.ts`

**Step 1: Write the failing test**

```ts
/**
 * The composition root is the only module allowed to read the environment, so it is the
 * only place these two rules can be proven: a blank AVALORIA_MEDIA_DIR is unset (not an
 * empty path handed to mkdir), and the audio limiter is its own bucket rather than a
 * second name for the inbox one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("audio artifact store selection", () => {
  it("falls back to .data/media when the variable is blank, not to an empty path", async () => {
    vi.stubEnv("AVALORIA_MEDIA_DIR", "   ");
    vi.resetModules();
    const { createAudioArtifactStore } = await import("@/composition/server");
    expect((createAudioArtifactStore() as { rootDirectory: string }).rootDirectory).toBe(".data/media");
  });

  it("uses the configured directory when one is set", async () => {
    vi.stubEnv("AVALORIA_MEDIA_DIR", "/data/media");
    vi.resetModules();
    const { createAudioArtifactStore } = await import("@/composition/server");
    expect((createAudioArtifactStore() as { rootDirectory: string }).rootDirectory).toBe("/data/media");
  });

  it("gives audio uploads their own rate limiter, not the inbox one", async () => {
    const { createAudioInboxRateLimiter, createProtectedRouteRateLimiter, resetRateLimitersForTest } =
      await import("@/composition/server");
    resetRateLimitersForTest();
    expect(createAudioInboxRateLimiter()).not.toBe(createProtectedRouteRateLimiter());
    // And it is a singleton, like every other limiter in this module.
    expect(createAudioInboxRateLimiter()).toBe(createAudioInboxRateLimiter());
  });
});
```

**Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/composition-audio-store.test.ts
```
Expected: FAIL — `createAudioArtifactStore` is not exported.

**Step 3: Implement** — in `src/composition/server.ts`:

```ts
const DEFAULT_MEDIA_DIRECTORY = ".data/media";

/**
 * Where original recordings are kept (MCL-49).
 *
 * A filesystem directory rather than an object storage client, and that is a decision,
 * not a placeholder: MLOA page 12 records that the MVP does not require a cloud object
 * store, and the container already bind-mounts a persistent volume. The port is what
 * makes a later provider a swap here and nothing else.
 *
 * `||` rather than `??`, for the same reason AVALORIA_INBOX_DIR uses it: a host that
 * defines the variable and leaves it empty would otherwise hand mkdir an empty path,
 * and every recording would fail while the site and its health check still look fine.
 */
export function createAudioArtifactStore(): AudioArtifactStore & AudioArtifactReader {
  return new FileAudioArtifactStore(
    process.env.AVALORIA_MEDIA_DIR?.trim() || DEFAULT_MEDIA_DIRECTORY,
  );
}

let audioInboxLimiter: RateLimiter | null = null;

/**
 * Its own bucket, well below the text inbox's.
 *
 * One 8 MiB upload is roughly two hundred and seventy text submissions' worth of bytes.
 * Sharing the inbox allowance (30/min) would permit about 240 MiB of writes a minute
 * onto a VPS whose disk was last measured at 78 % full - so the ceiling that matters
 * here is not requests, it is volume.
 */
export function createAudioInboxRateLimiter(): RateLimiter {
  audioInboxLimiter ??= new InMemoryRateLimiter({
    limit: positiveInteger(process.env.AVALORIA_AUDIO_RATE_LIMIT, 10),
    windowMs: positiveInteger(process.env.AVALORIA_AUDIO_RATE_WINDOW_MS, 60_000),
  });
  return audioInboxLimiter;
}
```

Add `audioInboxLimiter = null;` to `resetRateLimitersForTest()`.

Append to `.env.example`:

```bash
# Optional. Where original recordings are kept (MCL-49). A private directory, never
# served by a web server and never inside the build output. In production this is the
# already-bind-mounted persistent volume: AVALORIA_MEDIA_DIR=/data/media
# AVALORIA_MEDIA_DIR=.data/media

# Optional. Audio uploads get their own, much smaller allowance than the text inbox -
# one upload is up to 8 MiB, and the ceiling that matters is volume, not requests.
# AVALORIA_AUDIO_RATE_LIMIT=10
# AVALORIA_AUDIO_RATE_WINDOW_MS=60000
```

Add `.data/` is already git-ignored — verify with `git check-ignore -v .data/media` and record the answer.

**Step 4: Run**

```bash
npx vitest run tests/unit/composition-audio-store.test.ts && npm run test:architecture
```
Expected: PASS both. The architecture test must stay green — `AVALORIA_MEDIA_DIR` is not a secret, so it needs no entry in the secret list, but it *must* only be named in `server.ts`.

**Step 5: Commit**

```bash
git add src/composition/server.ts .env.example tests/unit/composition-audio-store.test.ts
git commit -m "feat(MCL-49): wire the private recording store into the composition root"
```

---

### Task A8: The upload route

**Files:**
- Create: `src/app/api/inbox/submissions/audio/route.ts`
- Modify: `src/adapters/http/bounded-json-body.ts` (add `readBoundedBytes`)
- Test: `tests/unit/audio-inbox-route.test.ts`, `tests/unit/bounded-json-body.test.ts`

**Step 1: Write the failing route tests**

`tests/unit/audio-inbox-route.test.ts` — the cases that must exist (write them all before implementing):

```ts
/**
 * The audio write path (MCL-49). What these cases pin, in order of how badly each one
 * would hurt if it broke:
 *
 *  1. An unauthorised caller cannot make this route read one byte of a body.
 *  2. A type that is not on the allowlist is refused before anything is written.
 *  3. Bytes past the cap are abandoned mid-stream, not buffered and then rejected.
 *  4. The receipt is minted here and is never read from the request.
 *  5. A retry of the same submissionId gets the receipt it already has - never a second.
 *  6. The stored digest is of the bytes that actually arrived.
 */
```

Required cases:

| # | Given | Expect |
|---|---|---|
| 1 | no session cookie | `401 {"acknowledged":false,"error":"unauthorized"}`, and `request.body` was never read |
| 2 | valid session, `content-type: text/html` | `400 invalid-payload`, nothing written to the artifact store |
| 3 | valid session, `content-type: audio/webm;codecs=opus` | accepted — the parameter is dropped, not refused |
| 4 | `content-length` above `MAX_AUDIO_BYTES` | `400 invalid-payload` before the body is read |
| 5 | chunked body that exceeds the cap mid-stream | `400 invalid-payload`, stream cancelled |
| 6 | empty body | `400 invalid-payload` |
| 7 | missing `x-avaloria-submission-id` | `400 invalid-payload` |
| 8 | `x-avaloria-question-id` naming a question that does not exist | `400 invalid-payload` (decision D11) |
| 9 | `x-avaloria-created-at` = `"0000-01-01T00:00:00Z"` | `400 invalid-payload` (year outside 1..9999) |
| 10 | valid request | `201`, body `{acknowledged:true, receiptId, receivedAt}`, artifact present in the store, inbox record `kind:"audio"` with `sha256` equal to `createHash("sha256").update(bytes)` |
| 11 | the identical request repeated | `200` with the **first** `receiptId`, and the artifact written once |
| 12 | artifact store throws a generic error | `503 inbox-unavailable`, and **no** inbox row is written |
| 13 | artifact store throws `AudioArtifactError` | `400 invalid-payload` |
| 14 | inbox store throws after the artifact was written | `503 inbox-unavailable` — orphan blob is acceptable, a row pointing at nothing is not |
| 15 | rate limit exhausted | `429 too-many-requests` |
| 16 | no family access code configured | `503 inbox-unavailable` |
| 17 | every response body | contains only `acknowledged`/`error`/`receiptId`/`receivedAt` — no path, no stack, no message |

Use `familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE)` from `tests/support/family-session-header.ts` and `resetRateLimitersForTest()` in `beforeEach`, matching `tests/unit/inbox-route.test.ts`.

**Step 2: Run and watch them fail**

```bash
npx vitest run tests/unit/audio-inbox-route.test.ts
```
Expected: FAIL — route module not found.

**Step 3: Add `readBoundedBytes`** to `src/adapters/http/bounded-json-body.ts`

Refactor `readBoundedBody` so both callers share one streaming cap:

```ts
/**
 * Reads the body with a hard byte cap and returns the raw bytes.
 *
 * Extracted from readBoundedBody so the audio route gets exactly the same streaming
 * guarantee the JSON routes have - an oversized body is abandoned mid-stream and never
 * fully held in memory - without a decode step. Audio must survive byte for byte, so
 * there is nothing here to decode.
 */
export async function readBoundedBytes(
  request: Request,
  maxBodyBytes: number,
): Promise<Uint8Array | null> { /* the existing loop, returning `merged` */ }
```

and have `readBoundedBody` call it and then do the strict UTF-8 decode. Add a test in `tests/unit/bounded-json-body.test.ts` proving `readBoundedBytes` returns null and cancels the stream past the cap.

**Step 4: Implement the route** (`src/app/api/inbox/submissions/audio/route.ts`)

```ts
import { createHash } from "node:crypto";
import { declaresAcceptableSize, readBoundedBytes } from "@/adapters/http/bounded-json-body";
import { guardFamilyRequest } from "@/adapters/http/family-request-guard";
import {
  MAX_AUDIO_BYTES,
  audioExtensionFor,
  normaliseAudioMimeType,
} from "@/application/submissions/audio-artifact";
import { AudioArtifactError } from "@/application/submissions/audio-artifact-store";
import {
  SubmissionPayloadError,
  type AudioInboxRecord,
} from "@/application/submissions/submission-inbox-store";
import {
  createAudioArtifactStore,
  createAudioInboxRateLimiter,
  createFamilyAccessGate,
  createReceiptId,
  createSubmissionInboxStore,
} from "@/composition/server";
import { isAnsweredQuestionId } from "@/content/open-questions";

/**
 * A child sending a recorded answer (MCL-49 / MCL-30).
 *
 * Its own route rather than a branch inside the text one. Two reasons, and the second is
 * the load-bearing one:
 *
 *  - The bodies are nothing alike. This one is raw bytes with a hard cap and no
 *    decoding at all, because the recording has to survive byte for byte; the text route
 *    parses JSON after a strict UTF-8 decode. Folding them together would mean one
 *    handler choosing which set of guards applies from a header - and a guard chosen by
 *    the caller is not a guard.
 *  - The identifiers ride in `x-avaloria-*` request headers. That is not decoration: a
 *    custom header makes a cross-origin request non-simple, so a browser must preflight
 *    it, and a form-post from another site cannot reach this route at all. The text
 *    route gets the same property from its required application/json content type.
 *
 * The bytes are written before the inbox row, never after. An inbox row must not be able
 * to reference a recording that is not on disk; the opposite failure - a stored
 * recording with no row - is harmless and self-heals, because the store is
 * content-addressed and a retry writes the identical key.
 */

const SUBMISSION_ID_HEADER = "x-avaloria-submission-id";
const QUESTION_ID_HEADER = "x-avaloria-question-id";
const CREATED_AT_HEADER = "x-avaloria-created-at";

const MAX_IDENTIFIER_LENGTH = 200;
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

type AudioInboxError = "invalid-payload" | "unauthorized" | "too-many-requests" | "inbox-unavailable";

/** Machine-readable codes only - never an exception message, path or stack trace. */
function refuse(status: 400 | 401 | 429 | 503, error: AudioInboxError): Response {
  return Response.json({ acknowledged: false, error }, { status });
}

function readIdentifier(request: Request, header: string): string | null {
  const value = request.headers.get(header);
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IDENTIFIER_LENGTH) return null;
  // A header value is latin-1 on the wire, so a lone surrogate cannot arrive here the
  // way it can in JSON - but a NUL can, and PostgreSQL refuses it outright (22021).
  if (trimmed.includes(" ") || !trimmed.isWellFormed()) return null;
  return trimmed;
}

function isStorableInstant(value: string): boolean {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const year = new Date(parsed).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

export async function POST(request: Request): Promise<Response> {
  // From headers alone, before a byte of the body is read - an 8 MiB body is exactly
  // what an unauthorised caller must not be able to make this server buffer.
  const access = guardFamilyRequest(
    request,
    createFamilyAccessGate(),
    createAudioInboxRateLimiter(),
  );

  if (access === "unavailable") {
    console.error("family access gate unavailable: no access code configured");
    return refuse(503, "inbox-unavailable");
  }
  if (access === "unauthorized") return refuse(401, "unauthorized");
  if (access === "rate-limited") return refuse(429, "too-many-requests");

  const mimeType = normaliseAudioMimeType(request.headers.get("content-type") ?? "");
  const fileExtension = audioExtensionFor(mimeType);
  if (fileExtension === null) return refuse(400, "invalid-payload");

  if (!declaresAcceptableSize(request, MAX_AUDIO_BYTES)) return refuse(400, "invalid-payload");

  const submissionId = readIdentifier(request, SUBMISSION_ID_HEADER);
  const questionId = readIdentifier(request, QUESTION_ID_HEADER);
  const createdAt = readIdentifier(request, CREATED_AT_HEADER);

  if (submissionId === null || questionId === null || createdAt === null) {
    return refuse(400, "invalid-payload");
  }
  if (!isStorableInstant(createdAt)) return refuse(400, "invalid-payload");

  // MCL-35 makes closing a question an operation rather than a redeploy, and a closed
  // question must stop collecting answers - including from a client that has been open
  // since before it closed and is retrying a locally held submission.
  if (!(await isAnsweredQuestionId(questionId))) return refuse(400, "invalid-payload");

  const bytes = await readBoundedBytes(request, MAX_AUDIO_BYTES);
  if (bytes === null || bytes.byteLength === 0) return refuse(400, "invalid-payload");

  // Computed here, from what actually arrived. A digest a client sends is a digest that
  // proves nothing.
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  let objectKey: string;

  try {
    ({ objectKey } = await createAudioArtifactStore().putIfAbsent(
      { sha256, mimeType, fileExtension, byteSize: bytes.byteLength },
      bytes,
    ));
  } catch (cause) {
    if (cause instanceof AudioArtifactError) {
      console.error("audio artifact store refused the recording", cause);
      return refuse(400, "invalid-payload");
    }
    console.error("audio artifact store failed", cause);
    return refuse(503, "inbox-unavailable");
  }

  const record: AudioInboxRecord = {
    kind: "audio",
    submissionId,
    questionId,
    createdAt,
    receiptId: createReceiptId(),
    receivedAt: new Date().toISOString(),
    audio: { objectKey, mimeType, fileExtension, byteSize: bytes.byteLength, sha256 },
  };

  let outcome: Awaited<ReturnType<ReturnType<typeof createSubmissionInboxStore>["appendIfAbsent"]>>;

  try {
    outcome = await createSubmissionInboxStore().appendIfAbsent(record);
  } catch (cause) {
    if (cause instanceof SubmissionPayloadError) {
      console.error("inbox append refused the recording metadata", cause);
      return refuse(400, "invalid-payload");
    }
    console.error("inbox append failed for a recording", cause);
    return refuse(503, "inbox-unavailable");
  }

  const acknowledged = outcome.stored ? record : outcome.existing;
  return Response.json(
    {
      acknowledged: true,
      receiptId: acknowledged.receiptId,
      receivedAt: acknowledged.receivedAt,
    },
    { status: outcome.stored ? 201 : 200 },
  );
}
```

> `isAnsweredQuestionId` is introduced in Story C (task C3). **Until Story C lands, replace that call with the synchronous catalogue check** `openQuestions.some((q) => q.id === questionId)` and leave a `// MCL-35 replaces this with the durable overlay` comment. Do not leave the route with no question check at all.

**Step 5: Run**

```bash
npx vitest run tests/unit/audio-inbox-route.test.ts tests/unit/bounded-json-body.test.ts
```
Expected: PASS (17 cases + the bounded-bytes cases).

**Step 6: Commit**

```bash
git add src/app/api/inbox/submissions/audio/route.ts src/adapters/http/bounded-json-body.ts tests/unit/audio-inbox-route.test.ts tests/unit/bounded-json-body.test.ts
git commit -m "feat(MCL-49): accept a child's recording and acknowledge it only once it is stored"
```

---

### Task A9: Text route refuses answers to questions that do not exist

**Files:**
- Modify: `src/app/api/inbox/submissions/route.ts`
- Modify: `tests/unit/inbox-route.test.ts`

Same rule as A8's `questionId` check, applied to the text path. Failing test first: a POST with `questionId: "does-not-exist"` currently gets `201`; it must get `400 invalid-payload`.

**Commit**

```bash
git commit -m "fix(MCL-49): stop accepting answers to questions this project never asked"
```

---

### Task A10: The admin playback route

**Files:**
- Create: `src/app/api/admin/inbox/submissions/[submissionId]/audio/route.ts`
- Test: `tests/unit/admin-audio-route.test.ts`

**Required cases (write first):**

| # | Given | Expect |
|---|---|---|
| 1 | no admin cookie | `401`, no bytes |
| 2 | a valid **family** session under the admin cookie name | `401` — the MCL-50 separation, re-proven on this route |
| 3 | valid admin session, unknown `submissionId` | `404` |
| 4 | valid admin session, a **text** submission's id | `404` — there is no recording to play |
| 5 | valid admin session, a stored recording | `200`; body bytes identical to what was uploaded |
| 6 | the same | `content-type` is the allowlisted stored type; `x-content-type-options: nosniff`; `content-security-policy` contains `sandbox`; `cache-control` is `private, no-store` |
| 7 | a row whose object is missing from disk | `404`, and a `console.error` naming the inconsistency |
| 8 | `POST` to the same path | `405` (no POST export) |
| 9 | rate limit exhausted | `429` |
| 10 | no admin code configured | `503` |

**Implementation sketch:**

```ts
export async function GET(
  request: Request,
  context: { params: Promise<{ submissionId: string }> },
): Promise<Response> {
  const access = guardAdminRequest(request, createAdminAccessGate(), createAdminRouteRateLimiter());
  // ... the four-way outcome, exactly as the admin inbox route does it

  const { submissionId } = await context.params;
  const entry = await createSubmissionInboxReader().find(submissionId);

  // Both "no such submission" and "that one is written, not spoken" are 404. The
  // distinction is real but it is not the caller's business: an admin surface that
  // answered them differently would confirm the existence of ids to anyone who reached
  // it, and there is no reason for this route to be an oracle.
  if (entry === null || entry.kind !== "audio") return new Response(null, { status: 404 });

  const artifact = await createAudioArtifactStore().read(entry.audio.objectKey);
  if (artifact === null) {
    // The row promised a recording the disk does not have. Logged as an error because
    // it is one: nothing in the write path can produce this, so it means the volume
    // changed under the database.
    console.error("inbox row references a recording that is not stored", entry.audio.objectKey);
    return new Response(null, { status: 404 });
  }

  return new Response(artifact.bytes, {
    status: 200,
    headers: {
      // From the closed allowlist the upload matched, so it can never be text/html or a
      // script type. That, plus nosniff, is what "not delivered as executable web
      // content" means here - and serving the real audio type is also the only way an
      // adult can actually listen, which is the point of the protected read.
      "content-type": entry.audio.mimeType,
      "content-length": String(artifact.byteSize),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // A child's voice is not something a shared proxy should keep.
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="antwort-${entry.submissionId}${entry.audio.fileExtension}"`,
    },
  });
}
```

**Commit**

```bash
git commit -m "feat(MCL-49): let an authorised adult listen to a recording, and nobody else"
```

---

### Task A11: The admin inbox shows and plays recordings

**Files:**
- Modify: `src/app/api/admin/inbox/submissions/route.ts` (widen `KNOWN_KINDS` to `["text","audio"]`)
- Modify: `src/app/admin-inbox-query.ts` (`kind: "" | "text" | "audio"`)
- Modify: `src/app/components/admin-inbox-view.tsx` (render an audio entry: an `<audio controls>` pointing at the playback route, plus size, type and the first 12 characters of the digest)
- Modify: `src/application/submissions/admin-inbox-client.ts`, `src/adapters/http/http-admin-inbox-client.ts` (the union)
- Test: `tests/unit/admin-inbox-route.test.ts`, `tests/unit/admin-inbox-query.test.ts`, `tests/unit/http-admin-inbox-client.test.ts`

**Exactly where this lands.** `src/app/components/admin-inbox-view.tsx:280-313` renders `<section aria-label="Originaltext">{entry.originalText}</section>` and a `<dl aria-label="Systemangaben">` carrying Frage / Art / Status / Geschrieben am / Eingegangen am / Quittung / Einsendung, with `<dd>{entry.kind}</dd>` printing the kind raw. **An audio entry would render an empty `Originaltext` box** unless this component changes in the same slice.

**What the audio row must show** (this is what makes sprint claim G2 true): in the *original artifact* region an `<audio controls>` pointing at the playback route — never an empty paragraph; in *Systemangaben* the object key, MIME type, byte size and SHA-256 alongside the existing fields. The **original / system-derived separation MCL-50 established stays intact** — that separation is itself an MCL-50 acceptance criterion, and this sprint is the first one that puts audio behind it.

**Commit**

```bash
git commit -m "feat(MCL-49): show recordings in the protected inbox and let an adult play them"
```

---

### Task A12: Readiness reports storage writability

**Files:**
- Modify: `src/app/api/health/ready/route.ts`
- Test: `tests/unit/health-ready-route.test.ts`, `tests/integration/health-ready-route.test.ts`

MLOA page 12 makes this an explicit runtime gate: *"Readiness unterscheidet mindestens Anwendung, PostgreSQL und Storage-Schreibbarkeit."*

The response gains `mediaStorage: "ok" | "unavailable"`. `503` when it is `unavailable`, matching how `database: "unavailable"` behaves. `/api/health` stays 200 regardless — that rule does not change.

**Commit**

```bash
git commit -m "feat(MCL-49): make readiness tell the truth about the recording store too"
```

---

### Task A13: Documentation, foundation list, and the honest gaps

**Files:**
- Modify: `scripts/check-foundation.mjs` — append the five new load-bearing paths (`src/application/submissions/audio-artifact.ts`, `src/application/submissions/audio-artifact-store.ts`, `src/adapters/persistence/file-audio-artifact-store.ts`, `src/app/api/inbox/submissions/audio/route.ts`, `db/migrations/0002_submission_audio.sql`) **and the eleven MCL-50 files the list never gained** (trap T10): `src/app/admin/page.tsx`, `src/app/api/admin/session/route.ts`, `src/app/api/admin/inbox/submissions/route.ts`, `src/app/components/admin-access-gate.tsx`, `src/app/components/admin-inbox-view.tsx`, `src/adapters/http/admin-request-guard.ts`, `src/adapters/http/admin-session-cookie.ts`, `src/adapters/http/http-admin-inbox-client.ts`, `src/application/submissions/submission-inbox-reader.ts`, `src/app/world-routes.ts`, `src/app/api/health/route.ts`. Count the resulting list **from the file**, not from `CLAUDE.md` — it says 52 and the list holds 56 today.
- Modify: `tests/architecture/boundaries.test.ts` — add the rule that does not exist (trap T9): nothing under `src/adapters` may import `next` or `react`. `src/adapters/media/audio-capture-controller.ts` is 471 lines of browser-facing code with no boundary rule over it at all today.
- Modify: `CLAUDE.md` — correct the stale "52 required paths" to the measured count
- Create: `docs/ops/MCL-49-audio-storage.md`
- Modify: `docs/deploy/vps-mc-legends.md` — a new section: create `/opt/mc-legends/data/media` mode `0700`, set `AVALORIA_MEDIA_DIR=/data/media` in `app.env`, and the A0 disk reading
- Modify: `docs/ops/MCL-48-backup-restore.md` — the **second backup stream** for blobs that :528 says is missing
- Modify: `SECURITY.md` — record that the allowlist and size cap it pre-committed to at :8 now exist, and where

`docs/ops/MCL-49-audio-storage.md` must state plainly, in the project's own honest register:

- where the bytes are (`/data/media` inside the container = `/opt/mc-legends/data/media` on the host, mode `0700`, files `0600`);
- that the store is content-addressed and write-once, and what that means for deletion (deleting one submission's row does **not** delete the object if another row shares the digest);
- that **retention and deletion policy do not exist** (flag F3) and that this is a product/privacy decision, not a technical one;
- that `pg_dump` does **not** cover these files, and the `rsync`/`tar` stream that does;
- the disk budget from A0 and the number of maximum-size recordings it allows;
- that the file store's idempotency is **process-local**, per `AGENTS.md:17`, and that content-addressing is what makes a race harmless here — not locking.

**Commit**

```bash
git commit -m "docs(MCL-49): write down where recordings live, what backs them up, and what is still undecided"
```

---

### Task A14: Story A gate

```bash
git checkout -- AGENTS.md next-env.d.ts 2>/dev/null || true
source ~/.nvm/nvm.sh && nvm use
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
export MCL_TEST_DATABASE_URL="postgresql://benjaminpoersch@localhost:5432/mcl_test"
DATABASE_URL="$MCL_TEST_DATABASE_URL" npm run db:migrate
npm run verify
npm run test && npm run check:integration-ran
AVALORIA_FAMILY_ACCESS_CODE=local-canary-family-1 AVALORIA_SESSION_SECRET=local-canary-secret-1 AVALORIA_ADMIN_ACCESS_CODE=local-canary-admin-1 npm run build
AVALORIA_FAMILY_ACCESS_CODE=local-canary-family-1 AVALORIA_SESSION_SECRET=local-canary-secret-1 AVALORIA_ADMIN_ACCESS_CODE=local-canary-admin-1 npm run check:client-secrets
rm -rf .data && E2E_PORT=3199 npx playwright test
git checkout -- AGENTS.md next-env.d.ts
git status --porcelain    # must be empty apart from CLAUDE.md
```

Record each as `PASS` / `FAIL` / `not_run: <reason>`. Then open the PR:

```bash
git push -u origin feat/MCL-49-private-audio-artifact-store
gh pr create --title "MCL-49: original audio in private durable storage" --body "$(cat <<'EOF'
## What

The server side of a recorded answer: a private, content-addressed, write-once artifact
store; audio metadata in PostgreSQL under a payload CHECK constraint; a family-gated
upload route that acknowledges only after the bytes are on disk; an admin-gated playback
route; and readiness that reports storage writability.

## Evidence

<paste the A14 gate table>

## Still open, deliberately

- Retention/deletion policy for children's recordings (MCL-49 Out of Scope, see docs/ops/MCL-49-audio-storage.md).
- Blob backup stream is documented but the schedule is not running (docs/ops/MCL-48-backup-restore.md).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Story B — MCL-30B: the child actually sends the recording

**Branch:** `feat/MCL-30-send-audio-answer` off Story A's merge commit.

**Jira AC being satisfied** — MCL-30's first six criteria are already met by MCL-30A (verified: `tests/e2e/audio-capture.spec.ts` covers states, start/stop wording, playback before sending, discard and re-record, the file fallback, and jargon-free error text). This story closes the seventh: *"Originalaudio bleibt unverändert gespeichert"* — plus the send action the story title names.

### Task B1: The delivery port and its HTTP adapter

**Files:**
- Create: `src/application/submissions/audio-submission-inbox.ts`
- Create: `src/adapters/http/http-audio-submission-inbox.ts`
- Test: `tests/unit/http-audio-submission-inbox.test.ts`

The port mirrors `SubmissionInbox` exactly, including the `transport | refused` distinction that `SubmissionInboxError` already carries — reuse that error class rather than inventing a second one:

```ts
export interface AudioSubmissionInbox {
  /**
   * Resolves with a receipt only on a real positive acknowledgement.
   *
   * The bytes travel as a second argument rather than inside the submission, because a
   * domain object must not carry a Blob: the same AudioSubmission is what IndexedDB
   * stores, what the list renders and what a retry re-sends, and only one of those three
   * needs the recording in hand.
   */
  deliver(submission: AudioSubmission, recording: Blob): Promise<ServerReceipt>;
}
```

Adapter cases to pin: `201` and `200` both yield a receipt; `400` throws `SubmissionInboxError("refused")`; `401`/`429`/`503`/network failure throw `SubmissionInboxError("transport")`; the three `x-avaloria-*` headers carry the identifiers; the `content-type` is the blob's own type; the body is the blob unmodified.

### Task B2: Local blob persistence

**Files:**
- Create: `src/application/submissions/audio-blob-repository.ts` (port)
- Create: `src/adapters/persistence/indexeddb-audio-blob-repository.ts`
- Test: `tests/unit/indexeddb-audio-blob-repository.test.ts` (`import "fake-indexeddb/auto"` as the **first line**, matching `tests/unit/indexeddb-submission-repository.test.ts`)

**Verify first**, before writing the adapter: `fake-indexeddb` must round-trip a `Blob`. Write that as the first test and run it. If it does not, record the finding and fall back to storing an `ArrayBuffer` plus the MIME type, reconstructing the Blob on read — and say so in a comment.

The port:

```ts
export interface AudioBlobRepository {
  save(id: SubmissionId, recording: Blob): Promise<void>;
  find(id: SubmissionId): Promise<Blob | null>;
  /** Called once a receipt exists: the server holds the original now, this copy is a cache. */
  remove(id: SubmissionId): Promise<void>;
}
```

> Removing the local copy after acknowledgement is deliberate and must be commented: the project rule is that the **server** holds the immutable original. Keeping a second copy in a child's browser forever is storage the child never asked for, and it is not the artifact anyone will read.

### Task B3: `SubmissionRepository` holds both kinds

**Files:** `src/application/submissions/submission-repository.ts`, `src/adapters/persistence/indexeddb-submission-repository.ts`, their tests.

`save(submission: Submission)`, `findById(): Promise<Submission | null>`, `list(): Promise<readonly Submission[]>`. Follow `npm run typecheck`.

### Task B4: `deliverSubmission` becomes kind-agnostic

**Files:** `src/application/submissions/deliver-submission.ts`, `tests/unit/deliver-submission.test.ts`

Add `deliverAudioSubmission(submission, recording, repository, audioBlobs, inbox)` beside the existing function rather than overloading it — the audio path has one extra step (drop the local blob on success) and one extra failure mode, and a single function with a branch on `kind` would make the text path carry both.

New cases: a successful delivery removes the local blob; a failed delivery keeps it; a local-save failure after a real receipt still reports `local-save` and keeps the blob.

### Task B5: `childMessageFor` speaks about recordings too

**Files:** `src/app/child-submission-message.ts`, `tests/unit/child-submission-message.test.ts`

Make it generic over `Submission`. Every string stays German, child-safe, and must pass `expectChildSafe` — add that assertion to the message test if it is not already there.

### Task B6: The send button

**Files:**
- Modify: `src/app/components/audio-answer-recorder.tsx` — takes `questionId: string` and `onDelivered: () => void` props; adds an "Antwort abschicken" button, enabled only when `state.recording !== null`; replaces the "Abschicken kannst du sie noch nicht" note with the truthful one; shows the delivery message via `childMessageFor`.
- Modify: `src/app/audio-capture-message.ts` — the new sentences, still as `satisfies Record<…>` total tables.
- Modify: `src/app/family-experience.tsx` — pass `questionId={question.id}` and refresh the list on delivery; render audio entries in "Meine Ideen".
- Modify: `src/composition/browser.ts` — `createBrowserAudioSubmissionInbox()`, `createBrowserAudioBlobRepository()`.

**Do not remove** the MCL-30A honesty note wholesale — rewrite it. Before sending, a recording genuinely is only on this device; after a receipt it genuinely arrived. Both sentences must exist.

### Task B6b: A ceiling on what a child can pick, before it becomes an object URL (trap T12)

**Files:** `src/adapters/media/audio-capture-controller.ts`, `src/app/audio-capture-message.ts`, their tests.

Today there is **no size ceiling anywhere in the capture path**: `chooseFile` accepts a file of any size and hands it straight to `createPreviewUrl` (`audio-capture-controller.ts:151-157, 409-418`). On a tablet that is a tab crash with no entry in the failure taxonomy — and now it is also an upload that the server would refuse after the child waited for it.

**Step 1: Failing test first** — a chosen file of `MAX_AUDIO_BYTES + 1` must produce failure reason `"file-too-large"` and **no** preview URL.

**Step 2: Implement** — add `"file-too-large"` to `AudioCaptureFailureReason`. Because `failureMessages` in `audio-capture-message.ts:29-39` is `as const satisfies Record<AudioCaptureFailureReason, string>`, the missing German sentence is a **compile error**, not a blank line on the page. That is the mechanism; use it.

The sentence must be child-safe and name no byte count in technical form and no word like `Upload`. Proposed: *"Diese Tondatei ist zu lang. Nimm bitte etwas Kürzeres auf oder such eine kleinere Datei aus."*

The controller must not import the application layer, so `MAX_AUDIO_BYTES` is passed in through `AudioCaptureEnvironment` or the constructor rather than imported — check `tests/architecture/boundaries.test.ts` after the new `src/adapters` rule from A13 lands.

**Step 3: Commit**

```bash
git commit -m "fix(MCL-30): refuse a recording too big to send before it costs the tablet its memory"
```

---

### Task B7: Real browser journeys

**File:** `tests/e2e/audio-delivery.spec.ts`, reusing the `stubMedia` helper pattern from `tests/e2e/audio-capture.spec.ts`.

| Journey | Steps | Assertion |
|---|---|---|
| **J2 — a child sends a recording** | sign in → record → stop → play → "Antwort abschicken" | the list shows **exactly** `Im Projekt angekommen`; a `POST /api/inbox/submissions/audio` returned 201 (assert via `page.on("response")`) |
| **J2b — it survives a reload** | reload after J2 | still listed, still `Im Projekt angekommen`, no re-send |
| **J3 — the send fails** | `page.route("**/api/inbox/submissions/audio", r => r.abort())` → record → send | the child reads a retry-inviting sentence, the entry is `Nur auf diesem Gerät gespeichert`, and a retry after `unroute` succeeds |
| **J4 — no microphone** | `stubMedia(page, "absent")` → choose a file → send | arrives; the child is never shown a browser error name |
| **J-safe** | the whole page text after each of the above | `expectChildSafe(await page.locator("main").innerText(), …)` |

### Task B8: Story B gate + PR

Same command block as A14. Add `src/app/components/audio-answer-recorder.tsx` is already in `tests/architecture/boundaries.test.ts:126` — **verify it is still there** and add any new client component. Append new load-bearing files to `scripts/check-foundation.mjs`.

```bash
git commit -m "feat(MCL-30): let a child send the answer they recorded, and say so only when it arrived"
```

---

## Story C — MCL-35: close, rotate and archive open questions

**Branch:** `feat/MCL-35-question-rotation` off Story B's merge commit.

**Jira AC** (verbatim) and where each is met:
- berechtigte Projekt-/Adminseite kann Frage schließen → C4, C5
- geschlossene Frage verschwindet aus aktiver Rotation → C2, C6
- nächste offene Frage erscheint → C2, C6
- Frage kann wieder geöffnet werden → C4, C5
- beantwortete Fragen bleiben nachvollziehbar archiviert → C5 (admin archive list with answer counts)
- Kinderoberfläche zeigt keine Adminbegriffe → C6 + `expectChildSafe`

**Test First / Acceptance Evidence** (verbatim from MCL-35): *GIVEN Frage A ist aktiv und Frage B offen, WHEN Frage A als abgeschlossen markiert wird, THEN wird Frage B zur aktiven Frage AND Frage A bleibt im Archiv vorhanden.* — that is e2e journey **J7** in C8.

### Task C1: The question state ports and two adapters

**Files:**
- Create: `src/application/questions/question-state-store.ts`
- Create: `src/adapters/persistence/file-question-state-store.ts`
- Create: `src/adapters/persistence/postgres-question-state-store.ts`
- Create: `db/migrations/0003_question_state.sql`
- Create: `tests/unit/question-state-store-contract.ts`, `tests/unit/file-question-state-store.test.ts`, `tests/integration/postgres-question-state-store.test.ts`

```ts
export type QuestionLifecycle = "open" | "closed";

export type QuestionStateRecord = Readonly<{
  questionId: string;
  state: QuestionLifecycle;
  /** When it last changed. What makes an archive an archive rather than a list. */
  changedAt: string;
}>;

export interface QuestionStateStore {
  /** Idempotent: setting a state it already has is not an error and not a second row. */
  setState(record: QuestionStateRecord): Promise<void>;
}

export interface QuestionStateReader {
  list(): Promise<readonly QuestionStateRecord[]>;
}
```

Migration `0003`:

```sql
-- 0003_question_state.sql
-- The lifecycle of an open question (MCL-35).
--
-- Deliberately an OVERLAY and not a copy of the questions. The wording lives in
-- src/content/open-questions.ts and is the only place it may live: nothing on this
-- website is invented for it, and a second copy in a database is exactly how a question
-- starts drifting from the decision it restates. This table holds one thing per
-- question - whether the project is still asking it.

CREATE TABLE question_state (
  question_id text        PRIMARY KEY,
  state       text        NOT NULL,
  changed_at  timestamptz NOT NULL,

  CONSTRAINT question_state_known CHECK (state IN ('open', 'closed')),
  CONSTRAINT question_state_question_id_length CHECK (char_length(question_id) <= 200)
);
```

The file adapter writes one JSON object per question id into `<dir>/question-state.json`, serialised through the same per-directory promise queue pattern `FileSubmissionInboxStore` uses. Both adapters run the same contract suite (decision D12).

Contract cases: an unset question is absent from `list()`; `setState` then `list()` round-trips; setting the same state twice yields one record with the newer `changedAt`; closing then reopening yields `open`; an unknown lifecycle value is refused.

### Task C2: The projection

**Files:** `src/content/open-questions.ts`, `tests/unit/open-questions.test.ts`

Add — **without touching the dataset**:

```ts
/**
 * The question set as it stands right now: the authored catalogue, with whatever the
 * project has since closed taken out of the rotation (MCL-35).
 *
 * A pure function of two inputs, so the whole rotation rule is testable without a
 * database and without a browser. The catalogue is never mutated: closing a question is
 * an operation the project performs, not an edit to the record of what it decided to
 * ask.
 */
export function projectQuestions(
  closedIds: ReadonlySet<string>,
  questions: ReadonlyArray<OpenQuestion> = openQuestions,
): ReadonlyArray<OpenQuestion> {
  return questions.map((question) =>
    closedIds.has(question.id) ? { ...question, state: "closed" as const, focus: false } : question,
  );
}

/**
 * The one question a child is asked right now, or null when the project has none open.
 *
 * Order: the authored focus flag first, then catalogue order. That means nothing changes
 * while no question is closed - the child sees exactly what focusQuestion() chose
 * before - and closing the focused one promotes the next authored question rather than
 * an arbitrary one. `null` rather than a throw, because "we are not asking anything at
 * the moment" is a real state a child may arrive in, and a page that throws for it is a
 * page that is down.
 */
export function activeQuestion(
  questions: ReadonlyArray<OpenQuestion>,
): OpenQuestion | null {
  const open = questions.filter((question) => question.state === "open");
  return open.find((question) => question.focus) ?? open[0] ?? null;
}

export function upcomingQuestions(
  questions: ReadonlyArray<OpenQuestion>,
): ReadonlyArray<OpenQuestion> {
  const active = activeQuestion(questions);
  return questions.filter((q) => q.state === "open" && q.id !== active?.id);
}

export function archivedQuestions(
  questions: ReadonlyArray<OpenQuestion>,
): ReadonlyArray<OpenQuestion> {
  return questions.filter((question) => question.state === "closed");
}
```

`focusQuestion()` **stays** — it is the catalogue invariant (`tests/unit/open-questions.test.ts:16-21` pins it) and it must keep throwing when the authored dataset is malformed. It simply stops being what the pages call.

New test cases: closing the focused question promotes the next; closing all questions yields `null` and does not throw; a closed id that is not in the catalogue is ignored; the projection never mutates `openQuestions` (assert `openQuestions[0].state === "open"` after projecting it closed).

### Task C3: `isAnsweredQuestionId` for the write routes

**Files:** `src/content/open-questions.ts` or a small server-side helper + `src/composition/server.ts`

Both write routes (A8, A9) must refuse a `questionId` that is not currently open. Implement as a composition-root helper `createQuestionStateReader()` plus a pure `isOpenQuestion(id, projected)` — routes must not read the environment.

### Task C4: The admin lifecycle route

**File:** `src/app/api/admin/questions/route.ts`

`POST` with a bounded JSON body `{questionId, state}`. Admin gate, admin rate limiter, `readBoundedJson(request, 4096)`.

> **Why a mutation verb is allowed here and not on the admin inbox.** `src/app/api/admin/inbox/submissions/route.ts:14-22` deliberately exports no mutating verb, because *"no change to the original text or audio through the UI"* is an acceptance criterion. This route mutates **nothing a child wrote** — it records whether the project is still asking a question. Keep them separate routes so that distinction stays structural. A test must pin that the admin inbox route still answers `405` to `POST`.

Cases: unauthenticated `401`; family session under the admin cookie `401`; unknown `questionId` `400`; unknown `state` `400`; body over the cap `400`; success `200` and the reader shows the new state; setting the same state twice is `200` both times; `GET` on this path is `405`.

**Two regression assertions in both directions**, because this sprint is the first one to add an admin *write* anywhere:

```ts
// The MCL-50 rule, re-proven now that a sibling admin route can write:
// tests/unit/admin-inbox-route.test.ts:188-193 already asserts this - keep it green.
expect(adminInboxRoute).not.toHaveProperty("POST");

// And the mirror image: the questions route must never be able to touch a child's answer.
const source = await readFile("src/app/api/admin/questions/route.ts", "utf8");
expect(source).not.toMatch(/createSubmissionInboxStore|submission_inbox|appendIfAbsent/);
```

**Reopen semantics must be stated, not discovered.** MCL-35's AC *"Frage kann wieder geöffnet werden"* means a close is not terminal. With `activeQuestion` (C2) ordering by the authored `focus` flag first, reopening the originally focused question **makes it active again** and demotes whichever question had rotated in. That is deterministic and defensible — the authored catalogue decides the order, not the click history — but it must be **asserted**, not left to be found out: journey J7 closes A, checks B is active, reopens A, and asserts A is active again and exactly one question is active.

### Task C5: The admin questions surface

**File:** `src/app/components/admin-questions-view.tsx` (new `"use client"` component — **must be appended to `tests/architecture/boundaries.test.ts:117-127`**), rendered from `src/app/admin/page.tsx` beside the inbox.

Shows every catalogue question with: title, id, current state, "Schließen"/"Wieder öffnen" button, and the number of answers already received (from the existing inbox reader filtered by `questionId`). Closed questions appear under an "Archiv" heading — that is MCL-35's *"beantwortete Fragen bleiben nachvollziehbar archiviert"*.

### Task C6: The child view reads the projection

**Files:** `src/app/page.tsx`, `src/app/family-experience.tsx`, `src/app/welt/[id]/page.tsx`

- `page.tsx` reads the state overlay, projects, and passes `activeQuestion` and `upcomingQuestions` as props (decision D8).
- `family-experience.tsx` deletes the module-scope `focusQuestion()` / `otherOpenQuestions()` calls at lines 39–40 and uses the props. When `activeQuestion` is `null`, render a child-safe sentence — proposed: *"Gerade ist keine Frage offen. Schau bald wieder vorbei - oder erzähl uns einfach eine eigene Idee."* — and **no answer form**. No admin vocabulary anywhere (`expectChildSafe`).
- `welt/[id]/page.tsx:61` must use the projection too, so a closed question stops appearing on detail pages.

> **Regression trap, from the recon:** `tests/e2e/family-mvp.spec.ts:34` posts the German text *"Mein Tier ist ein kleiner Steinwolf."*, written for the current pet question. If that test seeds a fixed answer, make it derive the question from the page rather than assume it — otherwise the assertion keeps passing while the fixture becomes nonsense.

### Task C7: Composition + docs

`createQuestionStateStore()` / `createQuestionStateReader()` in `server.ts`, selected by the same `databaseUrl()` rule as the inbox (decision D12). Append the new load-bearing files to `scripts/check-foundation.mjs`. Document the rotation rule in `docs/` and note flag **F4** (MCL-32 duplicate).

### Task C8: The rotation journey, end to end

**File:** `tests/e2e/question-rotation.spec.ts`

**J7** — exactly MCL-35's stated acceptance evidence:

```
GIVEN a child sees question A on /
WHEN an adult signs in to /admin and closes question A
THEN the child, on a fresh load of /, sees question B
AND /admin lists question A under the archive with its answer count
AND reopening A puts it back as the active question
AND nothing on / ever contains an admin word (expectChildSafe)
```

Plus **J7b**: a POST to `/api/inbox/submissions` with the closed question's id answers `400` — a stale client cannot keep answering a retired question.

### Task C9: Story C gate + PR

Same command block as A14.

---

## Story D — Sprint review and closing report

### Task D1: Re-derive every claim, do not trust the stories

For each of G1–G4, run the command that proves it and paste the **raw output**. Not a summary, not "looks correct".

| Claim | Proving command | Expected |
|---|---|---|
| G1 text durable | `psql "$MCL_TEST_DATABASE_URL" -tAc "select count(*) from submission_inbox where kind='text'"` after an e2e run | an integer > 0 |
| G1 audio durable | same with `kind='audio'`, plus `ls -R .data/media \| wc -l` | integer > 0, file present |
| G1 audio byte-exact | `shasum -a 256 <the file the e2e uploaded>` vs. the `audio_sha256` column | identical strings |
| G1 ACK only after storage | the A8 case #14 test name and result | PASS |
| G2 admin reads audio | e2e J5 | PASS |
| G2 unauthorised cannot | e2e J6, plus `curl -s -o /dev/null -w '%{http_code}' <playback URL>` with no cookie | `401` |
| G3 tiles open | `npx playwright test tests/e2e/world-detail.spec.ts` | 86-strong suite green |
| G4 rotation | e2e J7 | PASS |
| whole gate | `npm run verify && npm run test && npm run check:integration-ran && npm run test:e2e` | exit 0 each |

### Task D2: Deploy and verify the deployed artefact — not the local build

Per `AGENTS.md` and the user's own standing rule (*verify the deployed artifact, not just local + tests*):

1. `df -h /` again (flag F6). Below 5 GB free → stop.
2. `mkdir -m 700 -p /opt/mc-legends/data/media`; add `AVALORIA_MEDIA_DIR=/data/media` to `/opt/mc-legends/app.env` (mode `0600`, root-owned, like the rest of that file).
3. **Raise the proxy body ceiling — trap T1, and nothing else in this plan matters without it.** In `/etc/nginx/sites-available/mc-legends`, inside the `listen 8443 ssl` server block:
   ```nginx
   # MCL-49: a recording is up to 8 MiB (MAX_AUDIO_BYTES). Without this the default
   # ~1 MB ceiling answers 413 at the proxy and the app never sees the request -
   # measured 2026-08-21: 1000 KB reached the app (401), 1100 KB did not (413).
   client_max_body_size 9m;
   ```
   then `nginx -t && systemctl reload nginx`.
4. Build the image. **The runbook §6.1 command is wrong**: the `Dockerfile` does `COPY src-checkout/ ./`, so the build context must be `/opt/mc-legends`, **not** `/opt/mc-legends/src-checkout`. Fix §6.1 in the same PR.
5. Start the container, then `docker exec mc-legends npm run db:migrate` — the runbook's deliberate ordering (§6.2). Keep the 503 window short. Run it twice; the second must print `no pending migrations`.
6. **Prove the ceiling actually moved**, before trusting anything else:
   ```bash
   dd if=/dev/urandom of=/tmp/2mb.bin bs=1024 count=2048
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     https://srv1308064.hstgr.cloud:8443/api/inbox/submissions/audio \
     -H 'content-type: audio/webm' --data-binary @/tmp/2mb.bin
   ```
   Expected `401` (the app's own guard refused an unauthenticated caller). **`413` means nginx is still the ceiling** and step 3 did not take.
7. Smoke-test the **live** service with its real injected secrets: `/api/health` → 200; `/api/health/ready` → `database: ok` **and** `mediaStorage: ok`; one real text submission through the browser; one real audio submission through the browser; one admin playback; then `docker restart mc-legends` and confirm both artefacts are still there and the recording still plays.
8. Confirm `AVALORIA_ADMIN_ACCESS_CODE` is genuinely configured — it **is** as of 2026-08-21, provable without ssh: `POST /api/admin/session` with a wrong code answers `401 invalid-credentials`, whereas an unconfigured gate would answer `503`. The runbook row at `docs/deploy/vps-mc-legends.md:37` that omits the key is **stale documentation, not evidence of absence** — fix that row too.
9. Record the image tag, the SHA and every result, `PASS` / `FAIL` / `not_run: <reason>`.

### Task D3: The closing report

**File:** `docs/reports/2026-08-21-sprint-513-review.md`

Structure, per the repo's handoff rule — four sections that must not be mixed:

1. **Observed / implemented facts** — with commands and raw output.
2. **Jira-planned behaviour** — the AC lists, each marked met / not met / partially met, with the evidence reference.
3. **Assumptions** — every decision D1–D12 that has not been independently confirmed by the Product Owner.
4. **Blockers / not-run validation** — flags F1–F7, anything recorded `not_run` or `BLOCKED`, and the dependency drift (7 dependabot PRs closed unmerged while `npm audit --audit-level=high` is a required CI step).

Plus a sprint-review section: goal met / partially met / not met per claim, what moved, what did not, and the recommended next slice.

### Task D4: Update Jira and Confluence — compose, re-read, then send

External mutations. Draft each comment, re-read it for drafting artefacts, then post.

- MCL-49, MCL-30, MCL-35: transition only on real evidence, with the evidence in the comment (the repo rule: *"Jira wird nicht allein wegen Dateiänderung, Commit, PR oder Merge auf Done gesetzt"*).
- MCL-30: record that its storage AC is met **by MCL-49** (flag F7).
- MCL-32: raise the duplicate (flag F4).
- MCL-41: restate that the release gate is shut and `src/app/layout.tsx:6` still carries the name.
- Confluence MLOA pages 09, 10 and 13: reconcile to the new head SHA and the new delivery state.

---

## Real-user journeys this sprint must make demonstrably work

Each is a Playwright test, not a description. The child is 8–11 and reads German; the adult holds the admin code.

| # | Who | Journey | Spec file | Status at baseline |
|---|---|---|---|---|
| J1 | child | writes an answer, sends it, reads "Im Projekt angekommen" | `family-mvp.spec.ts` | ✅ green |
| J2 | child | records, listens, sends, sees it arrived — and after a reload it is still there | `audio-delivery.spec.ts` | ❌ new |
| J3 | child | the send fails; the answer is not lost and the retry works | `audio-delivery.spec.ts` | ❌ new |
| J2c | child | records, opens an idea tile, comes back — the recording is still there (trap T11) | `audio-delivery.spec.ts` | ❌ new |
| J4 | child | no microphone; picks a sound file instead and it arrives | `audio-delivery.spec.ts` | ❌ new |
| J4b | child | picks a picture, and picks a file that is too big — both refused in German, no jargon, no byte counts, no preview | `audio-delivery.spec.ts` | ❌ new |
| J5 | adult | signs in to `/admin`, filters to recordings, plays one, sees receipt and digest | `admin-inbox.spec.ts` | ❌ new |
| J6 | nobody | anonymous and family-only callers cannot fetch a recording | `admin-inbox.spec.ts` | ❌ new |
| J7 | adult→child | closes the active question; the child gets the next one; the archive keeps the old one; reopening restores it | `question-rotation.spec.ts` | ❌ new |
| J8 | child | opens a world tile, reads the detail, comes back to the same topic and card | `world-detail.spec.ts` | ✅ green (86) |
| J9 | child | every page they can reach stays in child language and names no franchise | all specs, `expectChildSafe` | ✅ green, must stay |

---

## Risk register

| # | Risk | Mitigation in this plan |
|---|---|---|
| R1 | MCL-63 (PR #30) touches the same four gate files and merges second → manual merge on machinery `AGENTS.md` forbids bypassing | Flag F1: decide the order before starting. If MCL-63 goes first, rebase each story on it. |
| R2 | A child's voice recording stored before any retention policy exists | Flag F3; A13 writes it down as an explicit open policy rather than letting it be implicit |
| R3 | VPS disk at 78 % and no blob backup stream | Task A0 gates on free space; A13 adds the second backup stream to the runbook |
| R4 | `focusQuestion()` throws at module scope of a client component → both child surfaces down | Decision D8 removes the module-scope call; `activeQuestion` returns `null` instead of throwing |
| R5 | Closing questions in the dataset would break `tests/unit/open-questions.test.ts` (≥3 open; ≥1 uncovered category) | Decision D7: overlay, never a dataset edit |
| R6 | An oversized upload buffered before rejection | `declaresAcceptableSize` + `readBoundedBytes` streaming cap, both pinned by tests (A8 cases 4 and 5) |
| R7 | A stored recording served as executable content | Decision D6 + A10 case 6: closed allowlist Content-Type, `nosniff`, CSP `sandbox` |
| R8 | A row referencing a recording that is not on disk | Decision D5 write-order + A10 case 7 (404 and a logged error) |
| R9 | e2e mutates `AGENTS.md` and `next-env.d.ts`; CI fails on a dirty `next-env.d.ts` | `git checkout --` before every commit; it is in every gate block |
| R10 | `check:foundation`'s hard-coded path list silently stops describing reality | A13, B8, C7 each append the new load-bearing files |
| R11 | A new `"use client"` component silently uncovered by the boundary rule | C5 explicitly appends `admin-questions-view.tsx` to the hard-coded list |
| R12 | `fake-indexeddb` may not round-trip a `Blob` | B2 verifies it as the **first** test and names the fallback |
| R13 | Reporting green on a still-red deployment | Task D2 verifies the deployed artefact, not the local build |

# MCL-35 — Offene Fragen abschließen, rotieren und archivieren

- Jira: `MCL-35` `[Web][S2]`
- Baseline (verified `git fetch --all --prune`, 2026-08-22): `origin/main` = `727fb2b17a18fa5d7a7a34f847e33b12ba35b754`
- Branch to create: `feat/MCL-35-question-lifecycle`
- Planning mode: INTERNAL_PLAN_ALLOWED. This document is the plan only — no code was written, no branch created, no deployment, no Jira/Confluence mutation.
- Verification vocabulary: `PASS` / `FAIL` / `not_run: <reason>` / `BLOCKED`.

---

## 1. Goal

One vertical slice that makes the set of open questions **runtime state** instead of source-only state:

- an authorized adult can close and reopen a question from the protected surface, without editing source;
- the child surface shows the next open question automatically after one is closed;
- a closed question stays traceable in an archive with its history;
- a submission (typed or spoken) never changes which question it answers, whatever rotation does around it.

## 2. Non-goals

Explicitly out of this slice, and not to be started as "while we're here":

- Coolify deployment, VPS runtime acceptance, nginx, backups, MCL-49 closure, MCL-64.
- Cloudflare / OpenNext / Workers / Fly.io (MCL-63 is deferred and must not be touched).
- MCL-41 naming work, transcription (MCL-54), canonicalizing children's submissions.
- Any workflow engine, question authoring UI, scheduling, per-child question assignment, question CRUD. Close and reopen are the only two verbs.
- Broad redesign or unrelated refactors of the child page.

---

## 3. Preconditions and known gaps (verified, with evidence)

Facts established by reading the checkout at `727fb2b`:

| # | Observed fact | Evidence |
|---|---|---|
| P1 | Questions are static source data with `state: "open" \| "closed"` and one `focus: true`. Selectors `focusQuestion()`, `otherOpenQuestions()`, `openQuestionsAbout()` filter that array. | `src/content/open-questions.ts` |
| P2 | The child client component resolves the question **at module load**: `const question = focusQuestion();` and `const upcomingQuestions = otherOpenQuestions();` at the top of the file. Rotation cannot be seen by a running page today. | `src/app/family-experience.tsx:39-40` |
| P3 | `AudioAnswerRecorder` receives `questionId` as a prop and passes it **at send time**: `onClick={() => void sender.send(recording, questionId)}`. | `src/app/components/audio-answer-recorder.tsx` (send button) |
| P4 | `AudioAnswerSender.send(recording, questionId)` mints `SendIdentity {recording, submissionId, createdAt}` on first attempt and reuses it for retries — but `questionId` is **not** part of the identity; every call passes it in again. This is the exact hazard MCL-30 handed over. | `src/adapters/media/audio-answer-sender.ts` (`#identityFor`, `send`) |
| P5 | The typed path is already safe: `submitText` stores `questionId` on the submission, and retry re-delivers the stored submission — `deliverSubmission(submission, …)` never re-reads a current question. | `src/application/submissions/submit-text.ts`, `src/application/submissions/deliver-submission.ts`, `src/app/family-experience.tsx` `handleRetry` |
| P6 | "Meine Ideen" renders `originalText` + status only. Nothing says which question an answer belonged to. | `src/app/family-experience.tsx`, section `#meine-ideen` |
| P7 | Persistence convention is: port pair (write/read) → two adapters (file JSONL + PostgreSQL) → selected in `src/composition/server.ts` by `databaseUrl()` = `process.env.DATABASE_URL?.trim() \|\| null`, file fallback dir via `AVALORIA_*_DIR?.trim() \|\| default`. Both adapters proven by shared `tests/unit/*-contract.ts` suites. | `src/composition/server.ts`, `src/adapters/persistence/*`, `tests/unit/submission-inbox-*-contract.ts` |
| P8 | Migrations are `db/migrations/NNNN_*.sql`, applied in filename order by `scripts/migrate.mjs`, each in one transaction with its `schema_migrations` row, guarded by a `pg_advisory_lock`. A migration must not contain `BEGIN/COMMIT/ROLLBACK`. Next free number is `0003`. | `scripts/migrate.mjs`, `db/migrations/` |
| P9 | Admin identity is a separate gate + separate cookie + sibling guard: `guardAdminRequest(request, createAdminAccessGate(), createAdminRouteRateLimiter())`, three-way gate outcome, `unavailable` never folded into `unauthorized`. | `src/adapters/http/admin-request-guard.ts`, `src/app/api/admin/inbox/submissions/route.ts` |
| P10 | `scripts/check-foundation.mjs` holds a hard-coded required-path list (currently 70 entries, lines 4-75 — CLAUDE.md still says 52, which is stale). `tests/architecture/boundaries.test.ts` holds a hard-coded client-component list (line 117 ff.) and forbids `@/app/*`, `next`, `react`, `@/adapters/*` imports inside `src/content`. | `scripts/check-foundation.mjs`, `tests/architecture/boundaries.test.ts` |
| P11 | Playwright runs `fullyParallel: true` against **one** shared dev/prod server (`playwright.config.ts`), and two existing specs depend on the seeded focus question: `tests/e2e/foundation.spec.ts:6` (`"Welches Tier soll dich in Avaloria begleiten?"`) and `tests/e2e/family-mvp.spec.ts:43` (`focusQuestion().id`). A spec that closes a question on the shared server would break them non-deterministically. | `playwright.config.ts`, those two specs |
| P12 | Child-safe vocabulary is enforced by `expectChildSafe` over `childUnsafeVocabulary` + HTTP/500/503/fetch/Timeout/Stack, word-bounded, case-insensitive. | `tests/support/child-safe.ts` |

Known gaps carried into this slice:

- **G1** — There is no runtime store for question state at all. Everything below is new.
- **G2** — `AVALORIA_QUESTION_DIR` does not exist yet; it must be added to `.env.example`, `playwright.config.ts` and the docs. It is **not** a secret, so `check-client-secrets` / `check-secrets` / the boundaries secret list stay unchanged.
- **G3** — The integration suites self-skip without `MCL_TEST_DATABASE_URL`; a green `npm run test` proves nothing about the PostgreSQL adapter unless `npm run check:integration-ran` also passed.
- **G4** — Local PostgreSQL is 15.x on 5432 as `benjaminpoersch@`; CI is 17. The `mcl_test` database is TRUNCATEd by the suite.

---

## 4. Recorded decisions (do not re-litigate during execution)

**D1 — Append-only event log, derived current state.** Lifecycle is stored as immutable events (`closed` / `reopened`), never as a mutable `state` row. Current state = latest event per question, seeded from `open-questions.ts` when a question has no events. This is the smallest model that satisfies "traceably archived" and "concurrent/stale action does not erase archive evidence" at the same time: there is no UPDATE and no DELETE anywhere in the write path, so evidence cannot be overwritten.

**D2 — Reuse the existing persistence shape, add no second architecture.** New port pair (`QuestionLifecycleLog` write / `QuestionLifecycleReader` read), two adapters (file JSONL + PostgreSQL), one selection rule in `src/composition/server.ts` reusing `databaseUrl()`. Two ports rather than one, for the reason MCL-50 already recorded: the child page needs the *read* capability and must not be able to acquire the *write* one from the composition root.

**D3 — Rotation order is the array order of `openQuestions`.** The active question is the first question in that array whose effective state is `open`. `focus: true` in the dataset stays as the seeded start and is pinned to agree with the rotation rule by a test (`rotate({}).active.id === focusQuestion().id`); it is not a second source of truth. Reopening therefore returns a question to its original position — deterministic, no recency ordering, no priority field.

**D4 — No open question is a first-class state, not an error.** `active === null` renders a child-safe panel ("Gerade ist keine Frage offen…"), no form, no recorder. `focusQuestion()` keeps throwing for a *dataset* that breaks its invariant (that guard is about source data and stays), but the rotation function never throws.

**D5 — Audio binds its question when the recording is prepared, not when it is sent.** `questionId` moves into `SendIdentity`. `AudioAnswerSender.send(recording)` takes **one** argument, so there is no parameter through which a later question could enter at send time. Binding happens in `prepare(recording, questionId)`, called by the recorder in an effect the first time a given recording object appears; `prepare` is a no-op for a recording that already has an identity.

**D6 — A bound recording is still sendable after its question closed.** It is submitted under its original `questionId`, and the child is told in child-safe words that it belongs to the earlier question. The alternative (force discard) destroys a child's recording because an adult clicked something; the routes therefore do **not** refuse submissions for closed questions. Rotation changes what is *offered*, never what is *accepted*.

**D7 — Optimistic concurrency, refused rather than merged.** Close/reopen carries `expectedState`. The PostgreSQL adapter takes `pg_advisory_xact_lock(hashtext(question_id))` inside the transaction, re-reads the latest event, and refuses with `stale` when the state moved. The file adapter serialises through the same per-directory queue the inbox file store uses — and is process-local, which the docs must say plainly (AGENTS.md forbids calling either file-store or limiter behaviour distributed or production-grade).

**D8 — A lifecycle read failure must not take the child page down.** If the reader throws, `HomePage` and `/welt/[id]` fall back to the seeded dataset (empty overlay), log server-side under a fixed string, and render normally. The admin surface does the opposite and reports 503, because an adult acting on stale state is the dangerous direction.

---

## 5. Requirements

| REQ | Requirement | Source |
|---|---|---|
| REQ-35-1 | An authorized adult can close a question from the protected surface. | Jira AC 1 |
| REQ-35-2 | A closed question disappears from the active rotation and from the child's "kommt später dran" list. | Jira AC 2 |
| REQ-35-3 | The next open question becomes active automatically, deterministically. | Jira AC 3 + scenario |
| REQ-35-4 | A question can be reopened and returns to the open pool at its rotation position. | Jira AC 4, edge 2 |
| REQ-35-5 | A closed question stays retrievable with its close/reopen history. | Jira AC 5, edge 5 |
| REQ-35-6 | No child-facing surface exposes admin terminology, database terminology, ids, internal status names or technical errors. | Jira AC 6 |
| REQ-35-7 | With every question closed, the child surface stays safe and intentional — no crash, no undefined question, no dead form. | Edge 3 |
| REQ-35-8 | Close/reopen is rejected server-side without an admin session (and for a family session). | Edge 4, security section |
| REQ-35-9 | An already stored submission stays linked to the question it answered, after rotation. | Edge 6 |
| REQ-35-10 | "Meine Ideen" shows a child-readable reference to the question each answer belonged to. | Handoff 2, edge 7 |
| REQ-35-11 | A recording captured while A was active can never be silently submitted as an answer to B. | MCL-30 handoff, edge 8 |
| REQ-35-12 | A retry of an already attempted recording keeps the same `submissionId` **and** the same `questionId`. | MCL-30 handoff, edge 9 |
| REQ-35-13 | A concurrent or stale close/reopen neither corrupts lifecycle state nor erases archive evidence. | Edge 10 |

---

## 6. Task list

Every task is a commit. Failing test first where the task changes behaviour. Commit format `type(MCL-35): imperative sentence`.

### T1 — Rotation as a pure function over the content dataset

- REQ: REQ-35-2, REQ-35-3, REQ-35-4, REQ-35-7
- Files: `src/content/open-questions.ts` (add), `tests/unit/question-rotation.test.ts` (new), `tests/unit/open-questions.test.ts` (extend)
- Add, framework-free (this module may not import `next`, `react`, `@/adapters/*`, `@/app/*`):

```ts
export type QuestionStateOverlay = Readonly<Record<string, QuestionState>>;

export type QuestionRotation = Readonly<{
  active: OpenQuestion | null;
  upcoming: readonly OpenQuestion[];
  archived: readonly OpenQuestion[];
}>;

export function rotateQuestions(
  overlay: QuestionStateOverlay,
  questions: ReadonlyArray<OpenQuestion> = openQuestions,
): QuestionRotation;

export function questionById(
  id: string,
  questions: ReadonlyArray<OpenQuestion> = openQuestions,
): OpenQuestion | null;
```

  - effective state = `overlay[id] ?? question.state`
  - `active` = first array-order question whose effective state is `open`, else `null`
  - `upcoming` = the remaining open ones, array order
  - `archived` = effective-closed ones, array order
  - overlay keys that name no known question are ignored (a question deleted from source must not resurrect)
- Tests: A closed → B active; reopen A → A active again (array position, not recency); every question closed → `active === null`, `upcoming` empty, `archived` = all; unknown overlay key ignored; `rotateQuestions({}).active.id === focusQuestion().id` (pins D3); `questionById` returns null for an unknown id and never throws.
- Acceptance evidence: `npx vitest run tests/unit/question-rotation.test.ts` — all pass; `npm run test:architecture` still PASS (content layer imports nothing new).
- Commit: `test(MCL-35): pin how a closed question hands the turn to the next one` + `feat(MCL-35): derive the active question from a lifecycle overlay`

### T2 — Lifecycle ports

- REQ: REQ-35-1, REQ-35-4, REQ-35-5, REQ-35-13
- Files: `src/application/questions/question-lifecycle.ts` (new)
- Shapes:

```ts
export type QuestionLifecycleAction = "closed" | "reopened";

export type QuestionLifecycleEvent = Readonly<{
  eventId: string;
  questionId: string;
  action: QuestionLifecycleAction;
  previousState: QuestionState;   // structurally re-stated, so history reads without replay
  nextState: QuestionState;
  occurredAt: string;             // ISO 8601
}>;

export type LifecycleAppendOutcome =
  | Readonly<{ applied: true; event: QuestionLifecycleEvent }>
  | Readonly<{ applied: false; reason: "stale"; currentState: QuestionState }>;

export class QuestionLifecyclePayloadError extends Error {}   // refusal, never retryable

export interface QuestionLifecycleLog {
  append(request: Readonly<{
    questionId: string;
    action: QuestionLifecycleAction;
    expectedState: QuestionState;
    seededState: QuestionState;   // what source says when no event exists yet
  }>): Promise<LifecycleAppendOutcome>;
}

export interface QuestionLifecycleReader {
  currentStates(): Promise<Readonly<Record<string, QuestionState>>>;
  history(questionId?: string): Promise<readonly QuestionLifecycleEvent[]>;  // newest first
}
```

  - `QuestionState` is imported from `@/content/open-questions` — `src/application` may import `src/content` (content imports nothing downward, so no cycle) — **verify this in T2 before writing the file**; if the architecture test disallows it, re-declare the two-member union in the port module and pin the two with a compile-time `satisfies` in the content module. Record which of the two was chosen.
- Tests: none of its own (interfaces). Covered by T3/T4 contract suites.
- Acceptance evidence: `npm run typecheck` PASS, `npm run test:architecture` PASS.
- Commit: `feat(MCL-35): name the question lifecycle write and read boundaries`

### T3 — Shared contract suite + file adapter

- REQ: REQ-35-1, REQ-35-4, REQ-35-5, REQ-35-13
- Files: `tests/unit/question-lifecycle-contract.ts` (new, reusable suite — not a `.test.ts`), `tests/unit/file-question-lifecycle-log.test.ts` (new), `src/adapters/persistence/file-question-lifecycle-log.ts` (new)
- File adapter: append-only JSONL at `<directory>/question-lifecycle.jsonl`, one shared per-directory write queue exactly like `FileSubmissionInboxStore`, `mkdtemp` per test with `rm` in `afterEach`. Malformed line handling mirrors `inbox-record-shape.ts`: refuse loudly rather than skip silently.
- Contract cases (run against both adapters):
  1. no events → `currentStates()` is `{}` and `history()` is empty
  2. close with `expectedState: "open"` → `applied: true`, `currentStates()[q] === "closed"`
  3. close again with `expectedState: "open"` → `applied: false, reason: "stale", currentState: "closed"`, and `history()` still holds exactly one event
  4. reopen with `expectedState: "closed"` → applied, state back to `open`
  5. history is newest-first and holds **both** events after close+reopen (REQ-35-5 / REQ-35-13: reopening must not erase the close)
  6. `history(questionId)` filters exactly, never by prefix
  7. an `expectedState` that disagrees with `seededState` for a question with no events → `stale`
- Acceptance evidence: `npx vitest run tests/unit/file-question-lifecycle-log.test.ts` — all pass.
- Commit: `test(MCL-35): state the lifecycle contract both stores must keep` + `feat(MCL-35): keep the question lifecycle in an append-only file log`

### T4 — Migration 0003 + PostgreSQL adapter

- REQ: REQ-35-5, REQ-35-13
- Files: `db/migrations/0003_question_lifecycle.sql` (new), `src/adapters/persistence/postgres-question-lifecycle-log.ts` (new), `tests/integration/postgres-question-lifecycle-log.test.ts` (new), `tests/support/question-lifecycle-table-lock.ts` (new, own advisory key — **not** `4820481048`)
- Migration (no `BEGIN`/`COMMIT`/`ROLLBACK` — the runner owns the transaction; comments containing those words are fine, the runner blanks comments out):

```sql
CREATE TABLE question_lifecycle_event (
  event_id       text        PRIMARY KEY,
  question_id    text        NOT NULL,
  action         text        NOT NULL,
  previous_state text        NOT NULL,
  next_state     text        NOT NULL,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  sequence       bigint      GENERATED ALWAYS AS IDENTITY,

  CONSTRAINT question_lifecycle_action_known CHECK (action IN ('closed','reopened')),
  CONSTRAINT question_lifecycle_previous_known CHECK (previous_state IN ('open','closed')),
  CONSTRAINT question_lifecycle_next_known CHECK (next_state IN ('open','closed')),
  CONSTRAINT question_lifecycle_transition_real CHECK (previous_state <> next_state),
  CONSTRAINT question_lifecycle_action_matches CHECK (
    (action = 'closed'   AND next_state = 'closed')
    OR (action = 'reopened' AND next_state = 'open')
  ),
  CONSTRAINT question_lifecycle_question_id_length CHECK (char_length(question_id) <= 200),
  CONSTRAINT question_lifecycle_event_id_length CHECK (char_length(event_id) <= 200)
);

CREATE INDEX question_lifecycle_question_seq_idx
  ON question_lifecycle_event (question_id, sequence DESC);
```

  - `sequence` is the total order; `occurred_at` is what the application observed and is not trusted for ordering.
  - No UPDATE and no DELETE statement exists in the adapter. Pin that with a source scan in the architecture test (see T12).
- Adapter `append`: one transaction — `SELECT pg_advisory_xact_lock(hashtext($1))` → `SELECT next_state … ORDER BY sequence DESC LIMIT 1` → compare against `expectedState` (falling back to `seededState` when there is no row) → `INSERT` or return `stale`. Pool cached in a module `Map` keyed by connection string, with `closePostgresQuestionLifecyclePools()` exported for `afterAll` (mirrors `closePostgresSubmissionInboxPools`).
- Tests: the T3 contract suite against real PostgreSQL, plus **the concurrency case** — two `append` calls for the same question with `expectedState: "open"` started without awaiting the first: exactly one `applied: true`, exactly one `stale`, and `history()` holds exactly one row. This case is the reason the advisory lock exists and must fail without it (delete the lock line locally once and record that it fails).
- Acceptance evidence:
  ```bash
  export MCL_TEST_DATABASE_URL=postgresql://benjaminpoersch@localhost:5432/mcl_test
  DATABASE_URL="$MCL_TEST_DATABASE_URL" npm run db:migrate      # prints: applied 0003_question_lifecycle
  npx vitest run tests/integration/postgres-question-lifecycle-log.test.ts
  DATABASE_URL="$MCL_TEST_DATABASE_URL" npm run db:migrate      # prints: no pending migrations  (idempotent re-apply)
  ```
- Commit: `feat(MCL-35): give the question lifecycle a durable append-only table`

### T5 — Composition root wiring

- REQ: REQ-35-1..REQ-35-5
- Files: `src/composition/server.ts`, `tests/integration/composition-store-selection.test.ts` (extend), `.env.example`
- Add `createQuestionLifecycleLog()` and `createQuestionLifecycleReader()`, both selecting on `databaseUrl()`, file fallback `process.env.AVALORIA_QUESTION_DIR?.trim() || ".data/questions"` (`||`, never `??` — the module's third recorded reason for it applies unchanged).
- Tests: with `DATABASE_URL` stubbed to the test connection string both factories return the PostgreSQL adapter; unset → the file adapter. Same `vi.stubEnv` per-case shape the file already uses.
- Acceptance evidence: `npx vitest run tests/integration/composition-store-selection.test.ts` with `MCL_TEST_DATABASE_URL` set; `npm run check:integration-ran` PASS.
- Commit: `feat(MCL-35): select the lifecycle store the same way the inbox is selected`

### T6 — Protected close/reopen route

- REQ: REQ-35-1, REQ-35-4, REQ-35-8, REQ-35-13
- Files: `src/app/api/admin/questions/route.ts` (new, `GET`), `src/app/api/admin/questions/[questionId]/route.ts` (new, `POST`), `tests/unit/admin-questions-route.test.ts` (new)
- `GET /api/admin/questions` → `{ questions: [{ id, title, state, active, lastChangedAt }], archive: [{ id, title, events: [...] }] }`, `cache-control: no-store`.
- `POST /api/admin/questions/<questionId>` body `{ action: "close" | "reopen", expectedState: "open" | "closed" }`, read through `readBoundedJson` (16 KiB, same as the inbox route, `content-length` set explicitly in tests).
- Outcomes, through a local `refuse(status, code)` with machine-readable codes only:
  - `unavailable` gate → `console.error` under a fixed string, 503 `questions-unavailable`
  - `unauthorized` → 401 `unauthorized`
  - `rate-limited` → 429 `too-many-requests`
  - unknown `questionId`, unknown action/state, malformed body → 400 `invalid-request`
  - `applied: false, reason: "stale"` → **409** `stale-state` with the current state, so the adult can refresh rather than fight
  - store throw → 503 `questions-unavailable`, cause to `console.error`
- Guard: `guardAdminRequest(request, createAdminAccessGate(), createAdminRouteRateLimiter())`. Reuse the existing admin bucket deliberately — same identity, same surface, negligible resource cost; a separate bucket would be a knob with no resource argument behind it. Record that in a comment.
- Tests (all in-process, `import { POST } from "@/app/api/admin/questions/[questionId]/route"`, `resetRateLimitersForTest()` per case):
  - no cookie → 401; **a valid family session cookie → 401** (countertest for REQ-35-8: the child credential must not work here — mint it through `tests/support/family-session-header.ts`, never hand-written)
  - blank admin code → 503, and the family path still works
  - close → 200, state `closed`; second identical close → 409 `stale-state`
  - reopen → 200, state `open`
  - unknown question id → 400, and nothing is appended (assert `history()` empty)
  - over-limit → 429
  - the response body never contains a stack, path, secret or child text
- Acceptance evidence: `npx vitest run tests/unit/admin-questions-route.test.ts` — all pass.
- Commit: `test(MCL-35): refuse a close that no adult session asked for` + `feat(MCL-35): let an authorized adult close and reopen a question`

### T7 — Admin surface

- REQ: REQ-35-1, REQ-35-4, REQ-35-5
- Files: `src/app/components/admin-question-board.tsx` (new client component), `src/app/admin/page.tsx` (render it above `AdminInboxView`), `src/composition/browser.ts` (+ `createBrowserQuestionLifecycleClient()`), `src/application/questions/question-lifecycle-client.ts` (new port), `src/adapters/http/http-question-lifecycle-client.ts` (new)
- The board lists every question with its state, marks the active one, offers `Frage schließen` / `Wieder öffnen`, and shows an archive section with each question's event history. A 409 renders "Der Stand hat sich geändert. Bitte neu laden." and re-reads.
- **Register the new client component in `tests/architecture/boundaries.test.ts`'s hard-coded list** — otherwise the server-root/`node:` rule silently does not cover it (P10).
- Tests: `tests/unit/http-question-lifecycle-client.test.ts` — status → outcome mapping (200/400/401/409/429/503/network), mirroring `http-admin-inbox-client.test.ts`.
- Acceptance evidence: unit test passes; `npm run test:architecture` PASS with the new file in the list (verify by temporarily adding a `node:` import and seeing it fail, then reverting).
- Commit: `feat(MCL-35): give the project surface a way to close and reopen questions`

### T8 — Child surface reads the rotation

- REQ: REQ-35-2, REQ-35-3, REQ-35-6, REQ-35-7
- Files: `src/app/page.tsx`, `src/app/welt/[id]/page.tsx`, `src/app/family-experience.tsx`, `src/app/question-message.ts` (new), `tests/unit/question-message.test.ts` (new)
- `HomePage` reads `createQuestionLifecycleReader().currentStates()`, computes `rotateQuestions(overlay)`, and passes `activeQuestion: OpenQuestion | null` and `upcomingQuestions` as props. Wrap the read in try/catch → empty overlay + `console.error` under a fixed string (D8).
- `family-experience.tsx`: delete the two module-level `const question = focusQuestion()` / `otherOpenQuestions()` lines (P2) and take them from props. When `activeQuestion === null`, render the child-safe empty panel and neither the form nor `AudioAnswerRecorder`.
- `/welt/[id]`: `openQuestionsAbout` and the "Diese Frage beantworten" link must use the same overlay, so a detail page cannot offer a button to a closed question. Same try/catch fallback.
- `src/app/question-message.ts` holds the new German strings (empty state, "gehört zur vorherigen Frage", the "Deine Antwort auf …" prefix) so they can be checked without rendering React.
- Tests: `tests/unit/question-message.test.ts` — `expectChildSafe` over every exported string; assert none contains `admin`, `Frage-ID`, `Datenbank`, `Status`, or a raw id shape.
- Acceptance evidence: `npx vitest run tests/unit/question-message.test.ts`; `npm run build` PASS (the page becomes async-dynamic — confirm no static-render error).
- Commit: `feat(MCL-35): show the child whichever question is open right now`

### T9 — "Meine Ideen" names the question

- REQ: REQ-35-9, REQ-35-10, REQ-35-6
- Files: `src/app/family-experience.tsx`, `src/app/question-message.ts`
- Each entry renders `Deine Antwort auf: „<title>"` via `questionById(submission.questionId)`; unknown id → `Deine Antwort auf eine frühere Frage.` The raw `questionId` is **never** rendered (REQ-35-6).
- Tests: covered by T8's message test plus the e2e in T13 (the value comes from IndexedDB, which only the browser has).
- Acceptance evidence: e2e assertion in T13.
- Commit: `feat(MCL-35): tell a child which question each of their answers belongs to`

### T10 — Bind the recording's question at capture (the MCL-30 hazard)

- REQ: REQ-35-11, REQ-35-12
- Files: `src/adapters/media/audio-answer-sender.ts`, `src/app/components/audio-answer-recorder.tsx`, `tests/unit/audio-answer-sender.test.ts` (extend), `tests/unit/audio-send-contract.test.ts` (extend if it pins the send signature)
- Changes:
  - `SendIdentity` gains `questionId`.
  - New `readonly prepare = (recording: CapturedAudio, questionId: string): void` — mints the identity once per recording object; **no-op** if that recording already has one.
  - `send` becomes `readonly send = async (recording: CapturedAudio): Promise<void>` — one parameter. It uses `this.#identity.questionId`. If no identity exists for the recording it publishes nothing and returns (documented as unreachable from the UI, and covered by a test that asserts the inbox was never called).
  - New `readonly boundQuestionIdFor = (recording: CapturedAudio): string | null` — tests and the recorder's "belongs to the earlier question" notice; never rendered as an id.
  - Recorder: `useEffect(() => { if (recording !== null) sender.prepare(recording, questionId); }, [sender, recording, questionId])`. `questionId` is in the dependency list on purpose — the effect re-runs on rotation and `prepare` must do nothing, which is exactly what the countertest asserts. The send button is disabled until `boundQuestionIdFor(recording) !== null`.
  - When `boundQuestionIdFor(recording) !== activeQuestion?.id`, render the child-safe notice from `question-message.ts`. Sending stays offered (D6).
- Tests, including the required countertests:
  1. **Countertest A (re-lookup at send):** prepare with `"A"`, rotate the prop, call `prepare(recording, "B")`, then `send(recording)` → the inbox receives `questionId: "A"`. This fails the moment binding moves back to send time.
  2. **Countertest B (structural):** `expect(AudioAnswerSender.prototype.send.length).toBe(1)` — there is no parameter through which a current question could be handed in at send time. Add the same assertion for `prepare.length === 2`. (Note: `send` is a class field arrow function, so read it off an instance: `expect(new AudioAnswerSender(inbox, deps).send.length).toBe(1)`; verify which form actually reflects the arity before relying on it.)
  3. **Retry identity (REQ-35-12):** first send fails with `transport`; `prepare` called again with a different question in between; retry → same `submissionId` **and** same `questionId` in the second inbox call.
  4. `send` on a recording that was never prepared → inbox never called, state unchanged.
  5. Existing MCL-30 cases (stable id across retries, generation guard, `sent` only from a real receipt) still pass unchanged.
- Acceptance evidence: `npx vitest run tests/unit/audio-answer-sender.test.ts` — all pass; then **flip the invariant deliberately** (make `send` take `questionId` again and use it) and record that countertests A and B fail. Revert.
- Commit: `test(MCL-35): prove a recording cannot be re-aimed at the question that replaced it` + `fix(MCL-35): bind a recording to its question when it is prepared`

### T11 — Documentation

- REQ: all
- Files: `docs/ops/MCL-35-question-lifecycle.md` (new), `CLAUDE.md`, `.env.example`, `AGENTS.md` (only if a new non-negotiable is genuinely needed — default is no change)
- The runbook states: the event-log model and why nothing is ever updated or deleted; the rotation rule (array order, seeded focus); the empty-state behaviour; that a submission is never refused for a closed question and why; that the file adapter's serialisation is **process-local** and not distributed or production-grade; the rollback path (remove `DATABASE_URL` → file log, exactly as MCL-48's); and how to inspect the archive by hand.
- `CLAUDE.md`: add `AVALORIA_QUESTION_DIR` to the env list, the new ports/adapters to the architecture section, and the new required-path entries.
- Acceptance evidence: `npm run check:foundation` PASS (it scans `.md` files for the forbidden franchise names — refer to them indirectly, never literally).
- Commit: `docs(MCL-35): write down what closing a question does and does not do`

### T12 — Gate registrations (do not skip; each is a silent-coverage hole)

- REQ: REQ-35-6, REQ-35-8
- Files: `scripts/check-foundation.mjs`, `tests/architecture/boundaries.test.ts`
- Append to the required-path list: `src/content/open-questions.ts` is already listed; add `src/application/questions/question-lifecycle.ts`, `src/adapters/persistence/file-question-lifecycle-log.ts`, `src/adapters/persistence/postgres-question-lifecycle-log.ts`, `src/app/api/admin/questions/route.ts`, `src/app/api/admin/questions/[questionId]/route.ts`, `src/app/components/admin-question-board.tsx`, `src/app/question-message.ts`, `src/adapters/http/http-question-lifecycle-client.ts`.
- Add `src/app/components/admin-question-board.tsx` to the client-component list in `boundaries.test.ts` (P10).
- Add one new architecture case: the lifecycle adapters' source contains no `UPDATE ` and no `DELETE ` (D1 made structural). Exclude nothing; if a future need arises it is a deliberate edit here.
- No secret-list change: `AVALORIA_QUESTION_DIR` is not a secret, so `check-client-secrets.mjs`, `check-secrets.mjs`, the boundaries secret list and `.github/workflows/ci.yml`'s two scan steps stay untouched. **State this explicitly in the PR body** so a reviewer does not have to re-derive it.
- Acceptance evidence: `npm run check:foundation` prints `foundation: ok`; `npm run test:architecture` PASS.
- Commit: `chore(MCL-35): put the new lifecycle files under the existing gates`

### T13 — E2E on an isolated server

- REQ: REQ-35-1..REQ-35-5, REQ-35-7, REQ-35-9, REQ-35-10, REQ-35-11, REQ-35-12
- Files: `playwright.config.ts`, `tests/e2e/question-rotation.spec.ts` (new), `tests/e2e/audio-question-binding.spec.ts` (new)
- **P11 is a blocker for naive e2e**: the suite is `fullyParallel` against one server, and two existing specs assert the seeded question. Add a **second Playwright project** with its own `webServer` — own port (`E2E_ROTATION_PORT`, default `3101`), own `AVALORIA_QUESTION_DIR` and `AVALORIA_INBOX_DIR` under a per-run path, `testMatch` limited to the two new specs, and the existing chromium project given a `testIgnore` for them. Rationale in a comment: closing a question is global state, so a spec that closes one may not share a server with specs that assume it is open.
- `question-rotation.spec.ts`: sign in as admin → close the active question → child page shows the next one and no longer lists the closed one → admin archive shows the closed question with its history → reopen → child page shows it again. Then close **all** questions and assert the child page renders the empty panel with no form and no recorder (REQ-35-7). Every child-visible string passing through `expectChildSafe`.
- `audio-question-binding.spec.ts` (the strongest evidence for REQ-35-11/12): sign in as family, pick an audio file (the existing `audio-capture.spec.ts` file-input path — a real microphone is not available in CI), let the recording be prepared under question A, then close A through the admin API in the same test, reload/refresh so the page's active question becomes B, press send, and assert through `GET /api/admin/inbox/submissions?questionId=<A>` that the stored submission's `questionId` is **A** and that `?questionId=<B>` does not contain it.
- Acceptance evidence:
  ```bash
  rm -rf .data && E2E_PORT=3199 E2E_ROTATION_PORT=3198 npx playwright test
  ```
  then the CI-equivalent form `npm run build && CI=1 npm run test:e2e`.
- Commit: `test(MCL-35): follow a real rotation through the browser, recording included`

### T14 — Full gate + PR

- Run, in one shell, with all three `AVALORIA_*` values set identically for the build and the client-secret scan (see CLAUDE.md's exact form).
- Open **one** PR against `main` from `feat/MCL-35-question-lifecycle`. Do **not** merge. Report the exact head SHA and the CI state for that SHA (`~/.claude/scripts/gh-ci-wait DYAI2025/MC_legends <sha> 1800`).
- Commit: none (PR only).

---

## 7. AC → planned evidence matrix

| REQ | Evidence that will exist | Task |
|---|---|---|
| REQ-35-1 | `tests/unit/admin-questions-route.test.ts` close case 200; e2e admin close | T6, T13 |
| REQ-35-2 | `question-rotation.test.ts` (A closed → absent from `active`+`upcoming`); e2e child page | T1, T13 |
| REQ-35-3 | `question-rotation.test.ts` (B becomes `active`); e2e child page shows B | T1, T13 |
| REQ-35-4 | contract case 4 (both adapters); `question-rotation.test.ts` array-position case; e2e reopen | T1, T3, T4, T13 |
| REQ-35-5 | contract case 5 (history holds close **and** reopen); architecture case "no UPDATE/DELETE"; e2e archive | T3, T4, T12, T13 |
| REQ-35-6 | `expectChildSafe` over `question-message.ts` and over every child-visible string in the e2e | T8, T13 |
| REQ-35-7 | `rotateQuestions` all-closed case; e2e empty-panel case (no form, no recorder, no crash) | T1, T13 |
| REQ-35-8 | route tests: no cookie → 401, **family cookie → 401**, blank admin code → 503 | T6 |
| REQ-35-9 | e2e: submission stored before rotation still returned under its original `questionId` | T13 |
| REQ-35-10 | e2e: "Meine Ideen" shows the question title, never an id | T9, T13 |
| REQ-35-11 | countertest A + e2e audio binding across a real rotation | T10, T13 |
| REQ-35-12 | retry test asserting same `submissionId` **and** same `questionId`; countertest B (`send.length === 1`) | T10 |
| REQ-35-13 | PostgreSQL concurrency case (one applied, one stale, one row); stale → 409 route case | T4, T6 |

---

## 8. Risks and rollback

| # | Risk | Mitigation |
|---|---|---|
| R1 | E2E state bleed: a spec closes a question and breaks `foundation.spec` / `family-mvp.spec` under `fullyParallel` (P11). | Second Playwright project + own `webServer` + own data dirs (T13). If that proves too heavy, the fallback is making the two existing specs read the active question from the page instead of a constant — but that is a wider edit and is the *second* choice. |
| R2 | The child page becomes fully dynamic and slower, or fails to build statically. | It already reads `cookies()` and is dynamic (P-note in `src/app/page.tsx`). Confirm with `npm run build` in T8 before continuing. |
| R3 | Reader outage takes the child surface down. | D8 fallback to the seeded dataset + fixed-string server log. Add a unit case if a testable seam exists; otherwise state it as covered only by inspection in the handoff. |
| R4 | The `prepare` effect and StrictMode: double-invocation mints twice or re-binds. | `prepare` is idempotent per recording object; the existing `useEffect(() => controller.release, [controller])` precedent and the StrictMode note in memory apply. Countertest A covers exactly this. |
| R5 | `src/application` importing `src/content` violates an architecture rule nobody checked. | Resolved in T2 **before** writing the file, with the recorded fallback (re-declare the union). |
| R6 | Migration 0003 lands but an older running container has no `question_lifecycle_event` table. | Additive-only migration; nothing existing changes. An old container simply never reads it. Rollback = remove `DATABASE_URL` → file log, or leave the table unused; no down-migration is written (the repo has none, and dropping an archive table is exactly what D1 forbids). |
| R7 | A reviewer reads "archive" as "the answers are archived". | The runbook must say plainly: the archive is of **questions**, not of children's submissions; submissions are untouched by this slice. |

**Rollback for the whole slice:** revert the PR. The table stays behind, unread and empty of consequence; `.data/questions/question-lifecycle.jsonl` likewise. No data written by earlier slices is touched — `submission_inbox` is not altered by migration 0003.

---

## 9. Verification gate (run before opening the PR)

```bash
source ~/.nvm/nvm.sh && nvm use
npm run check:foundation
npm run check:secrets
npm run lint
npm run typecheck

export MCL_TEST_DATABASE_URL=postgresql://benjaminpoersch@localhost:5432/mcl_test
DATABASE_URL="$MCL_TEST_DATABASE_URL" npm run db:migrate
npm run test && npm run check:integration-ran     # second command must not be skipped

AVALORIA_FAMILY_ACCESS_CODE=… AVALORIA_SESSION_SECRET=… AVALORIA_ADMIN_ACCESS_CODE=… npm run build
AVALORIA_FAMILY_ACCESS_CODE=… AVALORIA_SESSION_SECRET=… AVALORIA_ADMIN_ACCESS_CODE=… npm run check:client-secrets

rm -rf .data && E2E_PORT=3199 E2E_ROTATION_PORT=3198 npx playwright test
```

Traps to respect while running it: keep `DATABASE_URL` **unset** in the shell that runs the unit suite and Playwright (an exported one flips the whole app to PostgreSQL); stop any dev server on port 3000 or use `E2E_PORT`; `next dev` rewrites `next-env.d.ts` and `AGENTS.md` — restore both before committing.

Report each line as `PASS` / `FAIL` / `not_run: <reason>`. An unexecuted check is never a pass.

---

## 10. Discovered follow-ups (NOT MCL-35 — do not start them here)

- **F1** — `/welt/[id]` currently calls `focusQuestion()` directly; after T8 it reads the overlay. If a later slice adds more question surfaces, the overlay read should move into one server helper rather than being repeated per page.
- **F2** — Question *text* is still source data. Editing a question's wording remains a code change. That is deliberate for MCL-35 and is the natural next story if the product wants it.
- **F3** — There is no retention/deletion policy for lifecycle events, as there is none for recordings (recorded in migration 0002). Open product/privacy question.
- **F4** — `docs/security/MCL-34-family-access.md` already predates MCL-48/50; it will be one slice further out of date after this. Worth a dedicated doc-refresh story rather than a drive-by edit.
- **F5** — The per-address rate-limit keys remain spoofable (`x-forwarded-for`); only the constant-key global limiters are a real ceiling. Unchanged by this slice, restated so it is not mistaken for new.

---

## 11. Status of this document

Plan only. As of writing: no branch created, no code changed, no commit, no push, no PR, no deployment, no Jira transition, no Confluence edit. `origin/main` verified at `727fb2b17a18fa5d7a7a34f847e33b12ba35b754`; the working tree's unrelated local files (`.claude/`, the three other `docs/plans/*` files, modified `CLAUDE.md`) were left untouched.

**Stop conditions: none triggered.** The existing persistence architecture accommodates the lifecycle store without contradiction (P7), close/reopen needs no larger architectural change, and the one genuinely ambiguous point — what happens to a recording bound to a question that closes mid-flight — is resolved as D6 rather than guessed at.

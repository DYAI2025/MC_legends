# Submission recovery & migration integrity

Date: 2026-08-18
Branch: `fix/submission-recovery-integrity`
Baseline: `a0d357a4febe7cd9f6c79c352b49ca32bd0aa1f5` (`origin/main`, CI run 32082360579, conclusion `success`)

No Jira key was supplied for this slice and Jira mutation is not authorised, so the
branch and the commit scopes deliberately carry no `MCL-<n>`. Everything else follows
the repository conventions in `AGENTS.md` and `CLAUDE.md`.

## Goal

Make the JSONL fallback / PostgreSQL cutover boundary truthful and fail-safe on three
points an independent review found on the baseline:

- **A** — `POST /api/inbox/submissions` documents its 201 as "the record is durably
  appended before this answer is sent". `FileSubmissionInboxStore.appendIfAbsent`
  reached `stored: true` after `appendFile`, which resolves once the bytes are in the
  page cache. The claim and the code disagreed.
- **B** — `scripts/import-inbox-jsonl.mjs` read `rowCount === 0` after
  `ON CONFLICT (submission_id) DO NOTHING` as "already present" without ever comparing
  the stored row. A row that differs from the source line was counted as a successful
  idempotent re-run.
- **C** — `FileSubmissionInboxStore.readAll()` pushed `JSON.parse(line) as InboxRecord`.
  A syntactically valid JSON object of any shape became an `InboxRecord`, so a damaged
  line carrying a retried `submissionId` could answer a retry with `stored: false` and a
  receipt that is not a receipt.

## Non-goals

MCL-47 UI, MCL-30/49/54 audio, admin UX, nginx/VPS/production data/credentials,
`README.md`, `SECURITY.md`, `.github/workflows/ci.yml`, `CLAUDE.md`, `.claude/`, game
lore, unrelated refactors, any schema migration, and any general "recovery framework".
The README/security drift and Actions SHA pinning are separate slices.

## Preconditions and known gaps

- `origin/main` is `a0d357a4febe7cd9f6c79c352b49ca32bd0aa1f5` — verified before branching.
- Node 24.18.1 via `.nvmrc`. `FileHandle.sync()` and `fsync` on a directory handle were
  probed on this machine (darwin, v24.18.1) before being relied on; CI exercises the
  Linux path.
- Local PostgreSQL 15 on 5432 holds `mcl_test` with migration 0001 applied. CI runs
  postgres:17 and already gates on `check:integration-ran`, which runs **everything**
  under `tests/integration/` — so a new file there is proven by the existing gate with
  no workflow change.
- Known gap: no schema change is needed or made. `submission_inbox` already has
  `submission_id` as PRIMARY KEY and the CHECKs the validator mirrors.
- Known gap: the only production JSONL artefact (per `docs/deploy/vps-mc-legends.md`:
  one line, 286 bytes, already imported) was written by this adapter, so the new
  validator cannot conflict with a legacy format. This is an argument from the
  documented shape, not from re-reading the VPS file — VPS access is out of scope.

## Recorded decisions

- **A1 — explicit `fsync`, not an `O_SYNC` flag.** `appendFile(..., { flag: "as" })`
  would also be durable, but it is one character away from being deleted by a reformat
  and cannot be observed from a test without mocking `node:fs`. An `open` → `writeFile`
  → `sync()` → `close()` sequence puts the durability in a statement that a test can
  watch and a reviewer can see.
- **A2 — the containing directory is fsynced too**, on every append. Without it the
  first append's *directory entry* can be lost even though the file's data was synced,
  which loses the whole file rather than one line. One extra fsync per submission is
  the correct trade for a family inbox measured in kilobytes.
- **A3 — what the test proves and what it does not.** The guard proves `fsync` is
  requested on the data file and on the directory, and that it resolves before
  `appendIfAbsent` resolves. It does **not** simulate power loss, and on macOS `fsync`
  does not imply `F_FULLFSYNC`, so the platter/flash-level guarantee is the platform's,
  not this code's. Stated in the test header rather than implied by its name.
- **B1 — compare, never repair.** `ON CONFLICT DO NOTHING` stays; on `rowCount === 0`
  the importer `SELECT`s the stored row inside the same transaction and compares all
  seven immutable fields. `DO UPDATE` is forbidden: it would silently rewrite a child's
  stored words.
- **B2 — a mismatch fails the whole run.** The existing single transaction already made
  a failed run leave nothing behind; the mismatch now uses it. The error names the
  source line number and the differing **field names** only — never the values, because
  `originalText` is a child's own words and must not reach a log.
- **B3 — the importer pins its session** (`SET TIME ZONE 'UTC'`, `SET DateStyle = 'ISO, YMD'`)
  the way `PostgresSubmissionInboxStore` pins pooled connections, so the comparison reads
  `timestamptz` back as a `Date` and normalises with the same `toISOString()` the source
  side already used. Without the pin, a session `DateStyle` other than ISO makes pg's
  parser return `null` and the comparison would fail on every row for the wrong reason.
- **C1 — invalid-schema gets the same policy as invalid-JSON: skipped, not thrown.**
  Justification: the file adapter is MCL-48's rollback path, and the one moment somebody
  reaches for it is the moment when "one damaged line blocks every later submission"
  would be worst. Fail-closed here means *never treating a malformed line as a valid
  record* — it can no longer answer a duplicate check, appear in the admin list, or
  produce a receipt — plus a loud signal. It does not mean failing the request.
- **C2 — the corruption signal is one `console.error` per read**, naming the file, the
  line numbers and the reason keys (field names). Never the line content: a damaged line
  can still contain a child's text.
- **C3 — the validator lives in `src/adapters/persistence/inbox-record-shape.ts`**, not
  in the application layer and not shared with the importer. `scripts/import-inbox-jsonl.mjs`
  is plain `.mjs` run by `node` with no build step, so it cannot import a `.ts` module;
  it already carries equivalent, deliberately louder validation of its own. Two callers
  with opposite policies (skip vs refuse) are not duplication worth collapsing.
- **C4 — the validator checks representability, not lengths.** NUL and lone surrogates
  are rejected because PostgreSQL refuses the first (22021) and node-postgres *silently
  rewrites* the second to U+FFFD — a stored text that is not the child's text. Length
  caps are deliberately not mirrored: exceeding one is a loud refusal at import time,
  not a silent mutation, and mirroring them here would make the file store reject data
  it wrote itself the day the route's caps change.

## Tasks

### T1 — durable append (Finding A)

- REQ: A
- Files: `src/adapters/persistence/file-submission-inbox-store.ts`,
  `tests/unit/file-submission-inbox-store.test.ts`
- Test first: a case that spies on `FileHandle.prototype.sync` (reached from a real
  handle, so no `node:fs` mock) and asserts it is called twice on a first append — data
  file and directory — and not at all on a duplicate, which writes nothing.
- Change: replace `appendFile` with `open(path, "a")` → `writeFile` → `sync()` →
  `close()` in `finally`, then `open(directory, "r")` → `sync()` → `close()`.
- Acceptance evidence: `npx vitest run tests/unit/file-submission-inbox-store.test.ts`
  green; the same file red when `handle.sync()` is deleted (mutation proof 1).

### T2 — runtime `InboxRecord` validation (Finding C)

- REQ: C
- Files: new `src/adapters/persistence/inbox-record-shape.ts`,
  `src/adapters/persistence/file-submission-inbox-store.ts`,
  `tests/unit/file-submission-inbox-store.test.ts`, `scripts/check-foundation.mjs`
  (append the new load-bearing path)
- Test first: fixtures for `{}`, `[]`, `null`, a string, missing `receiptId`, a record
  whose `submissionId` matches the retry but whose `receiptId` is missing, `kind` other
  than `"text"`, unparsable and out-of-range timestamps, wrong field types, and an
  `originalText` carrying a NUL or a lone surrogate. Key regression: a malformed object
  carrying the retried `submissionId` must yield `stored: true`, never a `stored: false`
  with a malformed receipt; and `list()` must not surface it.
- Change: `readAll()` validates each parsed line and skips what fails, collecting line
  numbers and reason keys for one `console.error`.
- Acceptance evidence: unit file green; red when the validator call is replaced by the
  old cast (mutation proof 3).

### T3 — importer proves equality on conflict (Finding B)

- REQ: B
- Files: `scripts/import-inbox-jsonl.mjs`, new
  `tests/integration/import-inbox-jsonl.test.ts`
- Test first: the six required cases plus two the same mechanism makes cheap — an
  equivalent-but-differently-spelled timestamp accepted as already present, and two
  lines in one file sharing a `submissionId` with different text refused. Each case
  spawns the real script with `DATABASE_URL` set to `MCL_TEST_DATABASE_URL` and asserts
  exit code, stderr and the table contents read by an independent pool.
- Change: pin the session; on `rowCount === 0` `SELECT` and compare the seven immutable
  fields; throw a line-numbered error naming the differing field names.
- Acceptance evidence: `MCL_TEST_DATABASE_URL=... npx vitest run tests/integration/import-inbox-jsonl.test.ts`
  green; case 3 red when `DO NOTHING = identical` is restored (mutation proof 2).
  `npm run check:integration-ran` proves the suite executed rather than skipped.

### T4 — full gate run and evidence packet

- REQ: A, B, C
- Commands: `check:foundation`, `check:secrets`, `lint`, `typecheck`, `test`,
  `check:integration-ran`, `build`, `check:client-secrets`, `test:e2e`.
- Acceptance evidence: raw output recorded in the handoff, plus the PR/CI ids.

## Risks and rollback

- **Two fsyncs per submission** on the file path. Measured against a family inbox this
  is irrelevant; on a large file the full scan already dominates. Rollback: revert the
  commit — no data format changed, so files written by either version are readable by
  the other.
- **A stricter reader could hide a line the old reader accepted.** Only lines the
  adapter itself could never have written are affected; each one is now announced on
  stderr instead of silently mis-typed. Rollback: revert.
- **The importer now fails runs it used to report as clean.** That is the point, and it
  is the safe direction: it refuses rather than writes. Rollback: revert the commit; no
  row is ever written differently by the new code than by the old one.
- No migration, no production data touched, no credentials, no deploy.

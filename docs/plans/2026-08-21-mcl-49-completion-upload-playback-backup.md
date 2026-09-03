# MCL-49 completion — upload route, authorized playback, rollback compatibility, media backup

> **Continuation plan, not a replan.** Four commits of MCL-49 already exist on
> `feat/MCL-49-private-audio-storage`. This plan covers only what is left. It supersedes
> tasks A6b, A8, A10, A11 and A13 of
> `docs/plans/2026-08-21-mcl-sprint-513-family-mvp-2-completion.md` (untracked) — that
> plan's API names (`AudioArtifactStore.putIfAbsent`, `normaliseAudioMimeType`,
> `fileExtension`, `byteSize`) were **not** what got implemented, and every symbol in this
> plan is re-derived from the code on `e3db9c3`.

**Jira:** [MCL-49](https://dyai2026.atlassian.net/browse/MCL-49) — "[Backend] Originalaudio
privat und persistent auf VPS speichern" (Task, Highest, status `Zu erledigen`).

**Branch:** `feat/MCL-49-private-audio-storage` (exists locally, not pushed).
**Slice base:** `108441783052d1695b636579004677d0c85cb04b` (`1084417`, merge of PR #28).
**Current HEAD:** `e3db9c3ef1aa910d7da1ec1d5b68c7ee492f21b1`.

---

## Goal

A valid audio submission is received by an authenticated server route; its unchanged
original bytes are durably and privately persisted outside PostgreSQL; PostgreSQL holds
the metadata and the reference; an authorized adult can play it back; and **no positive
receipt can exist unless both persistence stages succeeded**.

## Non-goals

Explicitly out of scope for this slice, and each one has a home:

| Not doing | Why / where it belongs |
|---|---|
| Browser send path (child presses "senden") | MCL-30B, next slice. This slice ends at the server boundary. |
| Transcription, AI evaluation | MCL-54 / MCL-49 "Out of Scope". |
| Public media gallery | MCL-49 "Out of Scope". |
| Cloudflare / R2 migration | Deferred by the 21.08.2026 storage decision; VPS + Coolify is canonical. |
| Question lifecycle (`isAnsweredQuestionId`) | MCL-35. **Decision D3 below**: the audio route gets the same validation surface as the text route, no more. |
| Retention / deletion policy | MCL-49 AC11 requires it stay marked OPEN. **Do not invent a period.** |
| PR #30 / MCL-63 | Do not touch, do not merge. |

---

## Preconditions — verified 2026-08-21, not assumed

```
git rev-parse --abbrev-ref HEAD   → feat/MCL-49-private-audio-storage
git rev-parse HEAD                → e3db9c3ef1aa910d7da1ec1d5b68c7ee492f21b1
git log --oneline 1084417..HEAD   → e3db9c3, 91e8e67, 0a0af66, c18d2d5   (4 commits, as reported)
git status --porcelain            →  M CLAUDE.md
                                     ?? .claude/
                                     ?? docs/plans/2026-08-21-mcl-sprint-513-family-mvp-2-completion.md
```

**`CLAUDE.md` is a pre-existing unrelated modification.** Never `git checkout` it, never
`git add -A`, never include it in an MCL-49 commit. Every commit in this plan names its
files explicitly for exactly that reason.

`.claude/` and the untracked sprint plan stay untracked. The new plan file (this one) is
the only doc added under `docs/plans/`.

### What the four existing commits actually delivered

| Module | State on `e3db9c3` |
|---|---|
| `src/domain/media/audio-artifact.ts` | `AUDIO_MIME_EXTENSIONS` (5 types), `isAudioMimeType`, `audioExtensionFor`, `isSha256Hex`, `audioObjectKey(sha,mime)` → `<shard>/<sha>.<ext>`, `AudioArtifact`, `describeAudioArtifact`, `sniffAudioMimeType(bytes)` |
| `src/application/media/audio-blob-store.ts` | port `AudioBlobStore`: `store(objectKey, bytes)`, `read(objectKey) → Uint8Array \| null`, `checkWritable()` |
| `src/adapters/persistence/file-audio-blob-store.ts` | atomic temp+rename+fsync, content-addressed idempotent fast path, `OBJECT_KEY` regex built from the domain table, shard-matches-digest check, resolve-inside-root assertion |
| `db/migrations/0002_submission_audio.sql` | kind widened, 5 media columns, `submission_inbox_kind_shape`, mime/extension allowlists, sha256 shape, size ≤ 8388608, key length ≤ 200, **deliberately not unique** |
| `src/adapters/persistence/postgres-submission-inbox-store.ts` | 12-column INSERT, `audioFrom(row)`, `divergesFrom` compares sha256, `toRecord` switch |
| `src/adapters/persistence/file-submission-inbox-store.ts` | `toEntry` switch handles both kinds |
| `src/composition/server.ts` | `createAudioBlobStore()` (`AVALORIA_MEDIA_DIR` \|\| `.data/media`), `audioMaxBytes()` (`AVALORIA_AUDIO_MAX_BYTES` \|\| 8388608) |
| `src/app/api/health/ready/route.ts` | `storage: "ok" \| "unavailable"`, real write probe, 503 on unavailable |
| `.env.example` | `AVALORIA_MEDIA_DIR` and `AVALORIA_AUDIO_MAX_BYTES` documented |
| `src/app/components/admin-inbox-view.tsx` | audio branch renders format/size/sha256 — **no player yet** |

### Known gaps — measured, each one is a task below

| # | Gap | Evidence |
|---|---|---|
| G1 | No audio upload route at all | `find src/app/api -type f` lists 6 routes, none for audio |
| G2 | No authorized playback route | same |
| G3 | `SubmissionInboxReader` has no single-submission lookup | `submission-inbox-reader.ts` declares only `list(query)` |
| G4 | **`inbox-record-shape.ts:readInboxRecord` still requires `kind === "text"`** — an audio line written by the file store is skipped on read, logged as `damaged` | `src/adapters/persistence/inbox-record-shape.ts`, `if (source.kind !== "text") defects.push("kind")`. File not in `git diff 1084417..HEAD`. |
| G5 | `scripts/import-inbox-jsonl.mjs` refuses non-text lines and binds 7 columns | `COLUMNS` string; `if (parsed.kind !== "text") throw new MalformedLineError` |
| G6 | Admin read route refuses `?kind=audio` with 400 | `KNOWN_KINDS = ["text"] as const` in `src/app/api/admin/inbox/submissions/route.ts` |
| G7 | Admin filter state cannot express audio | `AdminFilterState.kind: "" \| "text"` in `src/app/admin-inbox-query.ts` |
| G8 | `bounded-json-body.ts` has no raw-bytes reader — the streaming cap is welded to a UTF-8 decode | `readBoundedBody` returns `string` |
| G9 | `check:foundation` list names none of the MCL-49 files (nor 11 MCL-50 files) | `scripts/check-foundation.mjs`, 56 entries measured; `CLAUDE.md` says 52 |
| G10 | No media backup stream; `docs/ops/MCL-48-backup-restore.md` §5 lists it as not covered | `/usr/bin/grep -n 'does not cover' docs/ops/MCL-48-backup-restore.md` |
| G11 | No `docs/ops/MCL-49-audio-storage.md`; deploy runbook has no media-dir section | `ls docs/ops` → one file |

### Environment traps (from `CLAUDE.md` + memory, re-check before executing)

- `source ~/.nvm/nvm.sh && nvm use` before any npm command (`engine-strict=true`).
- Local PostgreSQL role is `benjaminpoersch@`, **not** `postgres:postgres` (that is CI).
  `export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"` — `psql` is not on PATH.
- Never export `DATABASE_URL` in the working shell: the composition root flips the whole
  app, the unit suite and the Playwright dev server to Postgres. Integration suites are
  gated by `MCL_TEST_DATABASE_URL`.
- Playwright rewrites `AGENTS.md` and `next-env.d.ts` (`next dev` regenerates them).
  `git checkout -- AGENTS.md next-env.d.ts` before every commit. CI has a step that fails
  on a dirty `next-env.d.ts`.
- Local Playwright reuses an existing server on 3000 without the test codes. Use
  `rm -rf .data && E2E_PORT=3199 npx playwright test`.
- **`grep` in this session's shell is RTK-shimmed and returned empty for patterns that
  match.** Measured on this file's predecessor: `grep -n '^#' <plan>` printed nothing
  while `sed -n '1,40p'` showed `# Sprint 513 …`. Use `/usr/bin/grep` by absolute path
  for any count or presence check that is going to be reported as evidence.
- `check:foundation` walks the whole repo including `docs/plans/` and refuses on two
  literal franchise names. Never write them literally, this file included.

---

## Recorded decisions — do not re-litigate during execution

**D1 — Persistence order is blob first, row second, receipt last.**
`validate → sniff → hash → describe → AudioBlobStore.store → SubmissionInboxStore.appendIfAbsent → mint receipt`.
The receipt is minted into the record *before* the append (the route needs it in the row),
but it is **never returned** unless `appendIfAbsent` resolved. A row referencing a blob
that was never written is unrecoverable; an orphan blob is inert and self-heals on retry
because the key is content-addressed.

**D2 — A failed DB write does NOT delete the blob.** Migration 0002 records why: the
object key is content-addressed and deliberately not unique, so two submissions may
legitimately share one key. Deleting on rollback would delete another child's recording.
An unreferenced blob is acceptable and is documented as such in T8.

**D3 — The audio route's validation surface equals the text route's, and no more.**
No question-catalogue existence check. The text route
(`src/app/api/inbox/submissions/route.ts`) has none, and adding one to only the audio
route would make the two write paths disagree about what a valid `questionId` is. MCL-35
adds it to **both** or to neither. Recorded as risk R4.

**D4 — Identifiers ride in `x-avaloria-*` request headers, body is raw bytes.**
Not multipart. Two reasons: a custom header makes a cross-origin request non-simple, so a
form-post from another site cannot reach this route at all (the text route gets the same
property from its required `application/json`); and multipart parsing would introduce a
filename field, which is the exact input D5 forbids. `content-type` carries the declared
MIME type.

**D5 — No client filename is read, stored, logged or used to derive anything.** The
extension comes from `audioExtensionFor(sniffed)`. There is no code path that accepts one.

**D6 — Declared MIME must match sniffed MIME.** `isAudioMimeType(declared)` **and**
`sniffAudioMimeType(bytes) === declared`. Not "sniff wins": a mismatch means the client
and the bytes disagree, which is a refusal, not something to silently resolve. One
tolerance: `audio/webm;codecs=opus` — the parameter is dropped before comparison, the type
is not.

**D7 — Audio uploads get their own rate-limit bucket.** `AVALORIA_AUDIO_RATE_LIMIT`
default **10** / 60 s, versus the text inbox's 30. The scarce resource here is disk and
bandwidth, not request count: 30 × 8 MiB per minute per address is 240 MiB. A seventh
process-local limiter, wired into `resetRateLimitersForTest()`.

**D8 — Both "unknown submission" and "that one is text" answer 404 on the playback
route.** Distinguishing them would make the route an existence oracle for submission ids.

**D9 — `SubmissionInboxReader` gains `find(submissionId)`, not a new port.** Playback is a
read of the protected inbox by the admin identity — the same capability, the same gate,
the same adapter pair. A third port would be a third thing the composition root can hand
out by mistake.

**D10 — The media backup stream is a committed script, not prose.** `scripts/` already
holds five operational `.mjs` scripts; MCL-48's pull script lives only inside a doc
heredoc, which is why it has never been verified by CI or by a reviewer. The media stream
gets a real file.

---

## Requirement IDs

Jira MCL-49 acceptance criteria, verbatim, with the stable IDs used in the task table.

| ID | Criterion (verbatim) |
|---|---|
| AC1 | Audio wird in privatem, nicht öffentlich ausgeliefertem persistentem VPS-Filespeicher abgelegt |
| AC2 | der Speicherpfad ist unabhängig vom kurzlebigen Container-Layer und übersteht Coolify-Redeploy/Restart |
| AC3 | DB speichert mindestens objectKey bzw. stabile private Referenz, submissionId, MIME-Type, Dateiendung, Größe, SHA-256 und createdAt |
| AC4 | strikte Allowlist für zulässige Audio-MIME-Typen und passende Dateiendungen |
| AC5 | Uploadgröße ist begrenzt und dokumentiert |
| AC6 | gespeicherte Audios werden nicht als ausführbarer Webinhalt ausgeliefert |
| AC7 | Originalbytes werden bei späterer Transkription oder KI-Auswertung nicht verändert |
| AC8 | Zugriff ist über serverseitige Autorisierung geschützt; keine öffentlichen Medien-URLs |
| AC9 | Prozess-/App-/Container-Neustart verliert das gespeicherte Audio nicht |
| AC10 | Backup-Pfad umfasst die privaten Audiodateien und ist außerhalb des einzelnen VPS wiederherstellbar |
| AC11 | Lösch-/Retention-Verhalten ist als offene Produkt-/Privacy-Policy markiert, solange es nicht separat entschieden ist |

Required negative / consistency proofs, from the slice brief:

| ID | Must be proven |
|---|---|
| NT1 | > 8 MiB rejected |
| NT2 | unsupported MIME rejected |
| NT3 | declared MIME vs magic-byte mismatch rejected |
| NT4 | arbitrary filename / path traversal cannot influence the storage path |
| NT5 | executable extension cannot enter the blob store |
| NT6 | unauthorized playback denied |
| NT7 | DB failure after successful blob persistence produces NO receipt |
| NT8 | storage failure produces NO DB row and NO receipt |
| NT9 | retry of the same submission is idempotent |
| NT10 | two distinct submissions with identical audio may share one content-addressed blob |
| NT11 | readiness says storage unavailable when a real write cannot succeed |
| NT12 | readiness exposes no filesystem path or error text |

---

## Task list

Execution order is the table order. Every task is failing-test-first. Every commit names
its files explicitly — never `git add -A`, never `git add .` (see `CLAUDE.md` modification
above).

| ID | Task | REQ | Depends on |
|---|---|---|---|
| T4a | `readBoundedBytes` — raw-bytes streaming cap | AC5, NT1 | — |
| T4b | Audio rate limiter in the composition root | — | — |
| T4c | The audio upload route | AC1,3,4,5,7,8; NT1–5,7–10 | T4a, T4b |
| T5a | `SubmissionInboxReader.find` on the port and both adapters | AC3, AC8 | — |
| T5b | The authorized playback route | AC6, AC7, AC8; NT6 | T5a |
| T5c | Admin surface: audio filter and player | AC8 | T5b |
| T7 | JSONL rollback + import compatibility | AC3, AC9 | — |
| T8 | Documentation, foundation list, contracts | AC2,5,9,10,11; NT11,12 | T4c, T5b |
| T10 | Media backup + restore, script and drill | AC10 | T8 |
| T11 | Slice gate — every check bound to the final HEAD | all | T4–T10 |
| T12 | Push, PR, CI on the exact PR head | — | T11 |

---

### T4a — `readBoundedBytes`: the streaming cap without the decode

**REQ:** AC5, NT1.

**Files**
- Modify `src/adapters/http/bounded-json-body.ts`
- Modify `tests/unit/bounded-json-body.test.ts` (create if absent — check first; the module
  is currently exercised through `tests/unit/inbox-route.test.ts`)

**What**

`readBoundedBody` welds the streaming cap to a strict UTF-8 decode. Audio must survive
byte for byte, so there is nothing to decode. Extract the loop:

```ts
/**
 * Reads the body with a hard byte cap and returns the raw bytes.
 *
 * Extracted from readBoundedBody so a second caller gets exactly the same streaming
 * guarantee - an oversized body is abandoned mid-stream and never fully held in memory -
 * without the decode step. A recording has to survive byte for byte, so there is nothing
 * here to decode, and a decode that "succeeded" on audio would be the bug.
 */
export async function readBoundedBytes(
  request: Request,
  maxBodyBytes: number,
): Promise<Uint8Array | null>
```

`readBoundedBody` then calls it and applies `new TextDecoder("utf-8", { fatal: true })`.
Behaviour of `readBoundedBody` must not change — its existing tests are the regression
proof.

**Tests to add**
1. body under the cap → the exact bytes back, `byteLength` equal to input.
2. body over the cap, single chunk → `null`.
3. chunked body that crosses the cap on the third chunk → `null` **and** `reader.cancel()`
   was called (assert via a stream whose `cancel` sets a flag).
4. `request.body === null` → `null`.
5. bytes that are not valid UTF-8 (e.g. `0x1a 0x45 0xdf 0xa3` — the EBML header) → returned
   unchanged by `readBoundedBytes`, and `readBoundedBody` still returns `null` for them.

**Acceptance evidence**

```bash
npx vitest run tests/unit/bounded-json-body.test.ts tests/unit/inbox-route.test.ts
```
Both files pass; `inbox-route` count unchanged from before the edit (record both numbers).

**Commit**
```bash
git add src/adapters/http/bounded-json-body.ts tests/unit/bounded-json-body.test.ts
git commit -m "refactor(MCL-49): give the byte cap a caller that must not decode"
```

---

### T4b — The audio upload's own rate-limit bucket

**REQ:** — (defence in depth for AC5).

**Files**
- Modify `src/composition/server.ts`
- Modify `.env.example`
- Test: extend `tests/unit/in-memory-rate-limiter.test.ts` is **not** right — assert the
  new factory through the route tests in T4c and through a case in
  `tests/integration/composition-store-selection.test.ts` style if one fits. Minimum: the
  429 case in T4c proves it is wired.

**What**

Per D7:

```ts
export function createAudioInboxRateLimiter(): RateLimiter {
  audioInboxLimiter ??= new InMemoryRateLimiter({
    limit: positiveInteger(process.env.AVALORIA_AUDIO_RATE_LIMIT, 10),
    windowMs: positiveInteger(process.env.AVALORIA_AUDIO_RATE_WINDOW_MS, 60_000),
  });
  return audioInboxLimiter;
}
```

Add `audioInboxLimiter = null;` to `resetRateLimitersForTest()` — **a limiter missing from
that reset makes every later test in the process inherit the previous one's count.**

`.env.example` gains the pair with a comment saying why it is lower than the text inbox's
(one upload is up to 8 MiB; the ceiling that matters is volume, not request count).

**Acceptance evidence**

`/usr/bin/grep -c 'Limiter = null' src/composition/server.ts` → **7**.

**Commit**
```bash
git add src/composition/server.ts .env.example
git commit -m "feat(MCL-49): give recordings their own, tighter allowance"
```

---

### T4c — The audio upload route

**REQ:** AC1, AC3, AC4, AC5, AC7, AC8; NT1, NT2, NT3, NT4, NT5, NT7, NT8, NT9, NT10.

**Files**
- Create `src/app/api/inbox/submissions/audio/route.ts`
- Create `tests/unit/audio-inbox-route.test.ts`
- Create `tests/support/audio-fixtures.ts` (minimal valid containers, see below)

**Test fixtures** (`tests/support/audio-fixtures.ts`) — smallest byte sequences that
`sniffAudioMimeType` identifies, one per allowlisted type, plus deliberately hostile ones:

| Fixture | Bytes | Sniffs as |
|---|---|---|
| `WEBM` | `1a 45 df a3` + padding | `audio/webm` |
| `OGG` | `4f 67 67 53` + padding | `audio/ogg` |
| `MP4` | 4 size bytes + `66 74 79 70` + padding | `audio/mp4` |
| `MP3_ID3` | `49 44 33` + padding | `audio/mpeg` |
| `WAV` | `52 49 46 46` + 4 + `57 41 56 45` + padding | `audio/wav` |
| `HTML` | `<script>alert(1)</script>` | `null` |
| `ELF` | `7f 45 4c 46` + padding | `null` |
| `RIFF_AVI` | `RIFF` + 4 + `AVI ` | `null` (proves the offset-8 check) |

**Required cases** — write all of them, watch them fail, then implement:

| # | Given | Expect | Proves |
|---|---|---|---|
| 1 | no session cookie | `401 {acknowledged:false,error:"unauthorized"}`, `request.body` never read | AC8 |
| 2 | valid session, `content-type: text/html`, `HTML` body | `400 invalid-payload`; blob store `store` not called | NT2 |
| 3 | valid session, `content-type: audio/webm;codecs=opus`, `WEBM` body | `201` — the parameter is dropped, the type is not | D6 |
| 4 | `content-length: 8388609` | `400 invalid-payload` **before** the body is read | NT1 |
| 5 | chunked body exceeding 8388608 mid-stream | `400 invalid-payload`, stream cancelled, blob store not called | NT1 |
| 6 | empty body | `400 invalid-payload` | — |
| 7 | missing `x-avaloria-submission-id` | `400 invalid-payload` | — |
| 8 | `x-avaloria-created-at: "0000-01-01T00:00:00Z"` | `400 invalid-payload` (year outside 1..9999) | — |
| 9 | declared `audio/wav`, body is `WEBM` | `400 invalid-payload`; nothing written | **NT3** |
| 10 | declared `audio/webm`, body is `ELF` | `400 invalid-payload` | NT2/NT5 |
| 11 | declared `audio/webm`, body is `RIFF_AVI` | `400 invalid-payload` | NT3 |
| 12 | headers carry `x-avaloria-filename: ../../etc/passwd` and `content-disposition: attachment; filename="a.php"` | `201`, and the object key written is `<sha[0:2]>/<sha>.webm` — **no substring of either header appears in it** | **NT4, NT5** |
| 13 | valid `WEBM` upload | `201`, body is exactly `{acknowledged,receiptId,receivedAt}`; blob present under `audioObjectKey(sha, mime)`; inbox record `kind:"audio"`, `audio.sha256 === createHash("sha256").update(bytes).digest("hex")`, `audio.sizeBytes === bytes.byteLength`, `audio.extension === "webm"` | AC1, AC3, AC4, AC7 |
| 14 | the identical request repeated | `200` with the **first** `receiptId`; blob store `store` called twice but the file written once (assert file mtime/inode unchanged, or assert `store`'s internal `exists` fast path via a spy) | **NT9** |
| 15 | two different `submissionId`s, byte-identical audio | both `201`, two inbox rows, **one** file on disk, both rows carry the same `objectKey` | **NT10** |
| 16 | blob store `store` rejects | `503 inbox-unavailable`; `appendIfAbsent` **never called**; no receipt in the body | **NT8** |
| 17 | blob store succeeds, `appendIfAbsent` rejects | `503 inbox-unavailable`; response has **no** `receiptId`; the blob is still on disk and is **not** deleted | **NT7, D2** |
| 18 | `appendIfAbsent` throws `SubmissionPayloadError` | `400 invalid-payload` | — |
| 19 | rate limit exhausted (11th call in the window) | `429 too-many-requests` | T4b |
| 20 | no family access code configured | `503 inbox-unavailable` | AC8 fail-closed |
| 21 | every response body across cases 1–20 | keys ⊆ `{acknowledged, error, receiptId, receivedAt}` — no path, no stack, no message, no object key | — |

Use `familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE)` from
`tests/support/family-session-header.ts` and `resetRateLimitersForTest()` in `beforeEach`,
matching `tests/unit/inbox-route.test.ts`. Set `content-length` explicitly (repo
convention). Filesystem cases use `mkdtemp` per test + `rm` in `afterEach`.

**Implementation shape** — grounded in the symbols that exist on `e3db9c3`:

```ts
import { createHash } from "node:crypto";
import { declaresAcceptableSize, readBoundedBytes } from "@/adapters/http/bounded-json-body";
import { guardFamilyRequest } from "@/adapters/http/family-request-guard";
import {
  describeAudioArtifact,
  isAudioMimeType,
  sniffAudioMimeType,
} from "@/domain/media/audio-artifact";
import {
  SubmissionPayloadError,
  type AudioInboxRecord,
} from "@/application/submissions/submission-inbox-store";
import {
  audioMaxBytes,
  createAudioBlobStore,
  createAudioInboxRateLimiter,
  createFamilyAccessGate,
  createReceiptId,
  createSubmissionInboxStore,
} from "@/composition/server";
```

Order inside `POST`, and it is the order that is load-bearing (D1):

1. `guardFamilyRequest(request, createFamilyAccessGate(), createAudioInboxRateLimiter())` —
   from headers alone. An 8 MiB body is exactly what an unauthorised caller must not be
   able to make this server buffer.
2. Declared type: `request.headers.get("content-type")?.split(";")[0].trim().toLowerCase()`,
   then `isAudioMimeType(declared)` — refuse otherwise.
3. `declaresAcceptableSize(request, audioMaxBytes())` — refuse otherwise.
4. Identifiers from `x-avaloria-submission-id` / `-question-id` / `-created-at`; each
   trimmed, non-blank, ≤ 200 chars, no NUL, `isWellFormed()`; `createdAt` must be a
   storable instant (year 1..9999, mirroring the text route).
5. `readBoundedBytes(request, audioMaxBytes())` — refuse on `null` or `byteLength === 0`.
6. **`sniffAudioMimeType(bytes)`; refuse unless it strictly equals the declared type** (D6).
7. `const sha256 = createHash("sha256").update(bytes).digest("hex");`
8. `const audio = describeAudioArtifact({ sha256, mimeType: sniffed, sizeBytes: bytes.byteLength });`
   — this is where `objectKey` and `extension` come from, and the only place (D5).
9. `await createAudioBlobStore().store(audio.objectKey, bytes)` — on throw: log the cause
   server-side, `503 inbox-unavailable`, **return**. Nothing has touched the database.
10. Build the `AudioInboxRecord` with `receiptId: createReceiptId()` and
    `receivedAt: new Date().toISOString()`.
11. `await createSubmissionInboxStore().appendIfAbsent(record)` — on
    `SubmissionPayloadError` → `400`; on any other throw → log, `503`. **Do not delete the
    blob** (D2); add the comment saying why, referencing migration 0002's non-unique note.
12. `outcome.stored` → `201` with `record`'s receipt; `!outcome.stored` → `200` with
    `outcome.existing`'s receipt.

Module docblock must state D1, D2, D4 and D5 in the repository's register (the existing
routes are the tone reference).

**Acceptance evidence**

```bash
npx vitest run tests/unit/audio-inbox-route.test.ts
```
21 cases pass. Record the exact count printed by vitest.

**Commit**
```bash
git add src/app/api/inbox/submissions/audio/route.ts tests/unit/audio-inbox-route.test.ts tests/support/audio-fixtures.ts
git commit -m "feat(MCL-49): accept a recording and acknowledge it only once it is stored"
```

---

### T5a — `SubmissionInboxReader.find(submissionId)`

**REQ:** AC3, AC8. **Depends on:** nothing.

**Files**
- Modify `src/application/submissions/submission-inbox-reader.ts` (port)
- Modify `src/adapters/persistence/postgres-submission-inbox-store.ts`
- Modify `src/adapters/persistence/file-submission-inbox-store.ts`
- Modify `tests/unit/submission-inbox-reader-contract.ts` (shared contract — both adapters
  inherit the new cases automatically)

**What**

```ts
/**
 * One entry by its submission id, or null when the inbox does not hold it.
 *
 * On the read port rather than a port of its own: playback is a read of the protected
 * inbox by the admin identity, which is the capability this port already is. A third port
 * would be a third thing the composition root can hand to the wrong route.
 *
 * `null` rather than a throw for the absent case - the playback route answers 404 for it,
 * and "no such submission" is a normal answer to an id typed into a URL.
 */
find(submissionId: string): Promise<InboxEntry | null>;
```

Postgres: reuse `ENTRY_COLUMNS` + `WHERE submission_id = $1`, map through the existing
`toEntry`. File adapter: reuse the private `readAll()` scan (it already exists for the
duplicate check) and map through `toEntry`.

**Contract cases to add** (`describeSubmissionInboxReaderContract` — they then run against
the file adapter in unit tests and against real Postgres in `tests/integration/`):
1. unknown id → `null`
2. stored text submission → the text entry, `kind === "text"`, `status === "RECEIVED"`
3. stored audio submission → the audio entry with all five `audio.*` fields intact and
   `sizeBytes` a `number`, not a string (the Postgres bigint round-trip)
4. empty-string id → `null`, no throw

**Acceptance evidence**

```bash
npx vitest run tests/unit/file-submission-inbox-store.test.ts
export MCL_TEST_DATABASE_URL="postgresql://benjaminpoersch@localhost:5432/mcl_test"
npx vitest run tests/integration/postgres-submission-inbox-store.test.ts
```
Both pass; the integration run must report **0 skipped**.

**Commit**
```bash
git add src/application/submissions/submission-inbox-reader.ts \
        src/adapters/persistence/postgres-submission-inbox-store.ts \
        src/adapters/persistence/file-submission-inbox-store.ts \
        tests/unit/submission-inbox-reader-contract.ts
git commit -m "feat(MCL-49): let the protected read find one submission by id"
```

---

### T5b — The authorized playback route

**REQ:** AC6, AC7, AC8; NT6.

**Files**
- Create `src/app/api/admin/inbox/submissions/[submissionId]/audio/route.ts`
- Create `tests/unit/admin-audio-route.test.ts`

**Required cases**

| # | Given | Expect | Proves |
|---|---|---|---|
| 1 | no admin cookie | `401`, zero bytes of audio in the response | **NT6** |
| 2 | a valid **family** session presented under the admin cookie name | `401` | AC8, MCL-50 separation re-proven here |
| 3 | valid admin session, unknown `submissionId` | `404` | D8 |
| 4 | valid admin session, a **text** submission's id | `404` | D8 |
| 5 | valid admin session, a stored recording | `200`, body bytes **byte-identical** to what was uploaded (compare `sha256` of the response body against the fixture) | AC7 |
| 6 | the same | `content-type` is the stored `audio.mimeType`; `x-content-type-options: nosniff`; `content-security-policy: default-src 'none'; sandbox`; `cache-control: private, no-store`; `content-disposition` starts `inline;` | **AC6** |
| 7 | a row whose blob was removed from disk | `404`, and a `console.error` fired | AC8 fail-safe |
| 8 | a row whose `objectKey` is `../../../etc/passwd` (inserted directly, bypassing the route) | `404` or `503` — **never** a 200 with foreign bytes; the adapter's `pathFor` throws and the route catches it | **NT4** |
| 9 | `POST` to the same path | `405` — no POST export exists | AC7 (no mutation surface) |
| 10 | rate limit exhausted | `429` | — |
| 11 | no admin access code configured | `503` | AC8 fail-closed |
| 12 | admin code equal to family code | `503` | `createAdminAccessGate` refusal, re-proven |
| 13 | every response | contains no object key, no filesystem path, no stack | — |

**Implementation notes**

- Guard first, exactly as `src/app/api/admin/inbox/submissions/route.ts` does — the same
  four-way `ProtectedRequestOutcome`.
- `const { submissionId } = await context.params;` (Next 16 async params).
- `createSubmissionInboxReader().find(submissionId)` → `null` or `kind !== "audio"` → 404.
- `createAudioBlobStore().read(entry.audio.objectKey)` → `null` → log + 404. A **throw**
  from `read` (the traversal guard in `pathFor`) is caught separately → log + 404.
- Headers per case 6. `content-length: String(entry.audio.sizeBytes)`.
- `content-disposition: inline; filename="antwort-<submissionId>.<extension>"` — the
  filename is built from the submission id and the **stored** extension, never from
  anything a client sent.
- **The response carries the bytes; the object key never appears in it.** Case 13 pins it.

**Acceptance evidence**

```bash
npx vitest run tests/unit/admin-audio-route.test.ts
```
13 cases pass.

**Commit**
```bash
git add "src/app/api/admin/inbox/submissions/[submissionId]/audio/route.ts" tests/unit/admin-audio-route.test.ts
git commit -m "feat(MCL-49): let an authorised adult listen to a recording, and nobody else"
```

---

### T5c — Admin surface: audio filter and player

**REQ:** AC8.

**Files**
- Modify `src/app/api/admin/inbox/submissions/route.ts` — `KNOWN_KINDS = ["text","audio"]`
- Modify `src/app/admin-inbox-query.ts` — `AdminFilterState.kind: "" | "text" | "audio"`
- Modify `src/app/components/admin-inbox-view.tsx` — add `<audio controls preload="none">`
  pointing at `/api/admin/inbox/submissions/<id>/audio`, keeping the existing
  original/system-derived section split
- Modify `tests/unit/admin-inbox-route.test.ts`, `tests/unit/admin-inbox-query.test.ts`,
  `tests/unit/http-admin-inbox-client.test.ts`
- Modify `tests/e2e/admin-inbox.spec.ts`

**What**

`KNOWN_KINDS` is currently `["text"] as const` — `?kind=audio` is refused with 400 today,
so the admin cannot filter for recordings at all. Widening it is the whole change on the
route; `isKnownKind` is already a real type guard.

The view's audio branch already renders format / size / SHA-256 (commit `e3db9c3`). Add the
player **above** that `<dl>`, inside the existing `aria-label="Originalaufnahme"` section —
the original artifact belongs in the original region, the metadata stays in Systemangaben.
`preload="none"` so opening the inbox does not fetch every recording. The `src` is a route
path, never an object key (AC8: no public media URL, and the browser is handed no
filesystem path).

`admin-inbox-view.tsx` is already in the hard-coded client-component list in
`tests/architecture/boundaries.test.ts` — **no new client component is introduced here.**
If that changes, add it to that list or the rule silently does not cover it.

**E2E case** (`tests/e2e/admin-inbox.spec.ts`): sign in as admin, filter `kind=audio`,
assert the entry renders an `audio` element whose `src` matches
`/api/admin/inbox/submissions/.+/audio` and contains no `.data` / no absolute path.
Child-facing strings go through `expectChildSafe` where the existing spec does.

**Acceptance evidence**

```bash
npx vitest run tests/unit/admin-inbox-route.test.ts tests/unit/admin-inbox-query.test.ts tests/unit/http-admin-inbox-client.test.ts
rm -rf .data && E2E_PORT=3199 npx playwright test tests/e2e/admin-inbox.spec.ts
git checkout -- AGENTS.md next-env.d.ts
```

**Commit**
```bash
git add src/app/api/admin/inbox/submissions/route.ts src/app/admin-inbox-query.ts \
        src/app/components/admin-inbox-view.tsx tests/unit/admin-inbox-route.test.ts \
        tests/unit/admin-inbox-query.test.ts tests/unit/http-admin-inbox-client.test.ts \
        tests/e2e/admin-inbox.spec.ts
git commit -m "feat(MCL-49): show recordings in the protected inbox and let an adult play them"
```

---

### T7 — JSONL rollback and import compatibility

**REQ:** AC3, AC9. **This is the gap most likely to be missed: it is silent.**

**Files**
- Modify `src/adapters/persistence/inbox-record-shape.ts`
- Modify `scripts/import-inbox-jsonl.mjs`
- Modify `tests/unit/file-submission-inbox-store.test.ts`
- Modify `tests/integration/import-inbox-jsonl.test.ts`

**Why it matters.** `readInboxRecord` pushes a `kind` defect for anything that is not
`"text"`. The file store calls it from `readAll()` and **skips** the line, logging it as
damaged. So today: run the app on the file store (the MCL-48 rollback path), submit a
recording, and the line is written — then never read back. The duplicate check does not
see it, so a retry appends a **second** line with a **second** receipt, and the admin view
shows neither. Same class of bug on the import side: the importer refuses the line and the
whole cutover fails, which is at least loud.

**Step 1 — failing tests first**

`tests/unit/file-submission-inbox-store.test.ts`:
- append an `AudioInboxRecord`, then `list({})` → the audio entry comes back with all five
  `audio.*` fields (fails today: entry is skipped)
- append the same `AudioInboxRecord` twice → second call returns
  `{stored:false, existing}` with the first receipt (fails today: appends twice)
- a line with `kind: "video"` → skipped, counted in the `damaged` console.error, and does
  **not** block a later valid append (must keep passing)

`tests/integration/import-inbox-jsonl.test.ts`:
- a source file containing **one text line and one audio line** → import succeeds, **two**
  rows in `submission_inbox`, the audio row has all five media columns populated and
  `original_text IS NULL`, the text row is unchanged
- a source file containing a line with `kind: "video"` → the run **fails loudly**, exits
  non-zero, names the line number, and **nothing is written** (the transaction rolls back)
- re-running the mixed import → `imported 0, already present 2`, no conflict

**Step 2 — widen `readInboxRecord`**

Discriminate on `kind` and read the payload per member. The union-building must stay
*construction*, not a cast, so a new `InboxRecord` field is a compile error here. For
audio, validate: `audio` is an object; `objectKey` non-empty string; `mimeType` passes
`isAudioMimeType`; `extension` non-empty; `sizeBytes` a positive safe integer; `sha256`
passes `isSha256Hex`. A defect key per failing field, same as the text side. Update the
module docblock — it currently says the check is text-only on purpose.

**Step 3 — widen the importer**

`scripts/import-inbox-jsonl.mjs` is plain `.mjs` with no build step and **cannot import**
`inbox-record-shape.ts`; the duplication is deliberate and its policy is the opposite
(refuse, never skip). Widen `COLUMNS` to the twelve the adapter uses, widen `INSERT` to
`$1..$12`, widen `IMMUTABLE_FIELDS` and `storedValues` so the conflict comparison still
covers every immutable field including the media ones, and keep the `kind` check as a
**refusal** for anything outside `text | audio`.

**Acceptance evidence**

```bash
npx vitest run tests/unit/file-submission-inbox-store.test.ts
export MCL_TEST_DATABASE_URL="postgresql://benjaminpoersch@localhost:5432/mcl_test"
npx vitest run tests/integration/import-inbox-jsonl.test.ts
/usr/bin/grep -c '\$12' scripts/import-inbox-jsonl.mjs        # → at least 1
```

**Commit**
```bash
git add src/adapters/persistence/inbox-record-shape.ts scripts/import-inbox-jsonl.mjs \
        tests/unit/file-submission-inbox-store.test.ts tests/integration/import-inbox-jsonl.test.ts
git commit -m "fix(MCL-49): stop the rollback path and the cutover importer from dropping recordings"
```

---

### T8 — Documentation, foundation list, contracts

**REQ:** AC2, AC5, AC9, AC10, AC11; NT11, NT12.

**Files**
- Modify `scripts/check-foundation.mjs`
- Modify `CLAUDE.md` — **only** the stale "52 required paths" number. Nothing else in that
  file; it carries an unrelated uncommitted modification and this commit must not widen it.
- Create `docs/ops/MCL-49-audio-storage.md`
- Modify `docs/deploy/vps-mc-legends.md`
- Modify `docs/ops/MCL-48-backup-restore.md` (the media stream — the script itself lands in T10)
- Modify `SECURITY.md`
- Modify `.env.example` if T4b left anything undocumented

**Foundation list.** Append the MCL-49 paths:
`src/domain/media/audio-artifact.ts`, `src/application/media/audio-blob-store.ts`,
`src/adapters/persistence/file-audio-blob-store.ts`,
`src/app/api/inbox/submissions/audio/route.ts`,
`src/app/api/admin/inbox/submissions/[submissionId]/audio/route.ts`,
`db/migrations/0002_submission_audio.sql`, `docs/ops/MCL-49-audio-storage.md`.
Then **count the resulting array from the file** and write that number into `CLAUDE.md` —
it currently says 52 and the array holds 56 before this task.

```bash
node -e 'const s=require("fs").readFileSync("scripts/check-foundation.mjs","utf8");console.log(s.slice(s.indexOf("const required"),s.indexOf("];")).split("\n").filter(l=>l.trim().startsWith("\"")).length)'
```

**`docs/ops/MCL-49-audio-storage.md`** must state plainly, and must **not** invent a
retention period:

1. **Where the bytes are** — `AVALORIA_MEDIA_DIR`, default `.data/media`; production
   `/data/media` inside the container = `/opt/mc-legends/data/media` on the host.
2. **Persistent host/container mapping** — a bind mount, outside the container's writable
   layer, so a Coolify redeploy or restart does not take the recordings with it (AC2, AC9).
   Name the exact `docker run -v` / Coolify volume entry.
3. **Required mode and ownership** — directory `0700`, owned by the uid the container runs
   as; files inherit `0600` from the adapter's `open(..., "wx")` under the default umask —
   **state the measured mode rather than the assumed one** (`stat -c '%a %U:%G'`).
4. **Private, non-web-root** — nothing serves the directory over HTTP; there is no static
   route, no nginx `location`, no public URL. Playback is the admin-gated route only (AC1, AC8).
5. **Content-addressed object keys** — `<sha[0:2]>/<sha>.<ext>`, derived from a
   server-computed digest and the domain's extension table; never from a client filename.
   **Consequence for deletion:** keys are shared, so removing one submission's row must not
   unconditionally delete its blob (migration 0002 already records this).
6. **Retention / deletion: OPEN.** A product and privacy decision, not a technical one. No
   period is stated here and none is implemented. (AC11 — this is the criterion.)
7. **Persistence and retry semantics** — the D1 order; the D2 partial-failure rule; a retry
   converges because the key is content-addressed and `submission_id` is the primary key.
   State honestly that the file adapter's idempotency is **process-local** and that
   content-addressing (not locking) is what makes a concurrent double-write harmless.
8. **Backup obligations** — `pg_dump` does **not** cover these files; the media stream in
   T10 does; both are required for a recoverable system (AC10).
9. **Size cap** — 8 MiB / 8388608 bytes, enforced in three places that must agree:
   `AVALORIA_AUDIO_MAX_BYTES`, the reverse proxy (`client_max_body_size`, must be *higher*
   for framing overhead — nginx's default is 1 MiB, so an omitted directive rejects almost
   every recording before the app sees it), and the CHECK in migration 0002 (AC5).
10. **Readiness** — `/api/health/ready` reports `storage: "ok" | "unavailable"` from a real
    write-and-remove probe, 503 on unavailable, and the response body carries no path and
    no error text (NT11, NT12; the assertions live in
    `tests/unit/health-ready-route.test.ts`).

**Deploy runbook** gains a section: create `/opt/mc-legends/data/media` mode `0700`, set
`AVALORIA_MEDIA_DIR=/data/media` in `app.env`, the volume mapping, and a fresh disk reading.

**SECURITY.md** — record that the allowlist and size cap it pre-committed to now exist and
where.

**Acceptance evidence**

```bash
npm run check:foundation          # → foundation-structure: ok
/usr/bin/grep -c 'AVALORIA_MEDIA_DIR' docs/ops/MCL-49-audio-storage.md docs/deploy/vps-mc-legends.md .env.example
/usr/bin/grep -in 'retention' docs/ops/MCL-49-audio-storage.md   # must show OPEN, no period
```

**Commit**
```bash
git add scripts/check-foundation.mjs CLAUDE.md docs/ops/MCL-49-audio-storage.md \
        docs/deploy/vps-mc-legends.md docs/ops/MCL-48-backup-restore.md SECURITY.md .env.example
git commit -m "docs(MCL-49): write down where recordings live, what backs them up, and what is still undecided"
```

> **`CLAUDE.md` warning.** It already carries an unrelated working-tree modification.
> Before this commit, `git diff CLAUDE.md` and confirm the only change you are adding is
> the path count. If the pre-existing edit is entangled, **leave `CLAUDE.md` out of this
> commit entirely** and record the stale count as a known gap instead. Do not reset it.

---

### T10 — Media backup and restore

**REQ:** AC10. **Correction to the previous session: this is not purely an external blocker.**

**Files**
- Create `scripts/backup-mc-legends.sh` (repository-controlled, per D10)
- Modify `docs/ops/MCL-48-backup-restore.md` — reference the script instead of a second
  doc-embedded heredoc; add a media drill section and a drill row
- Modify `scripts/check-foundation.mjs` — add the new script

**The script must produce one externally restorable backup set covering both streams:**

1. **PostgreSQL** — `pg_dump --format=custom --no-owner` over ssh, exactly as the existing
   doc-embedded script does. Verify at backup time with `pg_restore --list`, and fail on an
   empty listing.
2. **Private media** — `tar` of `/opt/mc-legends/data/media` streamed over ssh, plus a
   **SHA-256 manifest generated on the VPS** (`find … -type f -exec sha256sum {} +`) stored
   alongside the archive. The manifest is what makes the restore drill provable: it is the
   source-side truth, captured before transfer.
3. Both artefacts land in one timestamped directory on the MacBook. Pull, never push — the
   VPS holds no credential for this machine and opens no inbound port, so a compromised VPS
   cannot reach or delete these copies (the existing doc's reasoning, unchanged).
4. `set -euo pipefail`; explicit `PATH` (launchd starts jobs with a minimal PATH containing
   no Homebrew); `ssh -o BatchMode=yes` so an unattended run fails instead of hanging on a
   prompt; prune old sets **only after** a new one is taken and verified.
5. The script prints what it did — how many bytes, how many media files, the manifest line
   count — per the repo's "scripts report what they applied" convention.

**The drill** — into an isolated location, never over production:

```bash
# 1. Take the backup set
./scripts/backup-mc-legends.sh

# 2. Restore the media stream into a scratch directory (NOT /opt/mc-legends/data/media)
mkdir -p /tmp/mcl-restore-drill && tar -xf <set>/media-<stamp>.tar -C /tmp/mcl-restore-drill

# 3. The proof: recompute and compare against the source-side manifest
cd /tmp/mcl-restore-drill && shasum -a 256 -c <set>/media-<stamp>.sha256

# 4. Restore the database into a SCRATCH database, never over `mcl`
createdb -p 5433 mcl_restore_drill
pg_restore -p 5433 -d mcl_restore_drill --exit-on-error <set>/mcl-<stamp>.dump

# 5. Cross-check the two streams: every audio row's object key must exist in the restore
psql -p 5433 -d mcl_restore_drill -tAc \
  "select media_object_key from submission_inbox where kind='audio'" \
| while read -r k; do test -f "/tmp/mcl-restore-drill/$k" || echo "MISSING $k"; done

# 6. Clean up. Do not leave a copy of family answers lying around.
dropdb -p 5433 mcl_restore_drill && rm -rf /tmp/mcl-restore-drill
```

Step 5 is the one that makes the two streams a single recoverability story rather than two
files: a database restore whose object keys point at nothing is not a restore.

> **Port note, carried from the MCL-48 runbook:** the drill needs PostgreSQL ≥ 17 for the
> production dump format, and 5432 belongs to the local 15 cluster. Run the 17 cluster on
> **5433** for the drill and stop it afterwards. Do not `brew services start postgresql@17`.

**Gate — be explicit about which half ran.**

- If ssh to `srv1308064.hstgr.cloud` works: run the real drill, record the artefact paths,
  the media file count, the `shasum -c` output line-for-line, and the step-5 result. Append
  a dated drill row to `docs/ops/MCL-48-backup-restore.md`.
- If there is **no media on the VPS yet** (likely — MCL-30B has not shipped, so no child
  has sent a recording): seed **one** known artefact by uploading through the real
  authenticated route against the deployed app, or by writing a single test file into
  `/opt/mc-legends/data/media` with a recorded SHA-256. Prove *that* artefact round-trips.
  Say which of the two you did.
- If ssh is unavailable from this session: run the **same drill locally** against
  `.data/media` and the local `mcl_test` database so the script itself is proven, then
  record the VPS half as
  `BLOCKED: <exact runtime gate>` — the precise failure (`ssh: connect to host … port 22:
  Operation timed out`, a missing key, a passphrase prompt), not "no access".
  **In that case MCL-49 is not reported complete on AC10.**

**Acceptance evidence**

Exact artefact paths, the media file count, verbatim `shasum -a 256 -c` output, the step-5
missing-key check (must print nothing), and the drill row appended to the runbook. Or the
verbatim blocker.

**Commit**
```bash
git add scripts/backup-mc-legends.sh docs/ops/MCL-48-backup-restore.md scripts/check-foundation.mjs
git commit -m "feat(MCL-49): back up the recordings alongside the database, and prove a restore"
```

---

### T11 — Slice gate

**REQ:** all. Every number below must come from the **final** HEAD. Do not carry a count
forward from an earlier commit.

```bash
git checkout -- AGENTS.md next-env.d.ts 2>/dev/null || true
source ~/.nvm/nvm.sh && nvm use
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
export MCL_TEST_DATABASE_URL="postgresql://benjaminpoersch@localhost:5432/mcl_test"

git rev-parse HEAD                                       # record it; every row below binds to this

DATABASE_URL="$MCL_TEST_DATABASE_URL" npm run db:migrate  # 0001 + 0002 applied
npm run check:foundation
npm run check:secrets
npm run lint
npm run typecheck
npm run test                                             # full vitest, integration included
npm run check:integration-ran                            # FAILS if integration self-skipped
npm run test:architecture

AVALORIA_FAMILY_ACCESS_CODE=local-canary-family-1 \
AVALORIA_SESSION_SECRET=local-canary-secret-1 \
AVALORIA_ADMIN_ACCESS_CODE=local-canary-admin-1 npm run build

AVALORIA_FAMILY_ACCESS_CODE=local-canary-family-1 \
AVALORIA_SESSION_SECRET=local-canary-secret-1 \
AVALORIA_ADMIN_ACCESS_CODE=local-canary-admin-1 npm run check:client-secrets

rm -rf .data && E2E_PORT=3199 npx playwright test
npm audit --audit-level=high                             # CI's dependency gate

git checkout -- AGENTS.md next-env.d.ts
git status --porcelain                                   # only ` M CLAUDE.md`, `?? .claude/`, `?? docs/plans/…sprint-513…`
```

Record each as `PASS` / `FAIL` / `not_run: <reason>` / `BLOCKED`, with the exit status and
the test counts vitest and Playwright actually printed. **All three secret values must be
set, identically, in the same shell for both the build and the scan** — the scan silently
drops unset names and a value differing from the build's passes vacuously.

Baseline to compare against (measured on `1084417`, from the sprint plan): unit+integration
33 files / 404 tests / 0 skipped; `check:integration-ran` `total=39 passed=39`; Playwright
86 passed. The final numbers will be higher; report them, do not reuse these.

---

### T12 — GitHub delivery

```bash
git status --porcelain                       # scope check, again, right before pushing
git log --oneline 1084417..HEAD              # the full commit list
git diff --name-status 1084417..HEAD         # the changed-file list for the report

git push -u origin feat/MCL-49-private-audio-storage
gh pr create --base main --title "MCL-49: original audio in private durable storage" --body "…"
gh pr view --json number,url,headRefOid
~/.claude/scripts/gh-ci-wait DYAI2025/MC_legends <head-sha> 1200
gh run list --branch feat/MCL-49-private-audio-storage --limit 5
```

PR body: what changed, the T11 evidence table, and a "Still open, deliberately" section
naming retention/deletion policy (AC11) and anything BLOCKED from T10.

**Do NOT merge.** This is an explicit orchestrator merge gate — the implementation has had
no independent diff review. Do not touch PR #30 / MCL-63. Do not start MCL-30B, MCL-35,
MCL-64 or any Cloudflare work.

Report: branch, exact head SHA, PR number and URL, changed-file list, CI run ids and
conclusions.

---

## AC → task → evidence matrix

| AC | Implemented by | Evidence |
|---|---|---|
| AC1 private, non-public persistent file storage | `FileAudioBlobStore` (`91e8e67`), T4c step 9 | `tests/unit/file-audio-blob-store.test.ts`; T4c case 13; no static route serves the dir (T8 §4) |
| AC2 survives redeploy/restart | `AVALORIA_MEDIA_DIR` (`e3db9c3`), T8 §2 | Deploy runbook volume mapping; T10 drill; **runtime proof needs the VPS** |
| AC3 DB holds objectKey, submissionId, MIME, extension, size, SHA-256, createdAt | migration 0002 (`0a0af66`), `PostgresSubmissionInboxStore` | `tests/integration/postgres-submission-inbox-store.test.ts`; T4c case 13; T5a contract case 3 |
| AC4 strict MIME + extension allowlist | `AUDIO_MIME_EXTENSIONS` (`c18d2d5`), CHECKs in 0002 | `tests/unit/audio-artifact.test.ts`; T4c cases 2, 9, 10, 11 |
| AC5 upload size bounded and documented | `audioMaxBytes()`, CHECK in 0002, T4a, T8 §9 | T4c cases 4, 5; `.env.example`; `docs/ops/MCL-49-audio-storage.md` |
| AC6 not served as executable web content | T5b headers; extension from the domain table only | T5b cases 6, 8; `file-audio-blob-store` `OBJECT_KEY` built from the allowlist |
| AC7 original bytes never altered | write-once content-addressed store; read-only playback; no transcode anywhere | T4c case 13 (digest of what arrived); T5b case 5 (byte-identical round trip); T5b case 9 (no mutation verb) |
| AC8 server-side authorization, no public media URLs | family gate on upload, admin gate on playback | T4c cases 1, 19, 20; T5b cases 1, 2, 10, 11, 12, 13 |
| AC9 restart loses nothing | fsync + atomic rename + directory fsync; bind mount | `file-audio-blob-store.test.ts`; T7 (rollback path reads audio back); T10 drill |
| AC10 backup covers audio, restorable off the VPS | T10 script + drill | `shasum -a 256 -c` output; step-5 cross-check; **or the exact blocker** |
| AC11 retention marked OPEN | T8 §6 | `docs/ops/MCL-49-audio-storage.md`; migration 0002's non-unique note |

## Negative-test → case matrix

| NT | Where |
|---|---|
| NT1 > 8 MiB | T4c 4, 5 |
| NT2 unsupported MIME | T4c 2, 10 |
| NT3 header/magic mismatch | T4c 9, 11 |
| NT4 filename/traversal | T4c 12; T5b 8; `file-audio-blob-store.test.ts` `pathFor` cases |
| NT5 executable extension | T4c 10, 12; `OBJECT_KEY` regex derived from `AUDIO_MIME_EXTENSIONS` |
| NT6 unauthorized playback | T5b 1, 2 |
| NT7 DB fails after blob → no receipt | T4c 17 |
| NT8 storage fails → no DB row, no receipt | T4c 16 |
| NT9 retry idempotent | T4c 14 |
| NT10 two submissions share one blob | T4c 15 |
| NT11 readiness reports storage unavailable | `tests/unit/health-ready-route.test.ts` (exists) — **re-verify on final HEAD** |
| NT12 readiness leaks no path | same file — assert the response body keys, not just the status |

---

## Risks and rollback

| ID | Risk | Mitigation |
|---|---|---|
| R1 | `CLAUDE.md`'s pre-existing modification gets swept into an MCL-49 commit | Every commit names files explicitly. `git status --porcelain` checked at T11 and again at T12. T8 has its own warning. |
| R2 | Playwright rewrites `AGENTS.md` / `next-env.d.ts` and CI fails on the dirty file | `git checkout -- AGENTS.md next-env.d.ts` after every e2e run and before every commit; CI has the `Require committed next-env types` step that catches it anyway |
| R3 | The shimmed `grep`/`head`/`diff` in this shell produce false evidence | Use `/usr/bin/grep`, `cmp`, `shasum -a 256`, and `/usr/bin/diff` by absolute path for anything reported as proof. Prefer integers and empty diffs. |
| R4 | The audio route accepts a `questionId` for a question that does not exist (D3) | Deliberate: matches the text route. MCL-35 fixes both or neither. Recorded in the PR's "Still open". |
| R5 | `sniffAudioMimeType` accepts EBML for both WebM and Matroska; a `.mkv` video container passes | Known and documented in the domain module. The stored type is still on the allowlist and the extension is still server-chosen, so AC4 and AC6 hold. Not widened here. |
| R6 | No client sends audio yet (MCL-30B), so the route has no production traffic | Expected. This slice is the server boundary; the e2e proof is the admin path plus route-level tests. Say so in the handoff rather than implying an end-to-end child journey works. |
| R7 | T10's VPS drill cannot run from this session | Run the drill locally to prove the script, report the VPS half as `BLOCKED: <exact gate>`, and **do not claim AC10** |
| R8 | Media disk fills on a 94%-full VPS (recorded in memory) | T8 records the measured free space and the resulting max-recording budget; T10's script prunes only after a verified new set |

**Rollback.** Every commit is additive except T7 and T5c, and none drops a column or a
file. To back out the slice: `git revert` the range, or simply do not merge — nothing is
deployed by this plan. Migration 0002 is already on the branch and is forward-only; it does
not run anywhere until `db:migrate` is executed against a real database, and it leaves
existing text rows untouched (`original_text` stays NOT NULL for them via
`submission_inbox_kind_shape`). The file store remains MCL-48's rollback path and, after
T7, no longer loses recordings when it is used.

---

## Handoff rule

The final report must separate: observed/implemented facts · Jira-planned behaviour ·
assumptions · blockers and not-run validation. Do not mark Jira Done.

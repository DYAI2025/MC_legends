# MCL-49 — Private audio storage: where recordings live and what is still undecided

Living runbook. It describes the code as merged and the deployment as **measured on
2026-08-21**, and it names two things the production host does not do yet. When this
document and the code disagree, the code and its tests win — say so rather than trusting
either silently.

---

## 1. Where the bytes are

| | |
|---|---|
| Variable | `AVALORIA_MEDIA_DIR` (read only in `src/composition/server.ts`) |
| Default | `.data/media`, relative to the process working directory |
| Production intent | `/data/media` inside the container = `/opt/mc-legends/data/media` on the host |
| Adapter | `FileAudioBlobStore` (`src/adapters/persistence/file-audio-blob-store.ts`) |
| Object key | `<sha256[0:2]>/<sha256>.<extension>` |

Blank counts as unset: the composition root uses `||`, not `??`, so a host UI that defines
the variable and leaves it empty falls back to the default instead of handing `mkdir` an
empty path.

`AVALORIA_MEDIA_DIR` is deliberately **not** a subdirectory of `AVALORIA_INBOX_DIR`. That
directory holds MCL-48's small JSONL rollback artefact, which has to stay readable by eye;
this one holds megabytes, with a different backup sizing, a different growth curve and a
different retention question. One path would mean one volume, one quota, and one restore
that has to succeed for either to work.

---

## 2. Persistence across a redeploy — and the gap on the host today

The directory must be a **bind mount or volume**, outside the container's writable layer.
A Coolify redeploy replaces that layer; anything inside it goes with it.

The mount already exists and is correct:

```
$ docker inspect mc-legends --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
/opt/mc-legends/data -> /data
/var/run/postgresql -> /var/run/postgresql
```

> **GAP, measured 2026-08-21 — `AVALORIA_MEDIA_DIR` is not set on the running container.**
> `docker inspect mc-legends --format '{{range .Config.Env}}{{println .}}{{end}}'` lists
> `AVALORIA_INBOX_DIR` and not `AVALORIA_MEDIA_DIR`. With the variable unset the app falls
> back to `.data/media` **inside the container**, which is precisely the ephemeral layer
> AC2 and AC9 forbid: the first redeploy would take every recording with it, silently and
> irreversibly.
>
> Nothing has been lost yet only because nothing has been sent yet. **That safety margin
> ends with MCL-30B**, which wires the child UI to this route: from the moment that branch
> is deployed, every recording a child sends lands in the container's writable layer and the
> next redeploy destroys it, silently and irreversibly. **`AVALORIA_MEDIA_DIR` must be set
> to `/data/media` on the container, and `/opt/mc-legends/data/media` must exist on the
> host, BEFORE the MCL-30B build is deployed** — not before the first recording is noticed.
> The step is in `docs/deploy/vps-mc-legends.md` §5.1, and MCL-64 owns the runtime gate that
> proves it.

`/opt/mc-legends/data/media` does not exist on the host yet; `ls -la /opt/mc-legends/data`
showed only `inbox/` on 2026-08-21.

---

## 3. Modes and ownership — measured, not assumed

The adapter sets every mode explicitly rather than inheriting the process umask:

| Object | Mode | Set by |
|---|---|---|
| Media root, when the adapter creates it | `0700` | `mkdir(..., { mode: 0o700 })` in `checkWritable` |
| Shard directory (`ab/`) | `0700` | `mkdir(..., { mode: 0o700 })` in `store` |
| Stored recording | `0600` | `open(temporary, "wx", 0o600)` |

Measured on macOS with the default umask `022` **before** those modes were explicit: the
blob landed `0644` and its shard `0755`. `open` defaults to `0666` and `mkdir` to `0777`,
so the privacy of a child's recording depended on how somebody happened to start the
process. `tests/unit/file-audio-blob-store.test.ts` now pins all three numbers.

**What the code cannot do for you:** `mkdir` applies a mode only to directories it
*creates*. An existing media root keeps whatever mode it already has. On the host that
means the mode of `/opt/mc-legends/data/media` is an operator obligation:

```bash
install -d -m 0700 -o root -g root /opt/mc-legends/data/media
stat -c '%a %U:%G' /opt/mc-legends/data/media    # expect: 700 root:root
```

`/opt/mc-legends/data` itself was measured `drwx------ root root` on 2026-08-21, which is
already correct.

---

## 4. Nothing serves this directory over HTTP

There is no static route, no nginx `location`, no signed link and no public media URL.
The only path from a stored file to a listener is:

```
GET /api/admin/inbox/submissions/<submissionId>/audio
```

behind the **admin** gate (`AVALORIA_ADMIN_ACCESS_CODE`, a different secret from the
family code the children hold). The route takes a submission id and never an object key —
a route that accepted a key would be a way to ask this application for a file rather than
for a submission, however carefully the value were then checked.

The response is built to be inert:

| Header | Value | Why |
|---|---|---|
| `content-type` | the **stored** mime type | Checked against the container's own bytes at upload; never guessed here, never taken from a client |
| `x-content-type-options` | `nosniff` | Stops the browser looking for a better idea than the one it was given — the mechanism by which a stored file becomes executable content |
| `content-security-policy` | `default-src 'none'; sandbox` | Even a response that somehow rendered as a document could not fetch, script or navigate |
| `cache-control` | `private, no-store` | A child's recording must not sit in a shared cache or on a proxy's disk |
| `content-disposition` | `inline; filename="antwort-<id>.<ext>"` | Built from the submission id and the stored extension only |

The filename stem is reduced to `[A-Za-z0-9_-]`. The dot is excluded on purpose: measured
while writing the route, a submission id of `sub"; filename="evil.php` otherwise produced
`antwort-sub---filename--evil.php.webm` — the multi-extension shape a host that dispatches
on any extension in a name will execute.

Both "no such submission" and "that one is a typed answer" answer **404**. Telling them
apart would make the route an existence oracle for submission ids.

---

## 5. Content-addressed object keys, and what that means for deletion

The key is `<sha256[0:2]>/<sha256>.<extension>`, built from a digest this server computed
and an extension read out of `AUDIO_MIME_EXTENSIONS` in `src/domain/media/audio-artifact.ts`.
**No client filename is read, stored, logged or derived from** — there is no code path that
accepts one, which is why there is no sanitisation step to forget.

Two consequences worth stating out loud:

1. **A retry is free.** The same bytes produce the same key, so re-storing an
   already-stored recording is a `stat` and nothing else.
2. **Keys are shared.** Two children forwarding the same voice memo produce one file.
   Migration `0002` is therefore deliberately **not** unique on `media_object_key`, and it
   carries that reasoning in a comment. **Removing one submission's row must not
   unconditionally delete its blob** — it may be another child's answer.

---

## 6. Retention and deletion: OPEN

> **POLICY_NEEDED — no retention period is defined, and none is implemented.**
>
> How long a recording may be kept, who decides, what a deletion request has to reach
> (the blob, the row, the backups, the manifests) and what happens to a blob two
> submissions share are **product and privacy decisions**, not technical ones. MCL-49
> requires this to stay marked open until it is decided separately.
>
> No number appears in this document, in the code or in the schema. If you find one, it
> was invented by whoever wrote it and is not a policy.

This interacts with §5: a deletion that walks rows and unlinks their object keys would
delete other children's recordings. Whatever is decided has to account for that.

---

## 7. Persistence and retry semantics

The upload route (`src/app/api/inbox/submissions/audio/route.ts`) runs one order, and the
order is the load-bearing part:

```
guard -> declared type -> declared size -> identifiers -> read bytes (capped)
      -> sniff container -> hash -> describe -> BLOB -> ROW -> receipt
```

- **A positive receipt exists only after both stages succeeded.** The receipt is minted
  into the record before the append because the row has to carry it, but it is never
  *returned* unless the append resolved.
- **Storage fails → no database row and no receipt** (503). Nothing has touched the
  database, which is the whole point of doing the blob first.
- **Database fails after the blob was written → no receipt** (503), and **the blob is not
  deleted**. A row referencing a recording that was never written is unrecoverable and
  invisible; an orphan blob is inert, self-heals on retry because the key is
  content-addressed, and may already belong to another submission (§5).
- **A retry converges.** `submission_id` is the primary key, so the second delivery is
  answered `200` with the receipt the first one got.

Honest limits: the **file** adapter's idempotency is **process-local** — two app processes
writing one directory can both read "absent" and both append. The durable answer is the
PostgreSQL primary key. What makes a concurrent double *blob* write harmless is content
addressing plus the atomic temp-write-fsync-rename-fsync, not locking.

### 7.1 The browser side of the same contract (MCL-30B)

The client half is `HttpAudioAnswerInbox` (`src/adapters/http/http-audio-answer-inbox.ts`),
driven by `AudioAnswerSender` (`src/adapters/media/audio-answer-sender.ts`). Four decisions
in it are what make the retry semantics above reachable from a child's browser:

| Decision | Why |
|---|---|
| **One `submissionId` per recording, not per press** | Minted on the first attempt and keyed to the captured object's identity. It is what makes the convergence above happen: after an ambiguous failure the retry carries the same id, so the route answers `200` with the receipt it already minted instead of filing a second answer. Re-recording or picking a different file mints a new one. |
| **The declared type is sniffed, not read off the Blob** | The route refuses a request whose declared `content-type` disagrees with what it sniffs from the bytes. A browser labels a recording `audio/webm;codecs=opus` and a picked file `audio/x-m4a`, `audio/mp3` or nothing at all — none of which are allowlist members. The client runs the domain's own `sniffAudioMimeType` over the first 16 bytes, so the two sides agree by construction. |
| **Upload deadline 120 s, not the text inbox's 10 s** | 8 MiB in 10 s needs 6.7 Mbit/s of upload. 120 s tolerates roughly 0.6 Mbit/s at the ceiling. It is a *total* deadline, not an idle one — fetch offers no upload-progress signal without duplex streaming — so a slower uplink ends as a retryable failure with the recording still in hand. |
| **`sent` is reachable only from a receipt** | `readServerReceipt` (`src/adapters/http/server-receipt.ts`) is the single definition of an acknowledgement for both inboxes. A `200`/`201` that says `acknowledged: true` without two non-blank receipt fields is a refusal, not an arrival. |

**Known limitation, deliberate and recorded rather than fixed:** a finished recording that
has not been sent lives only in the page's memory. An ordinary re-render or a topic change
keeps it (pinned by an e2e case); a reload, a tab close or a hard navigation loses it. This
slice does not persist audio bytes to IndexedDB — that would be an offline-sync subsystem
nobody has asked for, and the child-facing note in the recording area says plainly that the
recording is gone if the page is reloaded before it is sent.

**Second known limitation:** discarding a recording while its upload is in flight does not
un-send it. The bytes may already have reached the route, in which case a row exists for a
recording the child threw away. The recording area therefore disables *discard* and
*re-record* for the duration of an attempt, so the only way to reach that state is a
connection that outlives the page.

---

## 8. Backup obligations

`pg_dump` of `mcl` does **not** cover these files. A database restore whose object keys
point at nothing is not a restore.

Both streams are required, and both are taken by `scripts/backup-mc-legends.sh`:

1. `pg_dump --format=custom --no-owner` of `mcl`, verified with `pg_restore --list`.
2. A `tar` of the media directory plus a **SHA-256 manifest generated on the VPS**, which
   is the source-side truth captured before transfer and the thing that makes a restore
   drill provable.

The transferred archive is checked **by digest** against that manifest before the backup
reports success or prunes anything — `scripts/verify-media-archive.sh`, called from the
backup script and run on every `npm run test` by
`tests/unit/verify-media-archive.test.ts`. Until 2026-08-21 the archive was only listed and
counted, which a transfer that corrupted bytes inside a recording survives (PR #31 review
finding F2).

Once audio persistence is live in production, set `MCL_BACKUP_REQUIRE_MEDIA=1` in the
backup job, so a missing media directory fails the run instead of producing a green
database-only set. The exact point at which that stops being optional, with the two
commands that decide it, is `docs/ops/MCL-48-backup-restore.md` §6.1.1.

The drill, including the cross-check that every audio row's object key exists in the
restored media tree, is in `docs/ops/MCL-48-backup-restore.md`.

---

## 9. The size cap: 8 MiB, a ceiling and not a default

`8388608` bytes, decided 2026-08-21.

| Where | What enforces it |
|---|---|
| `MAX_AUDIO_BYTES` (`src/domain/media/audio-artifact.ts`) | The product maximum. `describeAudioArtifact` refuses anything larger — called **before** the blob is written, so the backstop cannot leave an orphan file |
| `AVALORIA_AUDIO_MAX_BYTES` | `audioMaxBytes()` clamps it with `Math.min` and warns once per process; the route refuses from `content-length` first and caps the stream second |
| Migration `0002` | `submission_inbox_media_size_bounded` — survives a redeploy with a stale config |
| `FileSubmissionInboxStore` | The same refusal in the MCL-48 rollback path, where no CHECK constraint exists. Both adapters are proven by the shared store contract |
| The reverse proxy | `client_max_body_size`, which must be **higher** to allow for framing overhead |

**Lowering** the configured value works and needs no migration. **Raising** it does
nothing: the composition root clamps to `8388608` and logs one line saying so. Widening the
product maximum is a schema migration first and a code change second, in that order.

> **Repaired 2026-08-21 (PR #31 review finding F1).** `audioMaxBytes()` used to treat
> `8388608` as a *default* and returned any positive configured value. A host that set
> `33554432` widened the upload route past what the database allows, and the two modes then
> failed differently for one request: PostgreSQL wrote the blob first — the correct
> ordering, and exactly why the limit has to be right before that write — then had the row
> refused by the CHECK, leaving a recording on disk that is deliberately never deleted
> after a database failure. The file rollback store refused nothing at all and answered
> with a receipt. Pinned by `tests/unit/audio-max-bytes.test.ts` and by the oversize case
> in `tests/unit/submission-inbox-store-contract.ts`, which runs against both adapters.

> **GAP, measured 2026-08-21 — neither mc-legends vhost sets `client_max_body_size`.**
> `grep -rn client_max_body_size /etc/nginx/` matched `media.dyai.cloud` and
> `coupletimer.site` and **not** `/etc/nginx/sites-enabled/mc-legends` or
> `/etc/nginx/sites-enabled/mclegends.dyai.cloud`. nginx's default is **1 MiB**, so today
> a recording over 1 MiB is rejected by the proxy with `413` before the application ever
> sees it — and the app's own 8 MiB cap, its allowlist and its error vocabulary never run.
>
> The child would see a failure the app cannot explain, because the app was never asked.
> Add `client_max_body_size 12M;` to both vhosts before the first upload. The step is in
> `docs/deploy/vps-mc-legends.md` §5.1.

---

## 10. Readiness

`GET /api/health/ready` reports three independent things:

```json
{ "app": "ok", "database": "ok | not-configured | unavailable", "storage": "ok | unavailable" }
```

`storage` comes from a **real write and removal** (`AudioBlobStore.checkWritable`), not a
`stat`. The three ways this fails in production — a volume that failed to mount and left
an empty directory behind, a filesystem remounted read-only, a full disk — all pass a
`stat` and fail every submission.

503 when either the database or storage is `unavailable`; `not-configured` is 200, because
the file store is a legitimate configuration (it is the rollback path) and paging somebody
for a working app is worse than not paging them.

The body carries **no filesystem path and no error text**. This endpoint is
unauthenticated, so a path in it describes the host's layout to anybody who asks; the
driver's cause and the errno go to the server log instead. Pinned in
`tests/unit/health-ready-route.test.ts`.

`GET /api/health` stays 200 with the database and the volume both broken — it answers
"is this process serving?" and nothing else.

---

## 11. Disk

Measured 2026-08-21 on `srv1308064.hstgr.cloud`:

```
$ df -h /
/dev/sda1        96G   71G   25G  75% /
```

25 G free. At the 8 MiB ceiling that is roughly 3 200 recordings of the worst case, and a
family MVP will not approach it — but the media directory, the PostgreSQL data directory
and every other service on this host share one volume, so the budget is not this feature's
alone. Re-read `df -h /` before enabling uploads and again after the first month.

---

## 12. What this document does not claim

- **No recording has ever been stored in production.** MCL-30B wires the child UI to this
  route, so the code path now exists end to end; whether it has ever run against the
  production host is a separate question this document does not answer. Everything above is
  proven by the test suite and by the deployment facts measured on 2026-08-21, not by
  production traffic.
- **AC2 and AC9 are not runtime-proven.** They need `AVALORIA_MEDIA_DIR` set to the bind
  mount (§2) and a redeploy-and-restart cycle with a real recording present.
- **Retention is undecided** (§6) and deliberately unimplemented.

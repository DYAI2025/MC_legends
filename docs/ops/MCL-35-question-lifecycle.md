# MCL-35 - Closing, rotating and archiving open questions

Living runbook. It describes what the code in this repository does, not what a plan
intended. Where a statement is not currently exercised by a test, it says so.

## What this feature is

An adult with the project credential can **close** a question and **reopen** it, from
`/admin`, without editing source. The child site then asks the next open question by
itself. Nothing is ever deleted: every close and every reopen is a row, and the archive
is those rows.

What it is NOT:

- It is **not** an archive of children's answers. Submissions are untouched by this
  slice - not moved, not hidden, not re-linked. The archive here is of *questions*.
- It is **not** a question editor. The wording of a question is content
  (`src/content/open-questions.ts`), reviewed and deployed like the rest of what children
  read. Changing wording is still a code change, deliberately.
- It is **not** a way to delete a question. There is no such verb, on purpose.

## The data model

`question_lifecycle_event`, added by `db/migrations/0003_question_lifecycle.sql`:

| column | meaning |
|---|---|
| `sequence` | database-assigned total order over every event. The primary key. |
| `question_id` | the id in `src/content/open-questions.ts`. |
| `revision` | this question's own change counter, from 0. `UNIQUE (question_id, revision)`. |
| `action` | `closed` or `reopened`. |
| `previous_state` / `next_state` | both ends of the transition, written out. |
| `occurred_at` | the application clock. |
| `recorded_at` | the database clock, defaulted by `now()`. |

The current state of a question is the `next_state` of its highest-`revision` row, or -
when it has no rows at all - whatever `src/content/open-questions.ts` seeds.

**Nothing updates and nothing deletes.** Reopening appends a second row next to the
first. That is why "a closed question stays traceably archived" and "reopening does not
erase the close" are the same sentence here: there is no row to overwrite.

Both clocks are stored because they answer different questions - what the application
believed, and what actually happened in the database. **Neither is used for ordering.**
Two events can share a millisecond and an application clock can step backwards;
`sequence` cannot do either.

## Concurrency

`UNIQUE (question_id, revision)` is the entire mechanism.

The adapter appends with one statement that computes the new revision from the latest one
it can see and writes only if the state it was handed still matches the table. Two
callers who both read "revision 0 is the latest" compute the same revision 1 and collide
on the index: one commits, the other gets SQLSTATE 23505 and is reported to the route as
`stale`, which answers **409** with the state that actually holds.

There is deliberately **no advisory lock, no explicit transaction and no raised isolation
level**. A lock would serialise the same outcome at a higher cost and would have to be
taken by every future writer of this table to be worth anything; a unique index is
enforced against all of them whether they know about it or not.

Measured on PostgreSQL 15.18, 24 concurrent closes of one question:

- with the constraint: 1 applied, 1 stored row;
- with the constraint dropped: more than one applied, more than one stored row.

So the constraint is load-bearing, not belt-and-braces. The WHERE clause alone is not
sufficient.

## Rotation order

`rotateQuestions` in `src/content/open-questions.ts`:

1. A question that has **never left** the rotation keeps its position in the dataset
   array. The array order in `open-questions.ts` is therefore the turn order, and
   reordering that list reorders what children are asked.
2. A question that has been **reopened** queues **behind all of them**, ordered among
   other reopened questions by the store's `sequence`.
3. `active` is the first of that order whose effective state is open. `upcoming` is the
   rest. `archived` is everything closed, in dataset order.

Rule 2 is what makes **reopening not steal the turn**. With position alone, reopening the
first question in the dataset would instantly take the turn away from whatever a child is
being asked - the answer somebody is halfway through typing would become an answer to a
question the page no longer shows. With recency alone, the dataset order would stop
meaning anything after the first reopen.

If nothing else is open, a reopened question does become active. That is the intended
behaviour and is covered by a test.

`rotateQuestions({})` names the same question as the dataset's `focus: true` flag, and a
test pins that: the seeded start and the rotation rule must not be two different answers.

## What a child sees

Three states, and the middle one is why there are three:

| state | what is shown | is the answer form there? |
|---|---|---|
| a question is active | the question, the form, the recorder | yes |
| no question is open | "Gerade ist keine Frage offen." | no |
| the lifecycle store cannot be read | "Die Frage ist gerade nicht da." | no |

The wording lives in `src/app/question-message.ts` and is checked by
`tests/unit/question-message.test.ts` against the shared child-safe vocabulary plus this
slice's own forbidden words (`geschlossen`, `archiv`, `verwaltung`, `rotation`, …). A
child is never told a question was closed or reopened; those are decisions adults made
about the project.

### The store-outage rule, stated plainly

**A lifecycle read failure does NOT fall back to the seeded dataset.**

That fallback is the tempting one - every page keeps rendering and nothing looks broken -
and it is refused for exactly that reason. The seed is what the project decided before
anyone could change it from the outside. Serving it after the store exists means
presenting a question as current that an adult may have retired weeks ago, and inviting a
child to answer it.

So:

- Child side (`/` and `/welt/[id]`): a child-safe temporary-unavailable panel, no answer
  form, no recorder, no "answer this question" button. The failure is logged server-side
  under the fixed string `question lifecycle read failed`.
- Admin side (`GET /api/admin/questions`, `POST /api/admin/questions/<id>`): **503**. An
  adult must never be able to close a question from a guess about its state.

`src/app/question-rotation-source.ts` is the one place that decides this, so the two
pages cannot drift apart.

## What rotation does NOT do to answers

**Rotation controls what is offered to a child, never what is accepted from one.**

- A typed answer already stored on a device carries its own `questionId` and is delivered
  under it. `deliverSubmission` re-sends the stored submission and never re-reads a
  current question.
- A recording is bound to its question when it **appears**, not when it is sent -
  `AudioAnswerSender.prepare(recording, questionId)`. `send(recording)` takes **one
  argument**, so there is no parameter through which a later question could enter an
  attempt. A retry after an ambiguous timeout therefore carries the same `submissionId`
  **and** the same `questionId`, and converges on one stored answer.
- The inbox routes do **not** refuse a submission whose question is closed, and must not
  be changed to. Refusing would destroy work a child already did because an adult pressed
  a button on another screen.
- When the bound question is no longer the one being asked, the recording area says so in
  child-safe words and keeps offering the send button.

"Meine Ideen" shows which question each stored answer belongs to, by the question's own
wording. Never the id. An answer whose question the site no longer carries reads "Deine
Antwort auf eine frühere Frage."

## The file rollback path

Without `DATABASE_URL`, both the write and the read side use
`FileQuestionLifecycleLog`, an append-only JSONL file at
`${AVALORIA_QUESTION_DIR:-.data/questions}/question-lifecycle.jsonl`.

Its serialisation is a **process-local** write queue. It holds within one process and
nowhere else: two app processes writing the same directory can both read "still open"
before either appends, and both will append. It is neither distributed nor
production-grade. The durable answer is the unique constraint above.

One deliberate difference from the inbox file store: **a line this adapter cannot read is
a thrown read, not a skipped line.** Skipping a damaged submission line loses one answer;
skipping a damaged lifecycle line silently changes what every question's state is derived
to be, and a dropped `closed` event would put a retired question back in front of
children with nothing looking wrong. An unreadable log is an unavailable store, which both
surfaces already know how to say.

Rollback, exactly as MCL-48's: remove `DATABASE_URL` from the environment and restart.
The rows stay in PostgreSQL, unread; the file log takes over from whatever it holds. Note
that the two stores do **not** share state, so a rollback returns to whatever the file log
last recorded, which on a database-backed deployment is usually nothing - i.e. the seeded
questions. That is a real consequence and is the reason the file branch is the fallback
rather than a second production store.

## Inspecting the archive by hand

PostgreSQL:

```sql
SELECT sequence, question_id, revision, action, previous_state, next_state,
       occurred_at, recorded_at
  FROM question_lifecycle_event
 ORDER BY sequence DESC
 LIMIT 50;
```

Current state of every question the store knows about:

```sql
SELECT DISTINCT ON (question_id) question_id, next_state, sequence
  FROM question_lifecycle_event
 ORDER BY question_id, revision DESC;
```

File store:

```bash
cat .data/questions/question-lifecycle.jsonl
```

One JSON object per line, in append order; `sequence` equals the line number, which is
what makes reading the file by eye agree with what the application derived from it.

## Backup

`question_lifecycle_event` is inside the `mcl` database, so it is covered by the same
`pg_dump` that `scripts/backup-mc-legends.sh` already takes - no change to the backup
procedure. `AVALORIA_QUESTION_DIR` is **not** in the media backup and does not need to
be: on a database-backed deployment it is empty, and on a file-only deployment it holds
which questions are open, which is operational state a deployment may legitimately reset.
Children's answers are the thing worth restoring, and they are elsewhere.

## Migration and rollout

`db/migrations/0003_question_lifecycle.sql` is additive only: it creates one table and
alters nothing. An older container that has never heard of it keeps working, and reverting
the application leaves the rows in place and unread. No down-migration is written - the
repository has none, and dropping an archive table is the one thing this design exists to
prevent.

Apply it the same way as the others, inside the container (host Node on the VPS is v22):

```bash
docker exec mc-legends npm run db:migrate
```

## Environment

| variable | meaning |
|---|---|
| `AVALORIA_QUESTION_DIR` | where the JSONL log is written when no database is configured. Default `.data/questions`. Blank counts as unset. Not a secret. |

No new secret is introduced, so `scripts/check-secrets.mjs`,
`scripts/check-client-secrets.mjs`, the secret list in
`tests/architecture/boundaries.test.ts` and the two scan steps in
`.github/workflows/ci.yml` are unchanged.

## Known limits

- Close and reopen are the only two verbs. There is no scheduling, no per-child
  assignment, no authoring UI, and no ordering control beyond the dataset array.
- The archive read by `GET /api/admin/questions` is capped at the 200 newest events. The
  response carries `historyTotal` and the board says when it is showing fewer, so the
  truncation is never silent - but older entries are only reachable through the database.
- There is no retention or deletion policy for lifecycle events, as there is none for
  recordings (recorded in migration 0002). Open product/privacy question.
- The per-address rate-limit keys remain spoofable (`x-forwarded-for`); only the
  constant-key global limiters are a real ceiling. Unchanged by this slice.

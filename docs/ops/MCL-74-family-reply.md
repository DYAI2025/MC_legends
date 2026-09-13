# MCL-74 — "Papa antwortet": running it

Living runbook for the reply loop. What the code does is in the code; this is what an
operator has to know that the code cannot tell them.

## What was added

| Thing | Where |
|---|---|
| `submission_reply` table | `db/migrations/0004_submission_reply.sql` |
| Reply shape rules | `src/domain/replies/reply.ts` |
| Vocabulary + blocked-name check | `src/application/replies/compose-reply.ts` |
| File store (rollback path) | `src/adapters/persistence/file-submission-reply-log.ts` |
| PostgreSQL store | `src/adapters/persistence/postgres-submission-reply-log.ts` |
| Adult write/read route | `POST|GET /api/admin/inbox/submissions/<id>/replies` |
| Child read route | `GET /api/family/replies` |
| Delete path | `scripts/delete-submission.mjs` |

## Environment

| Variable | Required | Notes |
|---|---|---|
| `AVALORIA_REPLY_BLOCKED_NAMES` | no | Comma-separated. **Treated as a secret** — it is a list of real people's names. Blank means no names, which is a valid configuration and not a gate failing open: the child-unsafe vocabulary check runs either way. Matched as whole words, case-insensitively, and never as a pattern. |
| `AVALORIA_REPLY_DIR` | no | Default `.data/replies`. Unused when `DATABASE_URL` is set. |

A new secret name has to be registered in four places or the gates are lying:
`tests/architecture/boundaries.test.ts`, `scripts/check-client-secrets.mjs`, and **both**
env blocks of `.github/workflows/ci.yml`. `AVALORIA_REPLY_BLOCKED_NAMES` is in all four.

## Deploying

1. Deploy as usual (`docs/deploy/vps-mc-legends.md`).
2. Apply migration 0004 **inside the container** — the VPS host runs Node 22 and the
   repo requires 24.18.1:
   ```bash
   docker exec mc-legends npm run db:migrate
   ```
3. Set `AVALORIA_REPLY_BLOCKED_NAMES` in the Coolify secrets if the household wants one.
4. Verify `/api/health/ready`, then post one real reply and reload the child page.
5. **Restart drill:** restart the container and confirm the reply is still on the card.
   A reply that only lived in a process is not a reply.

## Restore order is not symmetrical

`submission_reply.submission_id` carries a foreign key to `submission_inbox`. So:

> **Restore the inbox first, the replies second.**

The other order fails every row. This applies to `scripts/import-inbox-jsonl.mjs` and to
any hand restore. `tests/integration/delete-submission.test.ts` truncates in the same
order for the same reason.

## Deleting a submission

```bash
DATABASE_URL=… node scripts/delete-submission.mjs <submissionId>          # dry run
DATABASE_URL=… node scripts/delete-submission.mjs <submissionId> --apply  # removes it
```

Dry run by default, and that default is not politeness: the cost of the wrong id is a
child's own words. `--apply` removes the replies and the inbox row in one transaction,
then unlinks the media object **only** when no other row references the same
`media_object_key` — object keys are content-addressed, so two identical recordings are
one file.

PostgreSQL only. On the file rollback path, edit the JSONL by hand.

## Known limits, written down rather than discovered

- **Replies are per household, not per child.** The family session is one code for the
  family (MCL-34), so both children see every reply. The card carries the original
  excerpt, or the day of the recording, so a child can tell which one is theirs. A
  per-child profile is out of scope for the Family MVP.
- **No latency promise anywhere in the UI.** No countdown, no "bald". If a reply takes
  two days, the page says "Noch keine Antwort" for two days, which is true. The 24-hour
  reply duty is a commitment by a person, not a property of the software.
- **Polling only while the page is open**, every 60 s, paused while the tab is hidden.
  There is no push and no notification.
- **A failed poll shows nothing.** Not an error, not an empty list. The list a child can
  already see stays as it was.
- **`speechSynthesis` may be absent.** Then the "Vorlesen" button is absent too — not
  disabled. Test on the actual family device; a German voice is not guaranteed.
- **The file store's write queue is process-local.** It is not distributed and not
  production-grade. The durable guarantee is the primary key and the foreign key.

## Author and status

`author` is `human` today and `status` is always `ready`. The `llm` author and the
`fallback` status exist in the schema and the types so MCL-76 swaps the writer without a
migration and without any downstream surface learning a second kind of reply. A
`fallback` reply is deliberately **excluded** from the child's view: a machine's admitted
best effort must not reach a child as though an adult had written it.

#!/usr/bin/env node
/**
 * Remove one submission, its replies and its recording (MCL-74).
 *
 * The only remover in this project. Both stores are append-only by construction and
 * neither adapter has a delete path, which is deliberate - so when something genuinely
 * has to go (a child asks, an adult mis-sends, a test row reaches production) it goes
 * through one reviewed script rather than through whichever hand is nearest to psql.
 *
 * DRY RUN BY DEFAULT. Without `--apply` this prints what it would remove and changes
 * nothing. The cost of the wrong id is a child's own words, and the shape of that
 * mistake is always the same: somebody was sure enough not to look first.
 *
 * PostgreSQL only. The file stores are MCL-48's rollback path, not where a household
 * runs day to day, and a JSONL rewriter is a second delete implementation nobody would
 * exercise until the day it mattered. On the file path, delete the lines by hand and
 * say so in the runbook.
 *
 * Usage:
 *   node scripts/delete-submission.mjs <submissionId>
 *   node scripts/delete-submission.mjs <submissionId> --apply
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const DEFAULT_MEDIA_DIRECTORY = ".data/media";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const submissionId = args.find((value) => !value.startsWith("--"));
const apply = args.includes("--apply");

if (submissionId === undefined || submissionId.trim().length === 0) {
  fail("usage: node scripts/delete-submission.mjs <submissionId> [--apply]");
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  fail("DATABASE_URL is not set. This script is the PostgreSQL delete path (see the header).");
}

const mediaDirectory = process.env.AVALORIA_MEDIA_DIR?.trim() || DEFAULT_MEDIA_DIRECTORY;

const pool = new pg.Pool({ connectionString });

try {
  const found = await pool.query(
    "SELECT submission_id, kind, media_object_key FROM submission_inbox WHERE submission_id = $1",
    [submissionId],
  );

  const row = found.rows[0];
  if (row === undefined) {
    fail(`no submission with id ${submissionId}`);
  }

  const replies = await pool.query(
    "SELECT count(*)::int AS count FROM submission_reply WHERE submission_id = $1",
    [submissionId],
  );
  const replyCount = replies.rows[0]?.count ?? 0;

  /*
    Whether any OTHER row points at the same object.

    Object keys are content-addressed, so two identical recordings share one file. Unlink
    it while a second submission still references it and that other child's recording is
    gone - a delete that quietly destroys something nobody asked to destroy.
  */
  let objectShared = false;
  if (row.media_object_key !== null) {
    const others = await pool.query(
      "SELECT count(*)::int AS count FROM submission_inbox WHERE media_object_key = $1 AND submission_id <> $2",
      [row.media_object_key, submissionId],
    );
    objectShared = (others.rows[0]?.count ?? 0) > 0;
  }

  console.log(`submission:   ${row.submission_id} (${row.kind})`);
  console.log(`replies:      ${replyCount}`);
  console.log(`media object: ${row.media_object_key ?? "none"}`);
  if (row.media_object_key !== null) {
    console.log(
      objectShared
        ? "media file:   SHARED with another submission - it will be kept"
        : "media file:   will be removed",
    );
  }

  if (!apply) {
    console.log("");
    console.log("dry run: nothing was removed. Re-run with --apply to remove it.");
    process.exit(0);
  }

  /*
    One transaction, replies first.

    The foreign key decides the order, and doing it in one transaction is what keeps the
    pair from half-existing: a reply whose submission is gone would draw a card about an
    idea that no longer exists, and the reader skips it rather than showing that - so the
    failure would be silent as well as wrong.
  */
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const removedReplies = await client.query(
      "DELETE FROM submission_reply WHERE submission_id = $1",
      [submissionId],
    );
    const removedSubmission = await client.query(
      "DELETE FROM submission_inbox WHERE submission_id = $1",
      [submissionId],
    );
    await client.query("COMMIT");
    console.log(`removed ${removedReplies.rowCount} reply/replies`);
    console.log(`removed ${removedSubmission.rowCount} submission row`);
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }

  /*
    The file last, and only after the rows are gone.

    This order can leave an orphan file if the process dies here; the other order can
    leave a row pointing at a file that no longer exists, which the playback route would
    answer as a broken recording. An orphan file costs disk. A broken row costs an adult
    an afternoon working out which recording is missing and why.
  */
  if (row.media_object_key !== null && !objectShared) {
    try {
      await unlink(join(mediaDirectory, row.media_object_key));
      console.log(`removed media file ${row.media_object_key}`);
    } catch (cause) {
      if (cause?.code === "ENOENT") {
        console.log(`media file ${row.media_object_key} was already gone`);
      } else {
        throw cause;
      }
    }
  }

  console.log("done");
} finally {
  await pool.end();
}

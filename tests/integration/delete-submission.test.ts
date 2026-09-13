import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  lockSubmissionInboxTable,
  unlockSubmissionInboxTable,
} from "../support/submission-inbox-table-lock";

/**
 * MCL-74. The only remover in this project, exercised against a real database.
 *
 * Two properties here are worth more than the rest of the script put together, and
 * neither can be checked without PostgreSQL:
 *
 * - The dry run removes NOTHING. The cost of getting this wrong is a child's own words,
 *   and the mistake always has the same shape: somebody was sure enough not to look
 *   first. The default has to be the safe one, provably.
 * - A media object shared by a second submission SURVIVES. Object keys are
 *   content-addressed, so two identical recordings are one file; unlinking it while
 *   another row still points at it would destroy a recording nobody asked to destroy.
 */

const run = promisify(execFile);

const CONNECTION_STRING = process.env.MCL_TEST_DATABASE_URL?.trim() ?? "";
const ENABLED = CONNECTION_STRING.length > 0;

const SHARED_KEY = "ab/abababababababababababababababababababababababababababababab.webm";

let inspector: Pool | null = null;
let mediaDirectory = "";

function inspect(): Pool {
  if (inspector === null) {
    inspector = new Pool({ connectionString: CONNECTION_STRING });
    inspector.on("error", (cause) => console.error("inspector pool error", cause));
  }
  return inspector;
}

async function script(args: string[]): Promise<{ stdout: string }> {
  return run("node", ["scripts/delete-submission.mjs", ...args], {
    env: {
      ...process.env,
      DATABASE_URL: CONNECTION_STRING,
      AVALORIA_MEDIA_DIR: mediaDirectory,
    },
  });
}

async function seed(): Promise<void> {
  await inspect().query("TRUNCATE submission_reply, submission_inbox");

  await inspect().query(
    `INSERT INTO submission_inbox
       (submission_id, kind, question_id, created_at, received_at, receipt_id, original_text)
     VALUES ('sub-text', 'text', 'companion-animal', now(), now(), 'receipt-1', 'Ein Wolf der leuchtet')`,
  );
  await inspect().query(
    `INSERT INTO submission_reply
       (reply_id, submission_id, understood, question, question_id, author, status, created_at)
     VALUES ('r-1', 'sub-text', 'Du magst den Wolf.', 'Wie heißt er?', 'reply:sub-text', 'human', 'ready', now())`,
  );

  // Two submissions pointing at ONE object, which is what content addressing produces
  // when two children record the same thing.
  for (const id of ["sub-audio-a", "sub-audio-b"]) {
    await inspect().query(
      `INSERT INTO submission_inbox
         (submission_id, kind, question_id, created_at, received_at, receipt_id,
          media_object_key, media_mime_type, media_extension, media_size_bytes, media_sha256)
       VALUES ($1, 'audio', 'companion-animal', now(), now(), $2, $3, 'audio/webm', 'webm', 2048, $4)`,
      [id, `receipt-${id}`, SHARED_KEY, "ab".repeat(32)],
    );
  }

  const path = join(mediaDirectory, SHARED_KEY);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "not really audio", "utf8");
}

beforeAll(async () => {
  if (!ENABLED) return;
  await lockSubmissionInboxTable(CONNECTION_STRING);
  mediaDirectory = await mkdtemp(join(tmpdir(), "mcl-delete-media-"));
});

afterAll(async () => {
  if (inspector !== null) {
    await inspector.query("TRUNCATE submission_reply, submission_inbox");
    await inspector.end();
    inspector = null;
  }
  if (mediaDirectory.length > 0) await rm(mediaDirectory, { recursive: true, force: true });
  if (ENABLED) await unlockSubmissionInboxTable();
});

beforeEach(async () => {
  if (ENABLED) await seed();
});

describe.skipIf(!ENABLED)("delete-submission.mjs", () => {
  it("removes nothing at all without --apply", async () => {
    const { stdout } = await script(["sub-text"]);

    expect(stdout).toContain("dry run");
    expect(stdout).toContain("replies:      1");

    const rows = await inspect().query("SELECT count(*)::int AS count FROM submission_inbox");
    expect(rows.rows[0]?.count).toBe(3);
    const replies = await inspect().query("SELECT count(*)::int AS count FROM submission_reply");
    expect(replies.rows[0]?.count).toBe(1);
  });

  it("removes the submission and its replies together with --apply", async () => {
    await script(["sub-text", "--apply"]);

    const remaining = await inspect().query(
      "SELECT count(*)::int AS count FROM submission_inbox WHERE submission_id = 'sub-text'",
    );
    expect(remaining.rows[0]?.count).toBe(0);

    const replies = await inspect().query("SELECT count(*)::int AS count FROM submission_reply");
    expect(replies.rows[0]?.count).toBe(0);
  });

  it("keeps a media file that a second submission still points at", async () => {
    const { stdout } = await script(["sub-audio-a", "--apply"]);

    expect(stdout).toContain("SHARED");
    expect(existsSync(join(mediaDirectory, SHARED_KEY))).toBe(true);

    const other = await inspect().query(
      "SELECT count(*)::int AS count FROM submission_inbox WHERE submission_id = 'sub-audio-b'",
    );
    expect(other.rows[0]?.count).toBe(1);
  });

  it("removes the media file once the last submission pointing at it is gone", async () => {
    await script(["sub-audio-a", "--apply"]);
    await script(["sub-audio-b", "--apply"]);

    expect(existsSync(join(mediaDirectory, SHARED_KEY))).toBe(false);
  });

  it("refuses an id the inbox does not hold, with a non-zero exit code", async () => {
    await expect(script(["sub-nope", "--apply"])).rejects.toMatchObject({ code: 1 });
  });
});

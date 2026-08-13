// scripts/import-inbox-jsonl.mjs
//
// Imports an existing append-only submissions.jsonl into submission_inbox (MCL-48).
//
// Run once during the cutover, after `npm run db:migrate` and before the container is
// started with DATABASE_URL set. Re-running it is safe and is the point: the operator
// who is unsure whether the import already happened must be able to just run it again.
//
//   node scripts/import-inbox-jsonl.mjs /opt/mc-legends/data/inbox/submissions.jsonl
//
// The source file is only ever READ. It is the rollback artefact - removing DATABASE_URL
// and restarting puts the app back on exactly this file - so an importer that moved,
// truncated or rewrote it would destroy the thing that makes the rollback free.
import { readFile } from "node:fs/promises";
import pg from "pg";

/** Mirrors the adapter's INSERT: same columns, same conflict target, same DO NOTHING. */
const INSERT = `
  INSERT INTO submission_inbox
    (submission_id, kind, question_id, created_at, received_at, receipt_id, original_text)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (submission_id) DO NOTHING
  RETURNING submission_id
`;

/** The InboxRecord fields that must be present and non-empty on every line. */
const IDENTIFIERS = ["receiptId", "submissionId", "questionId"];
/** The InboxRecord fields that must parse as an instant. */
const TIMESTAMPS = ["createdAt", "receivedAt"];

/**
 * A line this importer refuses, carrying the line number it was found on.
 *
 * Named rather than a bare Error so the top level can print it without a stack trace:
 * the operator needs "line 7 is broken and why", not a trace through node's internals.
 */
class MalformedLineError extends Error {
  constructor(lineNumber, reason, options) {
    super(`line ${lineNumber}: ${reason}`, options);
    this.name = "MalformedLineError";
  }
}

/**
 * One instant, spelled the way the adapter spells it.
 *
 * Date.parse is wider than timestamptz, so binding the raw string would let a value the
 * app could never have written reach the column and fail there instead - with an error
 * that names the column and not the line. Normalising here means a row imported from
 * the file and the same row written by the app are byte-identical in the database.
 */
function instant(lineNumber, field, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MalformedLineError(lineNumber, `${field} is missing or not a string`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new MalformedLineError(lineNumber, `${field} is not a parsable timestamp: ${value}`);
  }

  return parsed.toISOString();
}

/**
 * Turns one JSONL line into the values the INSERT binds, or throws naming the line.
 *
 * Every failure here is loud on purpose. The file adapter skips a line it cannot parse -
 * correct for a *reader* that must not let one damaged line block later submissions, and
 * exactly wrong for an *importer*, whose whole job is that every answer already given
 * arrives in the new store. A silently dropped line is a child's answer deleted without
 * anyone being told, so this refuses the import instead.
 */
function toValues(lineNumber, line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new MalformedLineError(lineNumber, "is not valid JSON", { cause });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MalformedLineError(lineNumber, "is not a JSON object");
  }

  // Checked, not cast. The kind CHECK constraint in 0001_submission_inbox.sql would
  // refuse an unknown kind anyway, but only after the transaction is open and with an
  // error that names the constraint rather than the line - and MCL-49 will widen this
  // union, at which point the importer must be revisited deliberately.
  if (parsed.kind !== "text") {
    throw new MalformedLineError(lineNumber, `kind is not "text": ${JSON.stringify(parsed.kind)}`);
  }

  for (const field of IDENTIFIERS) {
    if (typeof parsed[field] !== "string" || parsed[field].length === 0) {
      throw new MalformedLineError(lineNumber, `${field} is missing or not a non-empty string`);
    }
  }

  // No trim, no normalisation, no default. `originalText` is a child's own words and the
  // column comment says it is never rewritten; an empty string is a legitimate value
  // here, so only the type is checked.
  if (typeof parsed.originalText !== "string") {
    throw new MalformedLineError(lineNumber, "originalText is missing or not a string");
  }

  const [createdAt, receivedAt] = TIMESTAMPS.map((field) =>
    instant(lineNumber, field, parsed[field]),
  );

  return [
    parsed.submissionId,
    parsed.kind,
    parsed.questionId,
    createdAt,
    receivedAt,
    parsed.receiptId,
    parsed.originalText,
  ];
}

async function main() {
  const path = process.argv[2];
  if (path === undefined || path.trim().length === 0) {
    console.error("usage: node scripts/import-inbox-jsonl.mjs <path-to-submissions.jsonl>");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.trim().length === 0) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const content = await readFile(path, "utf8");

  // Parsed and validated in full BEFORE anything is inserted. A malformed line at the
  // end of the file must not leave the first half imported and the second half not: the
  // operator would then have to reason about which is which during a cutover.
  const records = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // Blank lines are structure, not data - a trailing newline is how the file adapter
    // ends every append.
    if (line.trim().length === 0) continue;
    records.push({ lineNumber: index + 1, values: toValues(index + 1, line) });
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  let imported = 0;

  try {
    // One transaction for the whole file, so a failure part-way leaves the table exactly
    // as it was. ON CONFLICT DO NOTHING already makes a re-run harmless; this makes a
    // *failed* run harmless too.
    await client.query("BEGIN");
    try {
      for (const { lineNumber, values } of records) {
        let result;
        try {
          result = await client.query(INSERT, values);
        } catch (cause) {
          // A row the table refuses - a length CHECK, a duplicate receipt_id - is still a
          // fact about one line of the file, so it is reported the same way a parse
          // failure is. Without this the operator gets a constraint name and no way to
          // find which of the lines carried it.
          throw new Error(`line ${lineNumber} was refused by submission_inbox`, { cause });
        }
        // No row back means the submission_id was already there. That is the idempotent
        // case, not an error: the row that is already stored is never overwritten, so a
        // second import can neither duplicate an answer nor rewrite one.
        if (result.rowCount === 1) imported += 1;
      }
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      // Attached rather than summarised, like the migration runner does: the driver's
      // error carries the SQLSTATE, the constraint name and the offending value, which
      // is what actually locates a row the table refused.
      throw new Error(`import of ${path} failed; nothing was written`, { cause });
    }
  } finally {
    await client.end();
  }

  console.log(
    `imported ${imported}, already present ${records.length - imported}, of ${records.length} record(s) in ${path}`,
  );
}

try {
  await main();
} catch (error) {
  // A malformed line is an operator-fixable fact about the file, so it is reported as
  // one line naming the line number. Anything else keeps its full cause chain, which is
  // where the SQLSTATE and the constraint name live.
  if (error instanceof MalformedLineError) {
    console.error(`malformed submissions.jsonl - ${error.message}`);
    console.error("nothing was imported; fix the line and run the import again");
    process.exit(1);
  }
  throw error;
}

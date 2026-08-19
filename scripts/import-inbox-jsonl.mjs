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

const COLUMNS = "submission_id, kind, question_id, created_at, received_at, receipt_id, original_text";

/** Mirrors the adapter's INSERT: same columns, same conflict target, same DO NOTHING. */
const INSERT = `
  INSERT INTO submission_inbox
    (${COLUMNS})
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (submission_id) DO NOTHING
  RETURNING submission_id
`;

/**
 * The row that won the conflict, read back inside the same transaction.
 *
 * DO NOTHING tells this script that a row with that submission_id exists. It does not
 * tell it that the row is the one in the file, and the difference is the whole point of
 * a re-runnable import: "already present" must mean "already present unchanged", or a
 * cutover can report a clean idempotent re-run over a row whose text, receipt or
 * instants are not the ones the operator is holding in the file.
 */
const SELECT_EXISTING = `SELECT ${COLUMNS} FROM submission_inbox WHERE submission_id = $1`;

/** The immutable fields, in the order the INSERT binds them. */
const IMMUTABLE_FIELDS = [
  "submissionId",
  "kind",
  "questionId",
  "createdAt",
  "receivedAt",
  "receiptId",
  "originalText",
];

/** The InboxRecord fields that must be present and non-empty on every line. */
const IDENTIFIERS = ["receiptId", "submissionId", "questionId"];
/** The InboxRecord fields that must parse as an instant. */
const TIMESTAMPS = ["createdAt", "receivedAt"];

/**
 * A refusal that names one source line, as opposed to a fault in the database or this
 * script.
 *
 * Named rather than a bare Error so the top level can print it without a stack trace:
 * the operator needs "line 7 is broken and why", not a trace through node's internals.
 * The headline says which kind of refusal it is, because the two have different fixes -
 * one edits the file, the other reconciles the file against the row already stored.
 */
class ImportRefusal extends Error {
  constructor(headline, lineNumber, reason, options) {
    super(`line ${lineNumber}: ${reason}`, options);
    this.name = "ImportRefusal";
    this.headline = headline;
  }
}

/** A line this importer cannot read at all. */
class MalformedLineError extends ImportRefusal {
  constructor(lineNumber, reason, options) {
    super("malformed submissions.jsonl", lineNumber, reason, options);
    this.name = "MalformedLineError";
  }
}

/**
 * A line whose submission_id is already stored under a DIFFERENT immutable record.
 *
 * Only the field NAMES are reported. `originalText` is a child's own words and the two
 * values are exactly what an operator would be tempted to paste into a ticket; the
 * repository's rule is that child text never reaches a log, and a divergence report is
 * still a log. Naming the fields and the line is enough to go and look.
 */
class ConflictingRecordError extends ImportRefusal {
  constructor(lineNumber, submissionId, fields) {
    super(
      "conflicting record already in submission_inbox",
      lineNumber,
      `submission ${submissionId} is already stored with a different ${fields.join(", ")}; ` +
        "neither the file nor the stored row was changed",
    );
    this.name = "ConflictingRecordError";
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

/**
 * One stored timestamptz, spelled the way `instant()` spells the source side.
 *
 * pg hands a timestamptz back as a Date only while the session DateStyle is ISO output;
 * under anything else its parser returns null and a bare `.toISOString()` would throw a
 * TypeError naming neither the column nor the cause. The session is pinned right after
 * connect for exactly this reason, and this checks that the pin held rather than
 * assuming it - the failure it prevents would otherwise look like "every row differs".
 */
function storedInstant(column, value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(
      `submission_inbox.${column} did not come back as a timestamp - check the session DateStyle, which must be 'ISO, YMD'`,
    );
  }

  return value.toISOString();
}

/** The stored row, in the same order and the same spelling as the bound source values. */
function storedValues(row) {
  return [
    row.submission_id,
    row.kind,
    row.question_id,
    storedInstant("created_at", row.created_at),
    storedInstant("received_at", row.received_at),
    row.receipt_id,
    row.original_text,
  ];
}

/** Which immutable fields the source line and the stored row disagree on, by name. */
function differingFields(source, stored) {
  const differing = [];

  for (let index = 0; index < IMMUTABLE_FIELDS.length; index += 1) {
    if (source[index] !== stored[index]) {
      differing.push(IMMUTABLE_FIELDS[index]);
    }
  }

  return differing;
}

/**
 * Decides what a conflict means, inside the run's transaction.
 *
 * Reads only. `ON CONFLICT DO UPDATE` would make the two sides agree by rewriting the
 * stored row, which is the one thing an importer of immutable submissions must never
 * do: the row already in the table is what a child was told their answer arrived as.
 *
 * The SELECT sees rows this run inserted a moment ago as well as rows from an earlier
 * run, so two lines in one file sharing a submission_id are compared the same way as a
 * line against a previous import.
 */
async function assertStoredRecordMatches(client, lineNumber, values) {
  const existing = await client.query(SELECT_EXISTING, [values[0]]);
  const row = existing.rows[0];

  if (row === undefined) {
    // Nothing inserted and nothing there. Counting this as "already present" would
    // report an answer as migrated that no table holds.
    throw new Error(
      `line ${lineNumber}: submission ${values[0]} was neither inserted nor found in submission_inbox`,
    );
  }

  const differing = differingFields(values, storedValues(row));
  if (differing.length > 0) {
    throw new ConflictingRecordError(lineNumber, values[0], differing);
  }
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

  // The same two settings PostgresSubmissionInboxStore pins on every pooled connection.
  // TIME ZONE is cosmetic here; DateStyle is not - under anything but ISO output pg's
  // timestamptz parser returns null, and the conflict comparison below would then read
  // every stored instant as unreadable rather than as equal.
  await client.query("SET TIME ZONE 'UTC'");
  await client.query("SET DateStyle = 'ISO, YMD'");

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
        if (result.rowCount === 1) {
          imported += 1;
          continue;
        }

        // No row back means the submission_id was already there - but NOT that the row
        // there is this line. Treating those as the same thing is what let a re-run
        // report "already present" over a row whose text, receipt or instants had
        // diverged from the file the operator was importing. The row is read back and
        // compared; a difference fails the run and rolls back everything this run
        // inserted, and neither side is rewritten.
        await assertStoredRecordMatches(client, lineNumber, values);
      }
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      // A refusal already names the line and the reason, and the rollback above is what
      // makes its "nothing was written" true. Wrapping it would bury that behind a
      // generic message and a stack trace.
      if (cause instanceof ImportRefusal) throw cause;
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
  if (error instanceof ImportRefusal) {
    console.error(`${error.headline} - ${error.message}`);
    console.error("nothing was imported; resolve it and run the import again");
    process.exit(1);
  }
  throw error;
}

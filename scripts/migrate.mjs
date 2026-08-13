// scripts/migrate.mjs
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Resolved from this module, not from process.cwd(): a release step, a container with a
// different WORKDIR or anyone running `node scripts/migrate.mjs` from elsewhere must
// find the same migrations as `npm run db:migrate` does, not fail with ENOENT.
const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations", import.meta.url));

/**
 * Everything that is text to PostgreSQL rather than a statement: line comments, block
 * comments, quoted strings and dollar-quoted bodies. One alternation, scanned
 * left-to-right, so whichever form opens first consumes the rest - the same order the
 * server reads them in.
 */
const SQL_TEXT = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|\$(\w*)\$[\s\S]*?\$\1\$/g;

/** Transaction control a migration must not contain - see assertNoSelfTransaction. */
const TRANSACTION_CONTROL = /\b(BEGIN|COMMIT|ROLLBACK)\b/i;

/**
 * Refuses a migration that manages its own transaction.
 *
 * The runner wraps each file in one transaction together with its schema_migrations
 * row. A file with its own COMMIT breaks that silently and badly: the statements before
 * it survive the runner's ROLLBACK, nothing is recorded as applied, and every later run
 * then fails on the objects left behind until someone repairs the database by hand.
 * Comments and string literals are blanked out first, so a COMMIT that is only being
 * talked about does not trip the guard.
 */
function assertNoSelfTransaction(version, sql) {
  const statements = sql.replace(SQL_TEXT, " ");
  const found = TRANSACTION_CONTROL.exec(statements);
  if (found === null) return;

  throw new Error(
    `migration ${version} contains a ${found[1].toUpperCase()} statement. ` +
      "The runner already wraps every migration in a single transaction with the row " +
      "that records it, so a migration must not open, commit or roll back its own.",
  );
}

/**
 * Applies every not-yet-applied migration in filename order, each in its own
 * transaction together with the row that records it. A crash between the DDL and the
 * bookkeeping would otherwise leave a schema no later run can reason about.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.trim().length === 0) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  // CREATE TABLE IF NOT EXISTS is not atomic, and neither is "read applied versions,
  // then apply the rest". One lock makes a second runner wait rather than race - it is
  // released automatically when this connection ends, including on a crash.
  await client.query("SELECT pg_advisory_lock($1)", [4820481]);

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    let count = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      assertNoSelfTransaction(version, sql);

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK");
        // Attached, not summarised: the driver's error carries the SQLSTATE, detail,
        // hint and the character position in the file, which is what actually locates
        // a failure. Node prints the whole cause chain.
        throw new Error(`migration ${version} failed`, { cause });
      }
      console.log(`applied ${version}`);
      count += 1;
    }

    console.log(count === 0 ? "no pending migrations" : `applied ${count} migration(s)`);
  } finally {
    await client.end();
  }
}

await main();

// scripts/migrate.mjs
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = "db/migrations";

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
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${version} failed: ${cause.message}`);
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

/**
 * Proves that the PostgreSQL integration suites actually EXECUTED.
 *
 * The suites under `tests/integration/` are gated on MCL_TEST_DATABASE_URL with
 * `describe.skipIf(...)`, so without that variable vitest reports them as pending and
 * still exits 0. A green `npm run test` is therefore indistinguishable from a run in
 * which the adapter was never touched - which is exactly how these suites came to have
 * never run anywhere but a laptop.
 *
 * This check removes that ambiguity: it runs the integration suites on their own, reads
 * the machine-readable result, and fails unless every one of their tests ran and passed.
 * Absent MCL_TEST_DATABASE_URL it fails loudly rather than passing quietly.
 *
 * Usage: node scripts/check-integration-tests-ran.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TARGET = "tests/integration/";

const vitestCli = resolve("node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitestCli)) {
  console.error(`integration-suites-ran: FAIL - vitest CLI not found at ${vitestCli}. Run npm ci first.`);
  process.exit(1);
}

const reportDirectory = mkdtempSync(join(tmpdir(), "mcl-integration-report-"));
const reportFile = join(reportDirectory, "integration.json");

try {
  const run = spawnSync(
    process.execPath,
    [vitestCli, "run", TARGET, "--reporter=json", `--outputFile=${reportFile}`],
    { stdio: "inherit" }
  );

  if (run.error) {
    console.error(`integration-suites-ran: FAIL - could not start vitest: ${run.error.message}`);
    process.exit(1);
  }

  if (!existsSync(reportFile)) {
    console.error(
      `integration-suites-ran: FAIL - vitest produced no JSON report (exit code ${run.status}).`
    );
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const total = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);

  console.log(
    `integration-suites-ran: total=${total} passed=${passed} failed=${failed} skipped=${skipped}`
  );

  const problems = [];
  if (total === 0) problems.push(`no test was collected from ${TARGET}`);
  if (passed === 0) problems.push("no test passed - the suites did not execute");
  if (skipped > 0) problems.push(`${skipped} test(s) were skipped - the suites did not fully execute`);
  if (failed > 0) problems.push(`${failed} test(s) failed`);
  if (run.status !== 0) problems.push(`vitest exited ${run.status}`);

  if (problems.length > 0) {
    console.error(`integration-suites-ran: FAIL - ${problems.join("; ")}.`);
    console.error(
      "MCL_TEST_DATABASE_URL is " +
        (process.env.MCL_TEST_DATABASE_URL?.trim()
          ? "set; the failure above is real."
          : "NOT set, so the suites skipped themselves. Point it at a reachable PostgreSQL with the migrations applied.")
    );
    process.exit(1);
  }

  console.log("integration-suites-ran: ok");
} finally {
  rmSync(reportDirectory, { recursive: true, force: true });
}

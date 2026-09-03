import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `scripts/check-backup-freshness.sh` (MCL-65).
 *
 * What this file pins: the difference between "the backup failed" and "the backup never
 * ran" must both come out as a FAILED check, because to the family's data they are the
 * same event.
 *
 * The scheduled pull runs on a laptop. A laptop sleeps, travels, loses its ssh key, or
 * has its LaunchAgent silently unloaded by an OS update - and in every one of those
 * states the per-run failure notification cannot fire, because no run happens. Before
 * this script, that silence was indistinguishable from health: the newest set under
 * `~/Backups/mc-legends` simply stopped getting younger, and nothing looked at its age.
 * MCL-65's acceptance is explicit that a failed run may never present as success; a run
 * that is *absent* is the harder half of that requirement, and age is the only signal
 * that survives it.
 *
 * The script is pure-local (reads one status file and one directory listing, no ssh, no
 * network), which is what lets this test run it in CI on every `npm run test` - same
 * split, for the same reason, as `verify-media-archive.sh` vs `backup-mc-legends.sh`.
 *
 * The status lines in the fixtures are written in the exact format
 * `scripts/backup-mc-legends.sh` produces from its EXIT trap (`<stamp> ok` /
 * `<stamp> FAILED exit=<code>`), because that format is the interface between the two
 * scripts; generating both ends here with a shared helper would hide a drift.
 */

const run = promisify(execFile);
const SCRIPT = resolve("scripts", "check-backup-freshness.sh");

type Outcome = Readonly<{ code: number; stdout: string; stderr: string }>;

async function check(...args: readonly string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(SCRIPT, [...args]);
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const failure = cause as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/** A stamp in the backup set format (20260823T182757Z), `hoursAgo` in the past. */
function stampHoursAgo(hoursAgo: number): string {
  const at = new Date(Date.now() - hoursAgo * 3_600_000);
  return at.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
}

let dir = "";

async function seedSet(stamp: string): Promise<void> {
  await mkdir(join(dir, stamp), { recursive: true });
  await writeFile(join(dir, stamp, `mcl-${stamp}.dump`), "not-empty");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcl-freshness-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("check-backup-freshness.sh", () => {
  it("passes on a fresh ok status whose set still exists", async () => {
    const stamp = stampHoursAgo(1);
    await seedSet(stamp);
    await writeFile(join(dir, "last-run.status"), `${stamp} ok\n`);

    const outcome = await check(dir, "48");

    expect(outcome.stderr).toBe("");
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain(stamp);
  });

  it("fails when the newest ok run is older than the ceiling", async () => {
    const stamp = stampHoursAgo(72);
    await seedSet(stamp);
    await writeFile(join(dir, "last-run.status"), `${stamp} ok\n`);

    const outcome = await check(dir, "48");

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("older than");
  });

  it("fails when the last run recorded FAILED, regardless of age", async () => {
    const stamp = stampHoursAgo(1);
    await writeFile(join(dir, "last-run.status"), `${stamp} FAILED exit=1\n`);

    const outcome = await check(dir, "48");

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("FAILED");
  });

  it("fails when no run has ever been recorded - silence is not health", async () => {
    const outcome = await check(dir, "48");

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("no recorded run");
  });

  it("fails when the status names a set that no longer exists on disk", async () => {
    const stamp = stampHoursAgo(1);
    await writeFile(join(dir, "last-run.status"), `${stamp} ok\n`);

    const outcome = await check(dir, "48");

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("no longer exists");
  });

  it("refuses an empty status file as malformed, not as a shell crash", async () => {
    await writeFile(join(dir, "last-run.status"), "");

    const outcome = await check(dir, "48");

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("malformed");
    expect(outcome.stderr).not.toContain("unbound");
  });

  it("refuses a malformed status line rather than guessing", async () => {
    await writeFile(join(dir, "last-run.status"), "yesterday-ish ok\n");

    const outcome = await check(dir, "48");

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("malformed");
  });

  it("refuses wrong usage with exit 2", async () => {
    const outcome = await check();

    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain("usage");
  });
});

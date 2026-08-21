import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `scripts/verify-media-archive.sh` (MCL-49 finding F2).
 *
 * What this file pins: a media archive is not "verified" until its BYTES have been checked
 * against the SHA-256 manifest taken at the source.
 *
 * Measured on a135e2b, when it was not. `scripts/backup-mc-legends.sh` generated the
 * manifest on the VPS - correctly, before transfer, so it describes the source rather than
 * the copy - and then never used it for anything but a line count. The backup path proved
 * two things about the downloaded archive: that `tar -tf` could list it, and that the
 * number of entries equalled the number of manifest lines. Neither says anything about
 * content. A transfer that silently corrupted bytes inside a recording, or truncated one
 * file while keeping the entry, printed `ok:` and then pruned older backup sets - deleting
 * the last good copy on the strength of a check that could not have detected the problem.
 *
 * The verifier is a separate script rather than more lines inside the backup script, and
 * this test is the reason: `backup-mc-legends.sh` shells to `ssh`, `pg_dump` and
 * `pg_restore`, so it cannot run in CI or on a machine with no VPS credential. The proof
 * can, and does.
 *
 * The manifest fixtures are written in `sha256sum`'s exact output format rather than by
 * running a checksum tool, because that format is the real interface: the manifest is
 * produced by `sha256sum` on Linux and consumed on macOS, and a mismatch between the two
 * would be invisible to a test that generated both ends with the same local tool.
 */

const run = promisify(execFile);
const SCRIPT = resolve("scripts", "verify-media-archive.sh");

type Outcome = Readonly<{ code: number; stdout: string; stderr: string }>;

async function verify(tar: string, manifest: string): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(SCRIPT, [tar, manifest]);
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

let workspace = "";
/** The media tree as it exists "on the VPS" - the thing the manifest describes. */
let source = "";

/** Exactly what `sha256sum` writes: the digest, two spaces, the path as `find` gave it. */
function manifestLine(relativePath: string, bytes: Buffer): string {
  return `${createHash("sha256").update(bytes).digest("hex")}  ./${relativePath}\n`;
}

async function writeSourceFile(relativePath: string, content: string): Promise<string> {
  const absolute = join(source, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
  return manifestLine(relativePath, Buffer.from(content));
}

/** `tar -cf - -C "$MEDIA_DIR" .`, which is what the backup script transfers. */
async function archiveSource(name = "media.tar"): Promise<string> {
  const tar = join(workspace, name);
  await run("tar", ["-cf", tar, "-C", source, "."]);
  return tar;
}

async function writeManifest(lines: string[], name = "media.sha256"): Promise<string> {
  const manifest = join(workspace, name);
  // Sorted by path, as `sort -k2` leaves it on the VPS.
  await writeFile(manifest, [...lines].sort().join(""));
  return manifest;
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "mcl-verify-media-"));
  source = join(workspace, "source");
  await mkdir(source, { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("verify-media-archive.sh", () => {
  it("verifies an archive whose bytes match the source manifest", async () => {
    const lines = [
      await writeSourceFile("ab/abababab.webm", "erste aufnahme"),
      await writeSourceFile("cd/cdcdcdcd.m4a", "zweite aufnahme"),
    ];
    const tar = await archiveSource();
    const manifest = await writeManifest(lines);

    const outcome = await verify(tar, manifest);

    expect(outcome.code).toBe(0);
    // The count is the point: a run that says ok and nothing else cannot be told from a
    // run that verified an empty archive.
    expect(outcome.stdout).toContain("2");
  });

  it("fails when one archived recording's bytes differ from the manifest", async () => {
    // THE case. Everything else about this archive is right - the entry is there, the
    // count matches, `tar -tf` lists it - and exactly one recording is not the recording
    // the source hashed. Before this script, that archive was pruned-behind and called ok.
    const good = await writeSourceFile("ab/abababab.webm", "erste aufnahme");
    await writeSourceFile("cd/cdcdcdcd.m4a", "zweite aufnahme");
    const tar = await archiveSource();

    const corrupted = manifestLine("cd/cdcdcdcd.m4a", Buffer.from("eine andere aufnahme"));
    const manifest = await writeManifest([good, corrupted]);

    const outcome = await verify(tar, manifest);

    expect(outcome.code).not.toBe(0);
    expect(`${outcome.stdout}${outcome.stderr}`).toContain("cdcdcdcd.m4a");
  });

  it("fails when the archive is missing a recording the manifest lists", async () => {
    const present = await writeSourceFile("ab/abababab.webm", "erste aufnahme");
    const tar = await archiveSource();
    const absent = manifestLine("cd/never-transferred.m4a", Buffer.from("dritte aufnahme"));

    const outcome = await verify(tar, await writeManifest([present, absent]));

    expect(outcome.code).not.toBe(0);
  });

  it("fails when the archive holds a file the manifest does not vouch for", async () => {
    // The other direction, and the reason a digest check alone is not enough: `shasum -c`
    // proves every manifest line has a matching file, never that every file has a line.
    // An extra file means the tree changed between the two commands on the VPS, and the
    // manifest no longer describes the archive.
    const listed = await writeSourceFile("ab/abababab.webm", "erste aufnahme");
    await writeSourceFile("cd/unlisted.m4a", "niemand hat mich gehasht");
    const tar = await archiveSource();

    const outcome = await verify(tar, await writeManifest([listed]));

    expect(outcome.code).not.toBe(0);
  });

  it("verifies an empty archive against an empty manifest", async () => {
    // The legitimate state between enabling audio storage and the first upload. It must
    // not be a failure, or the backup starts failing the day the directory is created.
    const tar = await archiveSource();

    const outcome = await verify(tar, await writeManifest([]));

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("0");
  });

  it("fails when an empty manifest is paired with a non-empty archive", async () => {
    await writeSourceFile("ab/abababab.webm", "erste aufnahme");
    const tar = await archiveSource();

    const outcome = await verify(tar, await writeManifest([]));

    expect(outcome.code).not.toBe(0);
  });

  it("leaves the archive and the manifest exactly as it found them", async () => {
    // It reads a backup; it must never be the reason a backup changed. Digest and size on
    // both, before and after - the archive is what a restore will be run from.
    const lines = [await writeSourceFile("ab/abababab.webm", "erste aufnahme")];
    const tar = await archiveSource();
    const manifest = await writeManifest(lines);

    const digest = async (path: string) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex");

    const before = [await digest(tar), await digest(manifest), (await stat(tar)).size];
    await verify(tar, manifest);
    const after = [await digest(tar), await digest(manifest), (await stat(tar)).size];

    expect(after).toEqual(before);
  });

  it("removes its verification tree, on success and on failure alike", async () => {
    // It extracts megabytes of recordings to check them. A run that leaves them behind
    // fills the disk of the machine that holds the only backups, and a FAILED run is
    // exactly when nobody is watching for that.
    const lines = [await writeSourceFile("ab/abababab.webm", "erste aufnahme")];
    const tar = await archiveSource();

    const leftovers = async () =>
      (await readdir(tmpdir())).filter((entry) => entry.startsWith("mcl-media-verify"));

    const before = await leftovers();

    expect((await verify(tar, await writeManifest(lines))).code).toBe(0);
    expect(await leftovers()).toEqual(before);

    const wrong = manifestLine("ab/abababab.webm", Buffer.from("etwas ganz anderes"));
    expect((await verify(tar, await writeManifest([wrong], "wrong.sha256"))).code).not.toBe(0);
    expect(await leftovers()).toEqual(before);
  });

  it("refuses arguments it cannot read instead of reporting success", async () => {
    const lines = [await writeSourceFile("ab/abababab.webm", "erste aufnahme")];
    const tar = await archiveSource();
    const manifest = await writeManifest(lines);

    expect((await verify(join(workspace, "absent.tar"), manifest)).code).not.toBe(0);
    expect((await verify(tar, join(workspace, "absent.sha256"))).code).not.toBe(0);
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A connection string built to be recognisable in a leak: every part of it is a
 * distinct, otherwise-absent literal, so a body that echoes any of them fails the
 * no-leakage case rather than merely looking wrong to a reader.
 *
 * Port 1 refuses immediately, so the probe fails without waiting for a timeout.
 */
const LEAKY_URL = "postgresql://secret-user:hunter2@127.0.0.1:1/x?connect_timeout=1";
const UNREACHABLE_URL = "postgresql://nobody@127.0.0.1:1/nothing?connect_timeout=1";

let mediaDirectory = "";

beforeEach(async () => {
  // A temp directory per case, so the writability probe never touches the repository's
  // own .data/media and two cases cannot see each other's probe files.
  mediaDirectory = await mkdtemp(join(tmpdir(), "mcl-ready-"));
  vi.stubEnv("AVALORIA_MEDIA_DIR", mediaDirectory);
  // The route logs the driver's cause on purpose. Silenced rather than left to print,
  // so a failing probe does not bury the run's real output - the assertion that the
  // cause stays OUT of the response body is the one that matters here.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(mediaDirectory, { recursive: true, force: true });
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/health/ready", () => {
  it("reports the application healthy and the database unavailable when it cannot be reached", async () => {
    vi.stubEnv("DATABASE_URL", UNREACHABLE_URL);
    const { GET } = await import("@/app/api/health/ready/route");

    const response = await GET();

    // 503, so a load balancer or an operator sees a machine-readable "not ready".
    expect(response.status).toBe(503);
    // App and database answered separately: an app that is up with a database that is
    // not must be distinguishable from a process that is simply down.
    await expect(response.json()).resolves.toEqual({ app: "ok", database: "unavailable", storage: "ok" });
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])(
    "reports the database as not configured rather than failing when DATABASE_URL is %s",
    async (_label, value) => {
      vi.stubEnv("DATABASE_URL", value);
      const { GET } = await import("@/app/api/health/ready/route");

      const response = await GET();

      // 200, not 503: the file store is a legitimate configuration - it is the MCL-48
      // rollback path - and calling it a fault would page somebody for a working app.
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ app: "ok", database: "not-configured", storage: "ok" });
    },
  );

  it("never leaks the connection string, its password, host or a driver message", async () => {
    vi.stubEnv("DATABASE_URL", LEAKY_URL);
    const { GET } = await import("@/app/api/health/ready/route");

    // The raw bytes the route actually sent. This endpoint is unauthenticated, so its
    // body is public: a driver message here publishes the password on a public URL.
    const body = await (await GET()).text();

    expect(body, "must not echo the password").not.toContain("hunter2");
    expect(body, "must not echo the username").not.toContain("secret-user");
    expect(body, "must not echo the host").not.toContain("127.0.0.1");
    expect(body, "must not echo the database name or the whole string").not.toContain(LEAKY_URL);
    // Nothing but the fixed vocabulary. ECONNREFUSED, a stack frame or a pg error code
    // would each be a new way for the same failure to describe the host.
    expect(body, "must carry no driver detail").not.toMatch(
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|at Object|at async|Error:|postgres/iu,
    );
    expect(JSON.parse(body)).toEqual({ app: "ok", database: "unavailable", storage: "ok" });
  });

  it("reports storage unavailable when the media directory cannot be written to", async () => {
    // A file where the directory has to be. That is the reproducible stand-in for the
    // three real cases - a volume that failed to mount, a read-only remount, a full disk -
    // all of which pass a `stat` and fail every audio submission.
    const occupied = join(mediaDirectory, "occupied");
    await writeFile(occupied, "not a directory", "utf8");
    vi.stubEnv("AVALORIA_MEDIA_DIR", occupied);
    vi.stubEnv("DATABASE_URL", undefined);

    const { GET } = await import("@/app/api/health/ready/route");
    const response = await GET();

    // 503 even though the database is fine: a machine that cannot store a recording is
    // not ready, and MCL-49 requires the recording to be durable before a child is told
    // it arrived.
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      app: "ok",
      database: "not-configured",
      storage: "unavailable",
    });
  });

  it("reports both faults rather than hiding the second behind the first", async () => {
    // The failure this ordering exists to prevent: an operator fixes PostgreSQL,
    // redeploys, and only then discovers the volume was never mounted either.
    const occupied = join(mediaDirectory, "occupied");
    await writeFile(occupied, "not a directory", "utf8");
    vi.stubEnv("AVALORIA_MEDIA_DIR", occupied);
    vi.stubEnv("DATABASE_URL", UNREACHABLE_URL);

    const { GET } = await import("@/app/api/health/ready/route");
    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      app: "ok",
      database: "unavailable",
      storage: "unavailable",
    });
  });

  it("never leaks a filesystem path when storage is unavailable", async () => {
    const occupied = join(mediaDirectory, "occupied");
    await writeFile(occupied, "not a directory", "utf8");
    vi.stubEnv("AVALORIA_MEDIA_DIR", occupied);
    vi.stubEnv("DATABASE_URL", undefined);

    const { GET } = await import("@/app/api/health/ready/route");
    const body = await (await GET()).text();

    // This endpoint is unauthenticated. A path in the body describes the host's
    // filesystem layout to anybody who asks.
    expect(body, "must not echo the media directory").not.toContain(mediaDirectory);
    expect(body, "must not echo a tmp path").not.toContain(tmpdir());
    expect(body, "must carry no errno or stack frame").not.toMatch(
      /ENOTDIR|EACCES|ENOSPC|EROFS|at Object|at async|Error:/iu,
    );
  });

  it("leaves the stored recordings alone while probing", async () => {
    // The probe writes and removes its own file. A probe that cleared the directory, or
    // that wrote into a name a recording could occupy, would destroy data every time a
    // health checker ran - which is once a second in most deployments.
    const shard = join(mediaDirectory, "01");
    await import("node:fs/promises").then((fs) => fs.mkdir(shard, { recursive: true }));
    await writeFile(join(shard, "keepme"), "a recording", "utf8");
    vi.stubEnv("DATABASE_URL", undefined);

    const { GET } = await import("@/app/api/health/ready/route");
    expect((await GET()).status).toBe(200);

    const { readdir, readFile: read } = await import("node:fs/promises");
    expect(await readdir(mediaDirectory)).toEqual(["01"]);
    expect(await read(join(shard, "keepme"), "utf8")).toBe("a recording");
  });

  it("leaves /api/health answering for the process alone, whatever DATABASE_URL says", async () => {
    // The whole reason readiness is a second endpoint: with the database broken,
    // /api/health must still say the process is serving. If it turned 503 too, a DB
    // outage would look identical to a crashed app and an operator would learn nothing.
    vi.stubEnv("DATABASE_URL", UNREACHABLE_URL);
    const { GET: health } = await import("@/app/api/health/route");

    const response = await health();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adminAudioRoute from "@/app/api/admin/inbox/submissions/[submissionId]/audio/route";
import { GET } from "@/app/api/admin/inbox/submissions/[submissionId]/audio/route";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { ADMIN_SESSION_COOKIE } from "@/adapters/http/admin-session-cookie";
import { FileAudioBlobStore } from "@/adapters/persistence/file-audio-blob-store";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import { audioObjectKey } from "@/domain/media/audio-artifact";
import { resetRateLimitersForTest } from "@/composition/server";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";
import { WEBM } from "../support/audio-fixtures";

/**
 * The authorized playback route (MCL-49).
 *
 * MCL-49 asks for two things that are only visible from a test like this one. First, that
 * the recording has NO public URL: the only way to the bytes is an admin-gated route, and
 * a family session - the one every child holds - must not open it. Second, that what comes
 * back is inert: the same bytes that went in, served with headers that stop a browser from
 * ever treating a stored file as executable web content.
 *
 * The seeding here goes through the REAL adapters rather than a fake, because the property
 * being checked is a round trip. A fake blob store would return whatever it was handed and
 * prove nothing about whether the bytes on disk are the bytes that were uploaded.
 */

const ADMIN_CODE = "ein-eigener-admin-code-nur-fuer-erwachsene";
const SESSION_SECRET = "test-session-secret";

const AUDIO_SUBMISSION = "sub-audio-001";
const TEXT_SUBMISSION = "sub-text-001";

const SHA256 = createHash("sha256").update(WEBM).digest("hex");
const OBJECT_KEY = audioObjectKey(SHA256, "audio/webm");

let inboxDirectory = "";
let mediaDirectory = "";
let adminCookie = "";

function cookieFor(name: string, accessCode: string): string {
  const grant = new HmacFamilyAccessGate({
    accessCode,
    sessionSecret: SESSION_SECRET,
  }).openSession(accessCode);
  if (grant.outcome !== "granted") {
    throw new Error("fixture could not open a session");
  }
  return `${name}=${grant.session.value}`;
}

function request(submissionId: string, headers: Record<string, string> = {}): Request {
  return new Request(
    `http://localhost/api/admin/inbox/submissions/${encodeURIComponent(submissionId)}/audio`,
    { method: "GET", headers: { cookie: adminCookie, ...headers } },
  );
}

/** Next 16 hands a route handler its dynamic segments as a promise. */
function params(submissionId: string): { params: Promise<{ submissionId: string }> } {
  return { params: Promise.resolve({ submissionId }) };
}

async function seed(): Promise<void> {
  await new FileAudioBlobStore(mediaDirectory).store(OBJECT_KEY, WEBM);

  const store = new FileSubmissionInboxStore(inboxDirectory);
  await store.appendIfAbsent({
    kind: "audio",
    submissionId: AUDIO_SUBMISSION,
    questionId: "companion-animal",
    createdAt: "2026-08-21T09:00:00.000Z",
    receivedAt: "2026-08-21T09:00:01.000Z",
    receiptId: "receipt-audio-001",
    audio: {
      objectKey: OBJECT_KEY,
      mimeType: "audio/webm",
      extension: "webm",
      sizeBytes: WEBM.byteLength,
      sha256: SHA256,
    },
  });
  await store.appendIfAbsent({
    kind: "text",
    submissionId: TEXT_SUBMISSION,
    questionId: "hidden-door",
    createdAt: "2026-08-21T09:00:00.000Z",
    receivedAt: "2026-08-21T09:00:01.000Z",
    receiptId: "receipt-text-001",
    originalText: "hinter dem wasserfall",
  });
}

/** Writes a line straight into the JSONL, bypassing every guard the route has. */
async function writeRawLine(line: object): Promise<void> {
  await mkdir(inboxDirectory, { recursive: true });
  await appendFile(join(inboxDirectory, "submissions.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
}

/** Filesystem paths, errno codes and stack frames - anything a refusal could carry out. */
const INTERNAL_DETAIL =
  /ENOTDIR|ENOENT|EACCES|node:|\/private\/|\/var\/folders\/|at Object|at async|Error:|stack/iu;

async function expectNoLeak(response: Response): Promise<string> {
  const raw = await response.text();
  expect(raw, "a refusal must carry no internal detail").not.toMatch(INTERNAL_DETAIL);
  expect(raw, "a refusal must never name the object key").not.toContain(OBJECT_KEY);
  expect(raw, "a refusal must never name the media directory").not.toContain(mediaDirectory);
  expect(raw, "a refusal must never echo an access code").not.toContain(ADMIN_CODE);
  return raw;
}

beforeEach(async () => {
  inboxDirectory = await mkdtemp(join(tmpdir(), "avaloria-admin-audio-inbox-"));
  mediaDirectory = await mkdtemp(join(tmpdir(), "avaloria-admin-audio-media-"));

  resetRateLimitersForTest();
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("AVALORIA_INBOX_DIR", inboxDirectory);
  vi.stubEnv("AVALORIA_MEDIA_DIR", mediaDirectory);
  vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", ADMIN_CODE);
  vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", TEST_FAMILY_ACCESS_CODE);
  vi.stubEnv("AVALORIA_SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("AVALORIA_ADMIN_RATE_LIMIT", undefined);
  adminCookie = cookieFor(ADMIN_SESSION_COOKIE, ADMIN_CODE);

  await seed();
});

afterEach(async () => {
  // unstubAllEnvs and nothing else - never `process.env = ...`.
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetRateLimitersForTest();
  await rm(inboxDirectory, { recursive: true, force: true });
  await rm(mediaDirectory, { recursive: true, force: true });
});

describe("GET /api/admin/inbox/submissions/[submissionId]/audio access", () => {
  it("refuses an anonymous request without serving a byte of audio", async () => {
    const anonymous = new Request(
      `http://localhost/api/admin/inbox/submissions/${AUDIO_SUBMISSION}/audio`,
      { method: "GET" },
    );

    const response = await GET(anonymous, params(AUDIO_SUBMISSION));

    expect(response.status).toBe(401);
    const raw = await expectNoLeak(response);
    expect(JSON.parse(raw)).toEqual({ error: "unauthorized" });
    // The refusal is a few dozen bytes of JSON, not a recording. Asserted on the length
    // as well as the shape: "the body happens to be JSON" would still be true if the
    // route had written the audio after it.
    expect(raw.length).toBeLessThan(200);
  });

  it("refuses a family session presented under the admin cookie name", async () => {
    // The separation MCL-50 exists for, re-proven at the one route where getting it wrong
    // would hand a child every sibling's recording. The two gates share a construction and
    // a session secret; only the access code separates them.
    const response = await GET(
      request(AUDIO_SUBMISSION, {
        cookie: cookieFor(ADMIN_SESSION_COOKIE, TEST_FAMILY_ACCESS_CODE),
      }),
      params(AUDIO_SUBMISSION),
    );

    expect(response.status).toBe(401);
    await expectNoLeak(response);
  });

  it("fails closed when no admin access code is configured", async () => {
    vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(request(AUDIO_SUBMISSION), params(AUDIO_SUBMISSION));

    expect(response.status).toBe(503);
    await expectNoLeak(response);
  });

  it("fails closed when the admin code equals the family code", async () => {
    // Identical codes make the two token families interchangeable, so createAdminAccessGate
    // refuses the configuration outright rather than serving it.
    vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", TEST_FAMILY_ACCESS_CODE);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(request(AUDIO_SUBMISSION), params(AUDIO_SUBMISSION));

    expect(response.status).toBe(503);
    await expectNoLeak(response);
  });

  it("refuses an adult who asks too often", async () => {
    vi.stubEnv("AVALORIA_ADMIN_RATE_LIMIT", "1");
    resetRateLimitersForTest();

    expect((await GET(request(AUDIO_SUBMISSION), params(AUDIO_SUBMISSION))).status).toBe(200);

    const refused = await GET(request(AUDIO_SUBMISSION), params(AUDIO_SUBMISSION));

    expect(refused.status).toBe(429);
    await expectNoLeak(refused);
  });
});

describe("GET /api/admin/inbox/submissions/[submissionId]/audio", () => {
  it("serves the stored bytes unchanged", async () => {
    const response = await GET(request(AUDIO_SUBMISSION), params(AUDIO_SUBMISSION));

    expect(response.status).toBe(200);

    const served = new Uint8Array(await response.arrayBuffer());
    // The digest of what came back, against the digest of what went in. MCL-49 requires
    // the original bytes to be unchanged, and a hash comparison is the only assertion
    // that cannot pass on a re-encoded, re-containered or truncated copy.
    expect(createHash("sha256").update(served).digest("hex")).toBe(SHA256);
    expect(served.byteLength).toBe(WEBM.byteLength);
  });

  it("serves it as inert content a browser will never execute", async () => {
    const response = await GET(request(AUDIO_SUBMISSION), params(AUDIO_SUBMISSION));

    // The stored type, not a sniffed one, and nosniff so the browser does not go looking
    // for a better idea. Together with the sandboxed, source-less CSP this is what makes
    // "not delivered as executable web content" true at the response rather than only at
    // the filename.
    expect(response.headers.get("content-type")).toBe("audio/webm");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    // A child's recording must not sit in a shared cache, and must not be written to disk
    // by a proxy that thought it was being helpful.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-length")).toBe(String(WEBM.byteLength));
    expect(response.headers.get("content-disposition")).toBe(
      `inline; filename="antwort-${AUDIO_SUBMISSION}.webm"`,
    );
  });

  it("names the file from the submission id and the stored extension, nothing else", async () => {
    // A submission id can carry characters that would end the header value early or start
    // a second parameter. The filename is a display detail, so it is reduced to a safe
    // alphabet here rather than refused - but nothing a client sent may shape it, and no
    // quote or semicolon may survive into the header.
    await writeRawLine({
      kind: "audio",
      submissionId: 'sub"; filename="evil.php',
      questionId: "companion-animal",
      createdAt: "2026-08-21T09:00:00.000Z",
      receivedAt: "2026-08-21T09:00:01.000Z",
      receiptId: "receipt-hostile",
      audio: {
        objectKey: OBJECT_KEY,
        mimeType: "audio/webm",
        extension: "webm",
        sizeBytes: WEBM.byteLength,
        sha256: SHA256,
      },
    });

    const hostile = 'sub"; filename="evil.php';
    const response = await GET(request(hostile), params(hostile));

    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).not.toContain('"evil.php');
    expect(disposition).not.toContain(".php");
    // One dot in the whole name, and it is the one the stored extension brought.
    expect(disposition).toMatch(/^inline; filename="antwort-[A-Za-z0-9_-]*\.webm"$/);
  });

  it("answers 404 for a submission the inbox does not hold", async () => {
    const response = await GET(request("sub-nobody-sent"), params("sub-nobody-sent"));

    expect(response.status).toBe(404);
    await expectNoLeak(response);
  });

  it("answers 404 for a typed answer rather than saying it is the wrong kind", async () => {
    // Distinguishing "no such submission" from "that one is text" would make this route an
    // existence oracle for submission ids, which is a thing an unauthorised caller who
    // guessed one cookie should not be handed either.
    const response = await GET(request(TEXT_SUBMISSION), params(TEXT_SUBMISSION));

    expect(response.status).toBe(404);
    await expectNoLeak(response);
  });

  it("answers 404 when the row is there and the recording is not", async () => {
    // A database restored without its media, or a blob a future retention policy removed.
    // A real state, so it gets a real answer rather than a 500 - and it is logged, because
    // a row pointing at nothing is something an operator has to know about.
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    await unlink(join(mediaDirectory, OBJECT_KEY));

    const response = await GET(request(AUDIO_SUBMISSION), params(AUDIO_SUBMISSION));

    expect(response.status).toBe(404);
    expect(errors).toHaveLength(1);
    await expectNoLeak(response);
  });

  it("never serves foreign bytes for a row whose object key was tampered with", async () => {
    // Written straight into the JSONL, bypassing the upload route entirely - the shape a
    // hand-edited file or a restore from somewhere else could take. The blob adapter
    // refuses any key it did not mint, by construction rather than by filtering, and the
    // route turns that refusal into a code instead of a file.
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    await writeRawLine({
      kind: "audio",
      submissionId: "sub-tampered",
      questionId: "companion-animal",
      createdAt: "2026-08-21T09:00:00.000Z",
      receivedAt: "2026-08-21T09:00:01.000Z",
      receiptId: "receipt-tampered",
      audio: {
        objectKey: "../../../etc/passwd",
        mimeType: "audio/webm",
        extension: "webm",
        sizeBytes: 1024,
        sha256: SHA256,
      },
    });

    const response = await GET(request("sub-tampered"), params("sub-tampered"));

    expect(response.status).not.toBe(200);
    expect([404, 503]).toContain(response.status);
    const raw = await expectNoLeak(response);
    expect(raw).not.toContain("root:");
    expect(raw).not.toContain("passwd");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("exposes no mutation verb at all", () => {
    // "No change to the original audio through the UI" is an acceptance criterion, and the
    // strongest way to hold it is for the verbs not to exist: Next answers 405 for a verb
    // the module does not export, so the absence IS the enforcement.
    expect(Object.keys(adminAudioRoute).toSorted()).toEqual(["GET"]);
  });

  it("carries no object key, path or hash in any response it sends", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const responses = [
      await GET(request("sub-nobody-sent"), params("sub-nobody-sent")),
      await GET(request(TEXT_SUBMISSION), params(TEXT_SUBMISSION)),
    ];

    for (const response of responses) {
      await expectNoLeak(response);
    }

    // And on the success path the leak would be in the headers rather than the body.
    const served = await GET(request(AUDIO_SUBMISSION), params(AUDIO_SUBMISSION));
    const headers = JSON.stringify([...served.headers.entries()]);
    expect(headers).not.toContain(OBJECT_KEY);
    expect(headers).not.toContain(mediaDirectory);
    expect(headers).not.toContain(SHA256);
  });
});

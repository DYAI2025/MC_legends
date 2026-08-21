import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioBlobStore } from "@/application/media/audio-blob-store";
import {
  SubmissionPayloadError,
  type InboxRecord,
  type SubmissionInboxStore,
} from "@/application/submissions/submission-inbox-store";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";
import { familySessionCookieHeader } from "../support/family-session-header";
import { ELF, HTML, MP3_ID3, MP4, OGG, RIFF_AVI, WAV, WEBM } from "../support/audio-fixtures";

/**
 * The audio upload route (MCL-49).
 *
 * What this file pins, beyond "a recording can be uploaded": the ORDER in which the two
 * persistence stages happen and what each partial failure leaves behind. A positive
 * receipt may exist only after the bytes are durable AND the row is durable; a database
 * failure after a successful blob write must leave no receipt; a storage failure must
 * leave no row. Those two are the cases that cannot be seen from a green happy path and
 * that are unrecoverable if they are wrong - a row pointing at a recording that was never
 * written is a child told their answer arrived, pointing at nothing.
 *
 * The two stores are overridable per case so a failure can be injected at a chosen stage.
 * Every other case runs against the REAL file adapters in a temp directory, because the
 * invariants that matter here - one file per distinct recording, an unchanged byte
 * stream, an object key no client string reaches - are filesystem facts.
 */

const overrides = vi.hoisted(() => ({
  inboxStore: null as SubmissionInboxStore | null,
  blobStore: null as AudioBlobStore | null,
}));

vi.mock("@/composition/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composition/server")>();
  return {
    ...actual,
    // Null by default, so unless a case says otherwise the route talks to the real
    // adapters the composition root selects from the environment.
    createSubmissionInboxStore: () =>
      overrides.inboxStore ?? actual.createSubmissionInboxStore(),
    createAudioBlobStore: () => overrides.blobStore ?? actual.createAudioBlobStore(),
  };
});

const { resetRateLimitersForTest } = await import("@/composition/server");
const audioRoute = await import("@/app/api/inbox/submissions/audio/route");
const { POST } = audioRoute;
const { POST: POST_TEXT } = await import("@/app/api/inbox/submissions/route");

const ENDPOINT = "http://localhost/api/inbox/submissions/audio";
const TEXT_ENDPOINT = "http://localhost/api/inbox/submissions";
const INBOX_FILE = "submissions.jsonl";

/** 8 MiB, the documented ceiling. Written out so this file fails if the route's drifts. */
const MAX_AUDIO_BYTES = 8_388_608;

let inboxDirectory = "";
let mediaDirectory = "";
let sessionCookie = "";

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The key the domain derives, spelled out here rather than imported, so a change shows. */
function expectedKey(bytes: Uint8Array, extension: string): string {
  const sha256 = digestOf(bytes);
  return `${sha256.slice(0, 2)}/${sha256}.${extension}`;
}

const DEFAULT_HEADERS = {
  "x-avaloria-submission-id": "sub-audio-001",
  "x-avaloria-question-id": "companion-animal",
  "x-avaloria-created-at": "2026-08-21T09:00:00.000Z",
};

function audioRequest(
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
  contentType = "audio/webm",
): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
      cookie: sessionCookie,
      ...DEFAULT_HEADERS,
      ...headers,
    },
    body: bytes,
  });
}

/** Deliberately without the cookie the helper above always adds. */
function anonymousRequest(
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "audio/webm",
      "content-length": String(bytes.byteLength),
      ...DEFAULT_HEADERS,
      ...headers,
    },
    body: bytes,
  });
}

/**
 * Filesystem errors, host paths, object keys and stack frames - anything a refusal could
 * carry out of the server and into a browser.
 */
const INTERNAL_DETAIL =
  /ENOTDIR|ENOENT|EACCES|ENOSPC|node:|\/private\/|\/var\/folders\/|at Object|at async|Error:|stack/iu;

/** Every key any response from this route is allowed to carry. */
const ALLOWED_BODY_KEYS = ["acknowledged", "error", "receiptId", "receivedAt"];

/**
 * Every allowlisted type, its container, and the extension the server must choose for it.
 *
 * Typed as a tuple array rather than inlined into `it.each`, which widens each column to
 * a union and loses the `Uint8Array<ArrayBuffer>` the Request body needs. Five rows,
 * matching AUDIO_MIME_EXTENSIONS: a type added to that table without a row here is not a
 * compile error, so it is worth saying out loud that this list has to be kept level with it.
 */
const ALLOWLISTED: ReadonlyArray<readonly [string, Uint8Array<ArrayBuffer>, string]> = [
  ["audio/webm", WEBM, "webm"],
  ["audio/ogg", OGG, "ogg"],
  ["audio/mp4", MP4, "m4a"],
  ["audio/mpeg", MP3_ID3, "mp3"],
  ["audio/wav", WAV, "wav"],
];

async function expectRefusal(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);

  const raw = await response.text();
  expect(raw, "a refusal must carry no internal detail").not.toMatch(INTERNAL_DETAIL);
  expect(raw, "a refusal must never echo the access code").not.toContain(TEST_FAMILY_ACCESS_CODE);
  expect(JSON.parse(raw)).toEqual({ acknowledged: false, error });
}

async function inboxLines(): Promise<InboxRecord[]> {
  let content: string;
  try {
    content = await readFile(join(inboxDirectory, INBOX_FILE), "utf8");
  } catch {
    return [];
  }
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as InboxRecord);
}

/** Every stored blob, as "<shard>/<name>", so "one file on disk" is a countable fact. */
async function mediaFiles(): Promise<string[]> {
  const found: string[] = [];
  const shards = await readdir(mediaDirectory, { withFileTypes: true }).catch(() => []);
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    for (const name of await readdir(join(mediaDirectory, shard.name))) {
      found.push(`${shard.name}/${name}`);
    }
  }
  return found.toSorted();
}

function asAudioRecord(record: InboxRecord | undefined) {
  expect(record?.kind).toBe("audio");
  if (record === undefined || record.kind !== "audio") {
    throw new Error(`expected an audio inbox record, got kind=${String(record?.kind)}`);
  }
  return record;
}

beforeEach(async () => {
  overrides.inboxStore = null;
  overrides.blobStore = null;

  inboxDirectory = await mkdtemp(join(tmpdir(), "avaloria-audio-inbox-"));
  mediaDirectory = await mkdtemp(join(tmpdir(), "avaloria-audio-media-"));

  // Blank, not deleted: the composition root uses `||` so a defined-but-empty value means
  // "no database configured", and stubbing the blank exercises that documented fallback
  // rather than routing around it. Without it a developer with DATABASE_URL exported in
  // their shell runs every case below against PostgreSQL.
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("AVALORIA_INBOX_DIR", inboxDirectory);
  vi.stubEnv("AVALORIA_MEDIA_DIR", mediaDirectory);
  vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", TEST_FAMILY_ACCESS_CODE);
  vi.stubEnv("AVALORIA_SESSION_SECRET", undefined);
  vi.stubEnv("AVALORIA_AUDIO_MAX_BYTES", undefined);
  vi.stubEnv("AVALORIA_AUDIO_RATE_LIMIT", undefined);
  vi.stubEnv("AVALORIA_AUDIO_RATE_WINDOW_MS", undefined);
  vi.stubEnv("AVALORIA_INBOX_RATE_LIMIT", undefined);
  resetRateLimitersForTest();
  sessionCookie = familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE);
});

afterEach(async () => {
  // unstubAllEnvs and nothing else - never `process.env = ...`, which swaps the object
  // vitest recorded its stubs against and silently stops every later unset from unsetting.
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetRateLimitersForTest();
  await rm(inboxDirectory, { recursive: true, force: true });
  await rm(mediaDirectory, { recursive: true, force: true });
});

describe("POST /api/inbox/submissions/audio access", () => {
  it("refuses an anonymous upload without reading a byte of its body", async () => {
    const request = anonymousRequest(WEBM);

    const response = await POST(request);

    await expectRefusal(response, 401, "unauthorized");
    // The whole reason the guard runs from headers alone: an 8 MiB body is exactly what
    // an unauthorised caller must not be able to make this server buffer.
    expect(request.bodyUsed).toBe(false);
    expect(await mediaFiles()).toEqual([]);
    expect(await inboxLines()).toEqual([]);
  });

  it("refuses a session minted under a different access code", async () => {
    const response = await POST(
      anonymousRequest(WEBM, { cookie: familySessionCookieHeader("ein-ganz-anderer-code") }),
    );

    await expectRefusal(response, 401, "unauthorized");
    expect(await mediaFiles()).toEqual([]);
  });

  it("fails closed when no family access code is configured", async () => {
    vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", undefined);

    const response = await POST(audioRequest(WEBM));

    await expectRefusal(response, 503, "inbox-unavailable");
    expect(await mediaFiles()).toEqual([]);
    expect(await inboxLines()).toEqual([]);
  });

  it("refuses a caller that uploads too often, and stores nothing for the refused one", async () => {
    vi.stubEnv("AVALORIA_AUDIO_RATE_LIMIT", "2");
    resetRateLimitersForTest();

    expect((await POST(audioRequest(WEBM, { "x-avaloria-submission-id": "a" }))).status).toBe(201);
    expect(
      (await POST(audioRequest(OGG, { "x-avaloria-submission-id": "b" }, "audio/ogg"))).status,
    ).toBe(201);

    const refused = await POST(
      audioRequest(WAV, { "x-avaloria-submission-id": "c" }, "audio/wav"),
    );

    await expectRefusal(refused, 429, "too-many-requests");
    expect((await inboxLines()).map((record) => record.submissionId)).toEqual(["a", "b"]);
    // The third recording never reached disk either: the guard runs before the body does.
    expect(await mediaFiles()).toHaveLength(2);
  });

  it("spends its own allowance, not the text inbox's", async () => {
    // The recordings bucket is deliberately tighter than the text one. Sharing a counter
    // would let a child uploading recordings lock their sibling out of typing an answer.
    vi.stubEnv("AVALORIA_AUDIO_RATE_LIMIT", "1");
    vi.stubEnv("AVALORIA_INBOX_RATE_LIMIT", "5");
    resetRateLimitersForTest();

    expect((await POST(audioRequest(WEBM, { "x-avaloria-submission-id": "a" }))).status).toBe(201);
    const exhausted = await POST(
      audioRequest(OGG, { "x-avaloria-submission-id": "b" }, "audio/ogg"),
    );
    expect(exhausted.status).toBe(429);

    const text = await POST_TEXT(
      new Request(TEXT_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "142",
          cookie: sessionCookie,
        },
        body: JSON.stringify({
          submissionId: "sub-text-1",
          questionId: "companion-animal",
          createdAt: "2026-08-21T09:00:00.000Z",
          originalText: "Ein Wolf aus Stein.",
        }),
      }),
    );

    expect(text.status, "the typed answer must still get through").toBe(201);
  });
});

describe("POST /api/inbox/submissions/audio validation", () => {
  it("refuses a declared type that is not on the allowlist, and writes nothing", async () => {
    const response = await POST(audioRequest(HTML, {}, "text/html"));

    await expectRefusal(response, 400, "invalid-payload");
    expect(await mediaFiles()).toEqual([]);
    expect(await inboxLines()).toEqual([]);
  });

  it("refuses an audio/* type that is not on the allowlist", async () => {
    // A prefix check would accept this. The allowlist is an exact table, not a namespace.
    const response = await POST(audioRequest(WAV, {}, "audio/x-wav"));

    await expectRefusal(response, 400, "invalid-payload");
    expect(await mediaFiles()).toEqual([]);
  });

  it("accepts the codecs parameter browsers actually send", async () => {
    // MediaRecorder produces exactly this content type. The parameter is dropped before
    // the allowlist comparison; the type itself is not.
    const response = await POST(audioRequest(WEBM, {}, "audio/webm;codecs=opus"));

    expect(response.status).toBe(201);
    expect(asAudioRecord((await inboxLines())[0]).audio.mimeType).toBe("audio/webm");
  });

  it("refuses a body it is told is over 8 MiB without reading it at all", async () => {
    const request = audioRequest(WEBM, { "content-length": String(MAX_AUDIO_BYTES + 1) });

    const response = await POST(request);

    await expectRefusal(response, 400, "invalid-payload");
    expect(request.bodyUsed).toBe(false);
    expect(await mediaFiles()).toEqual([]);
  });

  it("abandons an oversized body that declares no length, and stores nothing", async () => {
    // No content-length, so the declared-size guard cannot help: the streaming cap is the
    // only thing between this caller and however many bytes they care to send.
    let pulled = 0;
    const megabyte: Uint8Array<ArrayBuffer> = new Uint8Array(1024 * 1024).fill(0x11);
    megabyte.set(WEBM.slice(0, 9), 0);

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 12) return;
        controller.enqueue(megabyte);
        pulled += 1;
      },
    });

    const response = await POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "audio/webm", cookie: sessionCookie, ...DEFAULT_HEADERS },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );

    await expectRefusal(response, 400, "invalid-payload");
    // Nine, not twelve: the cap was crossed and the rest was never asked for.
    expect(pulled).toBeLessThanOrEqual(10);
    expect(await mediaFiles()).toEqual([]);
    expect(await inboxLines()).toEqual([]);
  });

  it("accepts a recording of exactly the documented maximum", async () => {
    // The boundary is inclusive. An off-by-one here refuses the largest legitimate
    // recording, and the refusal is indistinguishable from a genuinely oversized one.
    const atCap: Uint8Array<ArrayBuffer> = new Uint8Array(MAX_AUDIO_BYTES).fill(0x11);
    atCap.set(WEBM.slice(0, 9), 0);

    const response = await POST(audioRequest(atCap));

    expect(response.status).toBe(201);
    expect(asAudioRecord((await inboxLines())[0]).audio.sizeBytes).toBe(MAX_AUDIO_BYTES);
  });

  it("cannot be widened past the maximum by AVALORIA_AUDIO_MAX_BYTES", async () => {
    // MCL-49 finding F1, at the route and in the store mode where nothing else would have
    // caught it. This case runs against the real FileSubmissionInboxStore - MCL-48's
    // rollback path - which carries no CHECK constraint, so before the clamp the record
    // was appended and the child was handed a receipt for a recording production refuses.
    vi.stubEnv("AVALORIA_AUDIO_MAX_BYTES", "33554432");

    const store = vi.fn<AudioBlobStore["store"]>().mockResolvedValue(undefined);
    overrides.blobStore = { store, read: vi.fn(), checkWritable: vi.fn() };

    const overCap: Uint8Array<ArrayBuffer> = new Uint8Array(MAX_AUDIO_BYTES + 1).fill(0x11);
    overCap.set(WEBM.slice(0, 9), 0);

    const response = await POST(audioRequest(overCap));

    await expectRefusal(response, 400, "invalid-payload");
    // Before blob persistence, which is the part that cannot be undone: the bytes are
    // written first by design and are deliberately never deleted after a later failure,
    // so a refusal that arrived one step later would leave an orphan recording behind for
    // every attempt.
    expect(store).not.toHaveBeenCalled();
    expect(await inboxLines()).toEqual([]);
  });

  it("refuses an empty body", async () => {
    const response = await POST(audioRequest(new Uint8Array(0) as Uint8Array<ArrayBuffer>));

    await expectRefusal(response, 400, "invalid-payload");
    expect(await mediaFiles()).toEqual([]);
  });

  it.each([
    ["submission id", "x-avaloria-submission-id"],
    ["question id", "x-avaloria-question-id"],
    ["created-at", "x-avaloria-created-at"],
  ])("refuses an upload with no %s", async (_label, header) => {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS };
    delete headers[header];

    const response = await POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "audio/webm",
          "content-length": String(WEBM.byteLength),
          cookie: sessionCookie,
          ...headers,
        },
        body: WEBM,
      }),
    );

    await expectRefusal(response, 400, "invalid-payload");
    expect(await mediaFiles()).toEqual([]);
  });

  it("refuses a createdAt in a year the store cannot hold", async () => {
    // PostgreSQL has no year zero, and Date.toISOString spells anything outside 1..9999
    // with an expanded form timestamptz reads as a time zone displacement. Without this
    // the child retries an unchanged payload against a permanent 503 forever.
    const response = await POST(
      audioRequest(WEBM, { "x-avaloria-created-at": "0000-01-01T00:00:00Z" }),
    );

    await expectRefusal(response, 400, "invalid-payload");
    expect(await mediaFiles()).toEqual([]);
  });

  it("refuses a createdAt that is not an instant at all", async () => {
    const response = await POST(audioRequest(WEBM, { "x-avaloria-created-at": "irgendwann" }));

    await expectRefusal(response, 400, "invalid-payload");
  });

  it("refuses an identifier longer than the store's ceiling", async () => {
    const response = await POST(
      audioRequest(WEBM, { "x-avaloria-submission-id": "s".repeat(201) }),
    );

    await expectRefusal(response, 400, "invalid-payload");
    expect(await mediaFiles()).toEqual([]);
  });

  it("refuses bytes whose container disagrees with the declared type", async () => {
    // Declared wav, actually webm. Not "the sniffer wins": the client and the bytes
    // disagree, which is a refusal rather than something to silently resolve.
    const response = await POST(audioRequest(WEBM, {}, "audio/wav"));

    await expectRefusal(response, 400, "invalid-payload");
    expect(await mediaFiles()).toEqual([]);
    expect(await inboxLines()).toEqual([]);
  });

  it("refuses an executable declared as a recording", async () => {
    const response = await POST(audioRequest(ELF, {}, "audio/webm"));

    await expectRefusal(response, 400, "invalid-payload");
    expect(await mediaFiles()).toEqual([]);
  });

  it("refuses a RIFF container that is not a WAVE", async () => {
    // "RIFF" at offset 0 and something other than "WAVE" at offset 8 - an AVI. A naive
    // startsWith("RIFF") accepts it; the format word at offset 8 is what does not.
    const response = await POST(audioRequest(RIFF_AVI, {}, "audio/wav"));

    await expectRefusal(response, 400, "invalid-payload");
    expect(await mediaFiles()).toEqual([]);
  });

  it.each(ALLOWLISTED)(
    "stores a %s recording under the extension the server chose",
    async (mime, bytes, extension) => {
      const response = await POST(
        audioRequest(bytes, { "x-avaloria-submission-id": `sub-${extension}` }, mime),
      );

      expect(response.status).toBe(201);
      // The extension is the server's decision, read out of the domain's total table -
      // never the client's, which never arrives at all.
      expect(await mediaFiles()).toEqual([expectedKey(bytes, extension)]);
    },
  );
});

describe("POST /api/inbox/submissions/audio persistence", () => {
  it("stores the unchanged bytes, the metadata and a receipt", async () => {
    const response = await POST(audioRequest(WEBM));

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      acknowledged: boolean;
      receiptId: string;
      receivedAt: string;
    };
    expect(Object.keys(body).toSorted()).toEqual(["acknowledged", "receiptId", "receivedAt"]);
    expect(body.acknowledged).toBe(true);
    expect(body.receiptId.trim().length).toBeGreaterThan(0);
    expect(body.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const key = expectedKey(WEBM, "webm");
    const stored = await readFile(join(mediaDirectory, key));
    // Byte for byte. Nothing transcodes, re-containers or normalises a recording.
    expect(digestOf(stored)).toBe(digestOf(WEBM));
    expect(stored.byteLength).toBe(WEBM.byteLength);

    const records = await inboxLines();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      kind: "audio",
      receiptId: body.receiptId,
      receivedAt: body.receivedAt,
      submissionId: "sub-audio-001",
      questionId: "companion-animal",
      createdAt: "2026-08-21T09:00:00.000Z",
      audio: {
        objectKey: key,
        mimeType: "audio/webm",
        extension: "webm",
        sizeBytes: WEBM.byteLength,
        sha256: digestOf(WEBM),
      },
    });
  });

  it("issues its own receipt and ignores one the client tried to dictate", async () => {
    const response = await POST(
      audioRequest(WEBM, {
        "x-avaloria-receipt-id": "forged-receipt",
        "x-avaloria-received-at": "1999-01-01T00:00:00.000Z",
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { receiptId: string; receivedAt: string };
    expect(body.receiptId).not.toBe("forged-receipt");
    expect(body.receivedAt).not.toBe("1999-01-01T00:00:00.000Z");
  });

  it("derives the object key from the bytes alone, never from a filename a client sent", async () => {
    const response = await POST(
      audioRequest(WEBM, {
        "x-avaloria-filename": "../../etc/passwd",
        "content-disposition": 'attachment; filename="a.php"',
      }),
    );

    expect(response.status).toBe(201);

    const key = expectedKey(WEBM, "webm");
    expect(await mediaFiles()).toEqual([key]);
    // Not a substring of either hostile header, and not an executable extension. There is
    // no sanitisation step here to forget: the key is built from a server-computed digest
    // and an extension read out of the domain's table.
    expect(key).not.toContain("passwd");
    expect(key).not.toContain("..");
    expect(key).not.toContain(".php");
    expect(asAudioRecord((await inboxLines())[0]).audio.objectKey).toBe(key);
  });

  it("answers a retry with the first receipt and writes the file exactly once", async () => {
    const first = await POST(audioRequest(WEBM));
    expect(first.status).toBe(201);
    const firstReceipt = (await first.json()) as { receiptId: string; receivedAt: string };

    const key = expectedKey(WEBM, "webm");
    const before = await stat(join(mediaDirectory, key));

    const retry = await POST(audioRequest(WEBM));

    // 200, not 201: this call created nothing.
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({
      acknowledged: true,
      receiptId: firstReceipt.receiptId,
      receivedAt: firstReceipt.receivedAt,
    });

    const after = await stat(join(mediaDirectory, key));
    // Same inode and same mtime: the content-addressed fast path skipped the write rather
    // than rewriting identical bytes over a file an admin route may be reading.
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await mediaFiles()).toEqual([key]);
    expect(await inboxLines()).toHaveLength(1);
  });

  it("lets two submissions share one content-addressed recording", async () => {
    // Two children forwarding the same voice memo, or one child sending it under two
    // submissions. Content addressing means one file; the submission id is what is
    // unique, and the migration deliberately does not make the object key unique.
    const first = await POST(audioRequest(WEBM, { "x-avaloria-submission-id": "sub-one" }));
    const second = await POST(audioRequest(WEBM, { "x-avaloria-submission-id": "sub-two" }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const key = expectedKey(WEBM, "webm");
    expect(await mediaFiles()).toEqual([key]);

    const records = await inboxLines();
    expect(records.map((record) => record.submissionId)).toEqual(["sub-one", "sub-two"]);
    expect(records.map((record) => asAudioRecord(record).audio.objectKey)).toEqual([key, key]);
    expect(new Set(records.map((record) => record.receiptId)).size).toBe(2);
  });

  it("never reaches the database when the recording could not be stored", async () => {
    const appendIfAbsent = vi.fn();
    overrides.inboxStore = { appendIfAbsent };
    overrides.blobStore = {
      store: vi.fn().mockRejectedValue(new Error("ENOSPC: no space left on device")),
      read: vi.fn(),
      checkWritable: vi.fn(),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(audioRequest(WEBM));

    await expectRefusal(response, 503, "inbox-unavailable");
    // The order is the whole point: a row referencing a recording that was never written
    // is unrecoverable, so nothing may touch the database until the bytes are down.
    expect(appendIfAbsent).not.toHaveBeenCalled();
  });

  it("mints no receipt when the database fails after the recording was stored", async () => {
    overrides.inboxStore = {
      appendIfAbsent: vi.fn().mockRejectedValue(new Error("connection terminated")),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(audioRequest(WEBM));

    const raw = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(raw)).toEqual({ acknowledged: false, error: "inbox-unavailable" });
    // The one assertion this case exists for: no receipt of any kind reaches the caller.
    expect(raw).not.toContain("receiptId");
    expect(raw).not.toContain("receivedAt");

    // And the blob stays. Deleting it on rollback would be wrong, not merely wasteful:
    // the key is content-addressed and deliberately not unique, so it may already be
    // another submission's recording. An unreferenced blob is inert and a retry reuses it.
    expect(await mediaFiles()).toEqual([expectedKey(WEBM, "webm")]);
    expect(await inboxLines()).toEqual([]);
  });

  it("reports a store that refuses the values as a payload problem, not an outage", async () => {
    overrides.inboxStore = {
      appendIfAbsent: vi
        .fn()
        .mockRejectedValue(new SubmissionPayloadError("submission_inbox refused the values")),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(audioRequest(WEBM));

    // 400, not 503. A permanent refusal reported as an outage is a child retrying an
    // unchanged payload against a wall forever.
    await expectRefusal(response, 400, "invalid-payload");
  });

  it("reports an unwritable media directory with a stable code and no path", async () => {
    const blocker = join(mediaDirectory, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    vi.stubEnv("AVALORIA_MEDIA_DIR", join(blocker, "media"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(audioRequest(WEBM));

    await expectRefusal(response, 503, "inbox-unavailable");
    expect(await inboxLines()).toEqual([]);
  });

  it("reports an unwritable inbox with a stable code, leaving the recording on disk", async () => {
    const blocker = join(inboxDirectory, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    vi.stubEnv("AVALORIA_INBOX_DIR", join(blocker, "inbox"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(audioRequest(WEBM));

    await expectRefusal(response, 503, "inbox-unavailable");
    expect(await mediaFiles()).toEqual([expectedKey(WEBM, "webm")]);
  });

  it("carries nothing but its four allowed keys, whatever the outcome", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const responses = [
      await POST(anonymousRequest(WEBM)),
      await POST(audioRequest(HTML, {}, "text/html")),
      await POST(audioRequest(WEBM, {}, "audio/wav")),
      await POST(audioRequest(new Uint8Array(0) as Uint8Array<ArrayBuffer>)),
      await POST(audioRequest(WEBM)),
      await POST(audioRequest(WEBM)),
    ];

    for (const response of responses) {
      const body = (await response.json()) as Record<string, unknown>;
      for (const key of Object.keys(body)) {
        expect(ALLOWED_BODY_KEYS, `unexpected response key ${key}`).toContain(key);
      }
      // Never an object key, a path or a hash: those describe the host's filesystem.
      expect(JSON.stringify(body)).not.toContain(mediaDirectory);
      expect(JSON.stringify(body)).not.toContain(digestOf(WEBM));
    }
  });

  it("exposes no read or mutation method beyond POST", () => {
    expect(Object.keys(audioRoute).toSorted()).toEqual(["POST"]);
  });
});

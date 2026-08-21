import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpAudioAnswerInbox } from "@/adapters/http/http-audio-answer-inbox";
import { AudioAnswerSender } from "@/adapters/media/audio-answer-sender";
import type { CapturedAudio } from "@/adapters/media/audio-capture-controller";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";
import { familySessionCookieHeader } from "../support/family-session-header";
import { MP3_ID3, WEBM } from "../support/audio-fixtures";

/**
 * The two halves of the MCL-30B contract, meeting (MCL-30B).
 *
 * Every other test in this slice proves one side against a stand-in: the adapter against a
 * fake fetch, the route against a hand-built Request. Both can be green while the two
 * disagree about a header name, a content type or what a retry means - and that
 * disagreement is invisible until a child presses send. So this file drives the REAL send
 * machine through the REAL client adapter into the REAL route handler, against the REAL
 * file adapters in a temp directory. The only stand-in is the transport itself.
 *
 * What it is here to prove, in order of how expensive the mistake would be:
 *
 * 1. A recording made in a browser reaches durable storage and comes back with a receipt.
 * 2. An AMBIGUOUS first attempt - one that reached the server and whose answer the client
 *    never saw - followed by a retry leaves ONE recording, ONE row and ONE receipt. This
 *    is the case the stable submissionId exists for, and the case that silently produces
 *    duplicate answers if it is wrong.
 * 3. A file chosen because the microphone was unavailable takes exactly the same road.
 */

const { resetRateLimitersForTest } = await import("@/composition/server");
const { POST } = await import("@/app/api/inbox/submissions/audio/route");

const ENDPOINT = "http://localhost/api/inbox/submissions/audio";
const INBOX_FILE = "submissions.jsonl";
const QUESTION = "companion-animal";

let inboxDirectory = "";
let mediaDirectory = "";
let sessionCookie = "";

/**
 * A fetch that carries the request into the real handler instead of onto a network.
 *
 * The cookie is added here because a browser adds it there: the family session is
 * HttpOnly, so the adapter never sees it and must not be given a way to.
 */
function routedFetch(
  observe: (request: Request) => void = () => {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (_input, init) => {
    const request = new Request(ENDPOINT, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), cookie: sessionCookie },
    });
    observe(request);
    return POST(request);
  };
}

function senderWith(
  fetchImplementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): AudioAnswerSender {
  let issued = 0;
  return new AudioAnswerSender(new HttpAudioAnswerInbox({ fetchImplementation }), {
    createId: () => `contract-submission-${++issued}`,
    now: () => new Date("2026-08-22T09:00:00.000Z"),
  });
}

function capture(
  bytes: Uint8Array<ArrayBuffer>,
  type: string,
  source: "microphone" | "file" = "microphone",
): CapturedAudio {
  return {
    blob: new Blob([bytes], { type }),
    previewUrl: "blob:preview",
    source,
    fileName: source === "file" ? "meine-stimme.mp3" : null,
  };
}

/** Every stored recording, as flat object keys under the media directory. */
async function storedRecordings(): Promise<string[]> {
  const shards = await readdir(mediaDirectory, { withFileTypes: true });
  const files = await Promise.all(
    shards.map(async (shard) =>
      shard.isDirectory()
        ? (await readdir(join(mediaDirectory, shard.name))).map((name) => `${shard.name}/${name}`)
        : [],
    ),
  );
  return files.flat().sort();
}

async function inboxRows(): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(inboxDirectory, INBOX_FILE), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  inboxDirectory = await mkdtemp(join(tmpdir(), "avaloria-30b-inbox-"));
  mediaDirectory = await mkdtemp(join(tmpdir(), "avaloria-30b-media-"));

  // Blank, not deleted: the composition root uses `||`, so a defined-but-empty value means
  // "no database configured". Without this a developer with DATABASE_URL exported in their
  // shell runs this whole file against PostgreSQL.
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("AVALORIA_INBOX_DIR", inboxDirectory);
  vi.stubEnv("AVALORIA_MEDIA_DIR", mediaDirectory);
  vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", TEST_FAMILY_ACCESS_CODE);
  vi.stubEnv("AVALORIA_SESSION_SECRET", undefined);
  vi.stubEnv("AVALORIA_AUDIO_MAX_BYTES", undefined);
  vi.stubEnv("AVALORIA_AUDIO_RATE_LIMIT", undefined);
  vi.stubEnv("AVALORIA_AUDIO_RATE_WINDOW_MS", undefined);
  resetRateLimitersForTest();
  sessionCookie = familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(inboxDirectory, { recursive: true, force: true });
  await rm(mediaDirectory, { recursive: true, force: true });
});

describe("a recording sent from the browser reaches the real route", () => {
  it("stores the unchanged bytes and answers with a receipt the sender accepts", async () => {
    const requests: Request[] = [];
    const sender = senderWith(routedFetch((request) => requests.push(request)));
    const recording = capture(WEBM, "audio/webm;codecs=opus");

    await sender.send(recording, QUESTION);

    const state = sender.snapshot();
    expect(state.phase).toBe("sent");
    expect(state.receipt?.receiptId.length ?? 0).toBeGreaterThan(0);

    // The route read every identifier it needed out of the headers this adapter set. If a
    // name were wrong on either side, this would be a 400 and the phase would be `failed`.
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("x-avaloria-submission-id")).toBe("contract-submission-1");
    expect(requests[0].headers.get("content-type")).toBe("audio/webm");

    // One recording on the device, byte-identical to what the microphone produced.
    const stored = await storedRecordings();
    expect(stored).toHaveLength(1);
    const bytes = await readFile(join(mediaDirectory, stored[0]));
    expect(Array.from(new Uint8Array(bytes))).toEqual(Array.from(WEBM));

    // And one row, carrying the receipt the child was shown and nothing the client sent
    // about where the bytes live.
    const rows = await inboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("audio");
    expect(rows[0].submissionId).toBe("contract-submission-1");
    expect(rows[0].receiptId).toBe(state.receipt?.receiptId);
  });

  it("converges on one receipt when a retry follows an attempt whose answer was lost", async () => {
    // The ambiguous case, built exactly as it happens: the request REACHES the server and
    // is stored, and the client never sees the answer. A client that minted a fresh
    // submissionId here would leave two rows for one spoken answer, and nobody reading the
    // inbox could tell which one the child meant.
    let attempts = 0;
    const sender = senderWith(async (input, init) => {
      attempts += 1;
      const answer = await routedFetch()(input, init);
      if (attempts === 1) {
        // The server has already stored it at this point. The deadline passes here.
        throw new DOMException("The operation was aborted.", "TimeoutError");
      }
      return answer;
    });

    const recording = capture(WEBM, "audio/webm");

    await sender.send(recording, QUESTION);
    expect(sender.snapshot().phase).toBe("failed");
    expect(sender.snapshot().failure).toBe("transport");

    await sender.send(recording, QUESTION);
    expect(sender.snapshot().phase).toBe("sent");

    expect(attempts).toBe(2);
    // One recording, one row, one receipt - and the receipt the child finally reads is the
    // one the FIRST attempt minted, because the route answers a known submissionId with
    // the record it already holds.
    expect(await storedRecordings()).toHaveLength(1);
    const rows = await inboxRows();
    expect(rows).toHaveLength(1);
    expect(sender.snapshot().receipt?.receiptId).toBe(rows[0].receiptId);
  });

  it("sends a chosen file down the very same road as a recording", async () => {
    const requests: Request[] = [];
    const sender = senderWith(routedFetch((request) => requests.push(request)));

    // A picked .mp3 whose browser label is a vendor spelling the route's allowlist does
    // not contain. Sniffing is what makes it arrive as `audio/mpeg` instead of a 400.
    await sender.send(capture(MP3_ID3, "audio/mp3", "file"), QUESTION);

    expect(sender.snapshot().phase).toBe("sent");
    expect(requests[0].headers.get("content-type")).toBe("audio/mpeg");

    const stored = await storedRecordings();
    expect(stored).toHaveLength(1);
    expect(stored[0].endsWith(".mp3")).toBe(true);

    const rows = await inboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("audio");
    // The client's filename reached nothing: the key is derived from a server-computed
    // digest, and there is no field on the row that could carry one.
    expect(JSON.stringify(rows[0])).not.toContain("meine-stimme");
  });

  it("does not claim arrival when the family session is gone", async () => {
    const sender = senderWith(async (_input, init) => {
      // No cookie at all - what a browser sends once the session expired.
      const request = new Request(ENDPOINT, {
        ...init,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return POST(request);
    });

    await sender.send(capture(WEBM, "audio/webm"), QUESTION);

    expect(sender.snapshot().phase).toBe("failed");
    expect(sender.snapshot().failure).toBe("unauthorized");
    expect(sender.snapshot().receipt).toBeNull();
    // Nothing was written by an unauthorised call - not a byte, not a row.
    expect(await storedRecordings()).toHaveLength(0);
    await expect(readdir(inboxDirectory)).resolves.toEqual([]);
  });

  it("does not claim arrival when the upload bucket is empty", async () => {
    vi.stubEnv("AVALORIA_AUDIO_RATE_LIMIT", "1");
    resetRateLimitersForTest();

    const sender = senderWith(routedFetch());
    await sender.send(capture(WEBM, "audio/webm"), QUESTION);
    expect(sender.snapshot().phase).toBe("sent");

    const second = senderWith(routedFetch());
    await second.send(capture(MP3_ID3, "audio/mpeg"), QUESTION);

    expect(second.snapshot().phase).toBe("failed");
    // Named apart from a refusal on purpose: this one is worth trying again in a minute,
    // and the sentence a child reads says exactly that.
    expect(second.snapshot().failure).toBe("rate-limited");
    expect(second.snapshot().receipt).toBeNull();
  });

  it("refuses a recording the route cannot store without ever claiming it arrived", async () => {
    // A deployment that lowered the ceiling below what the browser checks. The client-side
    // check passes, the route refuses from the declared length, and the child is told the
    // truth rather than shown a receipt.
    vi.stubEnv("AVALORIA_AUDIO_MAX_BYTES", "2");
    resetRateLimitersForTest();

    const sender = senderWith(routedFetch());
    await sender.send(capture(WEBM, "audio/webm"), QUESTION);

    expect(sender.snapshot().phase).toBe("failed");
    expect(sender.snapshot().failure).toBe("refused");
    expect(await storedRecordings()).toHaveLength(0);
  });
});

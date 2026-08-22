import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpAudioAnswerInbox } from "@/adapters/http/http-audio-answer-inbox";
import { AudioAnswerSender } from "@/adapters/media/audio-answer-sender";
import type { CapturedAudio } from "@/adapters/media/audio-capture-controller";
import { audioSendFailureMessage } from "@/app/audio-send-message";
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
 * 2. An AMBIGUOUS first attempt, in BOTH of its shapes, followed by a retry leaves ONE
 *    recording, ONE row and ONE receipt. This is the case the stable submissionId exists
 *    for, and the case that silently produces duplicate answers if it is wrong. The two
 *    shapes are: an answer the client never saw at all, and - MCL-30B review finding F1 -
 *    an answer that came back HTTP-successful and valid JSON with the receipt fields gone.
 *    Both are the same fact about the client (no acknowledgement in hand) and the same
 *    fact about the server (it may hold the recording already), so both have to end in a
 *    retryable state rather than a refusal, and both are built here against the REAL route
 *    with the recording REALLY stored, because a fake response could not prove that.
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

  it("converges on one receipt when the first answer came back stripped of its receipt", async () => {
    // MCL-30B review finding F1, built as the dangerous case rather than as a fake
    // malformed response. Everything on the server side really happens: the route runs,
    // the blob is written, the row is appended, a real receipt is minted. Only the ANSWER
    // is damaged on the way back - still 201, still valid JSON, still saying yes, with the
    // two fields that make it an acknowledgement removed, exactly as a proxy, a response
    // rewrite or a truncated body removes them.
    //
    // Nothing about that is visible to the client, which is the whole point: it knows only
    // that it holds no receipt. Reading that as `refused` would tell the child to record
    // something new, and this test is what proves the recording they already made is fine
    // and already at the project - so obeying that sentence would file a SECOND answer for
    // one spoken sentence.
    const submissionIds: string[] = [];
    const statuses: number[] = [];
    let mintedOnFirstAttempt = "";
    let attempts = 0;

    const sender = senderWith(async (input, init) => {
      attempts += 1;
      const answer = await routedFetch((request) => {
        submissionIds.push(request.headers.get("x-avaloria-submission-id") ?? "");
      })(input, init);
      statuses.push(answer.status);

      if (attempts > 1) return answer;

      const body = (await answer.json()) as Record<string, unknown>;
      // The server's own answer, before it is damaged: a real acknowledgement with a real
      // receipt. Asserted rather than assumed, because if the route had refused this
      // attempt the rest of the test would be measuring the wrong scenario entirely.
      expect(body.acknowledged).toBe(true);
      expect(typeof body.receiptId).toBe("string");
      mintedOnFirstAttempt = String(body.receiptId);

      return new Response(JSON.stringify({ acknowledged: true }), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    });

    const recording = capture(WEBM, "audio/webm");
    await sender.send(recording, QUESTION);

    // 201 with a real receipt behind it: the recording IS durably stored right now, and
    // the client has no way to know it.
    expect(statuses).toEqual([201]);
    expect(mintedOnFirstAttempt.length).toBeGreaterThan(0);

    // Retryable, and not the permanent reason. No receipt, so no arrival is drawn.
    expect(sender.snapshot().phase).toBe("failed");
    expect(sender.snapshot().failure).toBe("transport");
    expect(sender.snapshot().receipt).toBeNull();
    // The recording is still in hand, so the button the child presses next is a retry of
    // this answer and not the start of another one.
    expect(sender.snapshot().recording).toBe(recording);

    const failure = sender.snapshot().failure;
    expect(failure).not.toBeNull();
    const sentence = audioSendFailureMessage(failure!);
    // What the child actually reads has to match what is actually true: try this again.
    expect(sentence).toContain("noch einmal");
    // And must not be the one sentence that asks for a new recording - which is precisely
    // the sentence `refused` produces, and precisely how a duplicate answer gets filed.
    expect(sentence).not.toBe(audioSendFailureMessage("refused"));
    expect(sentence.toLowerCase()).not.toMatch(/nimm|such/u);

    await sender.send(recording, QUESTION);

    expect(sender.snapshot().phase).toBe("sent");
    expect(attempts).toBe(2);
    // The retry reached the real route carrying the SAME identity - not a similar one, the
    // same string - which is the only reason the route could recognise it.
    expect(submissionIds).toEqual(["contract-submission-1", "contract-submission-1"]);
    expect(sender.submissionIdFor(recording)).toBe("contract-submission-1");
    // 200, not 201: the route created nothing the second time and answered with the record
    // it already held.
    expect(statuses).toEqual([201, 200]);

    // Exactly one of each, which is the claim this whole file exists to make.
    const stored = await storedRecordings();
    expect(stored).toHaveLength(1);
    const bytes = await readFile(join(mediaDirectory, stored[0]));
    expect(Array.from(new Uint8Array(bytes))).toEqual(Array.from(WEBM));

    const rows = await inboxRows();
    expect(rows).toHaveLength(1);
    expect(new Set(rows.map((row) => row.receiptId)).size).toBe(1);

    // And the receipt the child finally reads is the one minted during the attempt whose
    // answer was destroyed - not a second one issued to paper over it.
    expect(sender.snapshot().receipt?.receiptId).toBe(mintedOnFirstAttempt);
    expect(rows[0].receiptId).toBe(mintedOnFirstAttempt);
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

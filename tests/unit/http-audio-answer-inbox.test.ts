import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { HttpAudioAnswerInbox } from "@/adapters/http/http-audio-answer-inbox";
import {
  AudioAnswerInboxError,
  type AudioAnswerDraft,
} from "@/application/media/audio-answer-inbox";
import { AudioAnswerSender } from "@/adapters/media/audio-answer-sender";
import { createBrowserAudioAnswerSender } from "@/composition/browser";
import { WEBM } from "../support/audio-fixtures";

/**
 * The client half of the audio upload contract (MCL-30B).
 *
 * What this file pins is the half a green happy path never shows: which of the route's
 * four refusals became which named reason, and what happens to an answer that looks
 * positive and carries no receipt. A child is told "im Projekt angekommen" from exactly one
 * value in this codebase - a receipt - and the only place a fake one could be invented is
 * here, in the code that reads the answer.
 *
 * That last shape is graded twice, because it has two independent ways to be wrong and
 * MCL-30B review finding F1 caught the second one:
 *
 * - it must never produce a receipt, so no arrival is ever drawn from it; and
 * - it must not be reported as `refused` either. A receipt-less 2xx is a statement about
 *   what this client KNOWS, not about what the server STORED, and `refused` is the one
 *   reason whose sentence asks the child to record something new - which for a server that
 *   did store the recording means a second answer for one spoken sentence.
 *
 * The header NAMES are asserted as literal strings on purpose. They are the contract with
 * a route this adapter cannot import, and a rename on one side has to fail here rather
 * than at runtime in a child's browser. tests/unit/audio-send-contract.test.ts then proves
 * the two sides really do meet, by driving this adapter against the real handler.
 */

const DRAFT: AudioAnswerDraft = {
  submissionId: "sub-audio-30b",
  questionId: "companion-animal",
  createdAt: "2026-08-22T09:00:00.000Z",
  mimeType: "audio/webm",
  bytes: new Blob([WEBM], { type: "audio/webm;codecs=opus" }),
};

type Call = Readonly<{ input: RequestInfo | URL; init?: RequestInit }>;

function recordingFetch(response: () => Promise<Response>): {
  calls: Call[];
  fetchImplementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetchImplementation: async (input, init) => {
      calls.push({ input, init });
      return response();
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function acknowledged(status: 200 | 201): Response {
  return jsonResponse(
    { acknowledged: true, receiptId: "receipt-audio-1", receivedAt: "2026-08-22T09:00:01.000Z" },
    status,
  );
}

function headersOf(call: Call): Headers {
  return new Headers(call.init?.headers as HeadersInit);
}

/** The reason a rejected deliver() carried, or a legible failure if it resolved. */
async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AudioAnswerInboxError) return error.reason;
    throw error;
  }

  throw new Error("expected deliver() to reject, but it resolved");
}

describe("HttpAudioAnswerInbox", () => {
  it("posts the original bytes with the identifiers in the headers the route reads", async () => {
    const { calls, fetchImplementation } = recordingFetch(async () => acknowledged(201));

    const receipt = await new HttpAudioAnswerInbox({ fetchImplementation }).deliver(DRAFT);

    expect(receipt).toEqual({
      receiptId: "receipt-audio-1",
      receivedAt: "2026-08-22T09:00:01.000Z",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("/api/inbox/submissions/audio");
    expect(calls[0].init?.method).toBe("POST");

    const headers = headersOf(calls[0]);
    expect(headers.get("x-avaloria-submission-id")).toBe("sub-audio-30b");
    expect(headers.get("x-avaloria-question-id")).toBe("companion-animal");
    expect(headers.get("x-avaloria-created-at")).toBe("2026-08-22T09:00:00.000Z");

    // The sniffed type, not the Blob's own label: the route refuses a request whose
    // declared type disagrees with what the bytes say, and `audio/webm;codecs=opus` is
    // not an allowlist member.
    expect(headers.get("content-type")).toBe("audio/webm");

    // The captured object itself is handed to fetch. Not re-encoded, not copied into a
    // JSON envelope: the recording the server stores has to be the recording the
    // microphone made, byte for byte.
    expect(calls[0].init?.body).toBe(DRAFT.bytes);
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("carries the recording unchanged, byte for byte", async () => {
    let sent: Uint8Array | null = null;
    const inbox = new HttpAudioAnswerInbox({
      fetchImplementation: async (_input, init) => {
        sent = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        return acknowledged(201);
      },
    });

    await inbox.deliver(DRAFT);

    expect(sent).not.toBeNull();
    expect(Array.from(sent!)).toEqual(Array.from(WEBM));
  });

  it("reads a retry's 200 as the acknowledgement it is", async () => {
    const inbox = new HttpAudioAnswerInbox({ fetchImplementation: async () => acknowledged(200) });

    // 200 rather than 201 is how the route answers a submissionId it already holds. It is
    // an acknowledgement of the same standing as the first one, and treating it as
    // anything else would leave a child retrying something that arrived long ago.
    await expect(inbox.deliver(DRAFT)).resolves.toEqual({
      receiptId: "receipt-audio-1",
      receivedAt: "2026-08-22T09:00:01.000Z",
    });
  });

  it.each([
    { status: 400, reason: "refused" },
    { status: 401, reason: "unauthorized" },
    { status: 403, reason: "unauthorized" },
    { status: 404, reason: "refused" },
    { status: 413, reason: "refused" },
    { status: 429, reason: "rate-limited" },
    { status: 500, reason: "unavailable" },
    { status: 502, reason: "unavailable" },
    { status: 503, reason: "unavailable" },
  ])("reports $status as $reason", async ({ status, reason }) => {
    const inbox = new HttpAudioAnswerInbox({
      fetchImplementation: async () => jsonResponse({ acknowledged: false, error: "x" }, status),
    });

    await expect(reasonOf(inbox.deliver(DRAFT))).resolves.toBe(reason);
  });

  it("draws no arrival from an answer that says yes without a receipt", async () => {
    for (const status of [200, 201] as const) {
      for (const body of [
        { acknowledged: true },
        { acknowledged: true, receiptId: "r-1" },
        { acknowledged: true, receiptId: "   ", receivedAt: "2026-08-22T09:00:01.000Z" },
        { acknowledged: true, receiptId: "r-1", receivedAt: "" },
        { acknowledged: "true", receiptId: "r-1", receivedAt: "2026-08-22T09:00:01.000Z" },
        { receiptId: "r-1", receivedAt: "2026-08-22T09:00:01.000Z" },
        {},
        null,
        "ok",
      ]) {
        const inbox = new HttpAudioAnswerInbox({
          fetchImplementation: async () => jsonResponse(body, status),
        });

        // Rejecting at all is the first property: none of these may resolve, because a
        // resolved deliver() is the only thing in this codebase that can draw "Im Projekt
        // angekommen". Both success statuses are exercised - 201 is a first upload, 200 is
        // the answer to a submissionId the route already holds, and an intermediary can
        // strip a receipt out of either.
        await expect(reasonOf(inbox.deliver(DRAFT))).resolves.toBe(
          // MCL-30B finding F1, and the second property. Not `refused`: the only thing
          // proved here is that no acknowledgement got back to this browser. The server
          // may hold the blob, the row and a receipt that a proxy, a response rewrite or a
          // truncated body removed on the way. tests/unit/audio-send-contract.test.ts
          // builds exactly that server and shows the retry this reason invites converging
          // on the stored receipt instead of filing a duplicate.
          "transport",
        );
      }
    }
  });

  it("keeps a 200 whose body cannot be read retryable rather than calling it a refusal", async () => {
    const inbox = new HttpAudioAnswerInbox({
      fetchImplementation: async () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    // The server may well hold the recording; telling a child to record something new
    // would be the one wrong answer here.
    await expect(reasonOf(inbox.deliver(DRAFT))).resolves.toBe("transport");
  });

  it("reports a request that never produced an answer as transport", async () => {
    const inbox = new HttpAudioAnswerInbox({
      fetchImplementation: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await expect(reasonOf(inbox.deliver(DRAFT))).resolves.toBe("transport");
  });

  it("ends an attempt that hangs, instead of leaving a child waiting forever", async () => {
    const inbox = new HttpAudioAnswerInbox({
      timeoutMs: 20,
      fetchImplementation: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });

    await expect(reasonOf(inbox.deliver(DRAFT))).resolves.toBe("transport");
  });

  it("gives an upload a deadline of its own, far longer than the text inbox's ten seconds", async () => {
    // Not a style preference. 8 MiB in 10 s needs 6.7 Mbit/s of UPLOAD, which almost no
    // household line has, so inheriting the text inbox's timeout would fail every long
    // recording on the deadline rather than on anything real. Read from the source rather
    // than measured, because measuring it means waiting two minutes; the regression this
    // guards against is an edit that "tidies" the two adapters into one shared constant,
    // and that edit is visible right here.
    const audio = await readFile("src/adapters/http/http-audio-answer-inbox.ts", "utf8");
    const text = await readFile("src/adapters/http/http-submission-inbox.ts", "utf8");

    expect(audio).toContain("const DEFAULT_TIMEOUT_MS = 120_000;");
    expect(text).toContain("const DEFAULT_TIMEOUT_MS = 10_000;");
    // And the audio adapter states its own rather than importing the text one's.
    expect(audio).not.toContain("http-submission-inbox");
  });

  it("is the inbox the browser composition root hands the recording area", async () => {
    // The factory is the only place production wiring happens. A sender built against
    // some other inbox - or against this one pointed at the text endpoint - would pass
    // every case above while sending a child's recording nowhere.
    expect(createBrowserAudioAnswerSender()).toBeInstanceOf(AudioAnswerSender);

    const composition = await readFile("src/composition/browser.ts", "utf8");
    expect(composition).toContain("new HttpAudioAnswerInbox()");

    // The default endpoint is the route this slice exists to reach, and it is only
    // exercised when nobody overrides it - which is exactly what the factory does.
    const calls: string[] = [];
    await new HttpAudioAnswerInbox({
      fetchImplementation: async (input) => {
        calls.push(String(input));
        return acknowledged(201);
      },
    }).deliver(DRAFT);
    expect(calls).toEqual(["/api/inbox/submissions/audio"]);
  });
});

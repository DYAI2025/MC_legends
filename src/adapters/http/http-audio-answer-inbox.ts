import { readServerReceipt } from "@/adapters/http/server-receipt";
import {
  AudioAnswerInboxError,
  type AudioAnswerDraft,
  type AudioAnswerInbox,
  type AudioInboxFailureReason,
} from "@/application/media/audio-answer-inbox";
import type { ServerReceipt } from "@/domain/submissions/submission";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_ENDPOINT = "/api/inbox/submissions/audio";

/**
 * The header each identifier travels in.
 *
 * Spelled out here rather than imported from the route: the route is server code and this
 * is the client half of the same contract, so the two agreeing has to be *proved* by a
 * test that drives this adapter against the real handler, not assumed by sharing a
 * constant that a rename would move on both sides at once. That test is
 * tests/unit/audio-send-contract.test.ts.
 *
 * A custom header is also what keeps this from being a simple cross-origin request, which
 * is the property the route relies on in place of the text route's required
 * application/json - a form post from another site cannot produce these.
 */
const IDENTIFIER_HEADERS = {
  submissionId: "x-avaloria-submission-id",
  questionId: "x-avaloria-question-id",
  createdAt: "x-avaloria-created-at",
} as const satisfies Record<"submissionId" | "questionId" | "createdAt", string>;

/**
 * How long one upload may take, in milliseconds, before the attempt is ended.
 *
 * 120 seconds, and deliberately not the text inbox's 10. That number is sized for a JSON
 * document the server caps at 16 KiB; this route accepts up to 8 MiB. Inheriting it would
 * mean every recording made on a family or mobile connection failed on the deadline rather
 * than on anything real: 8 MiB in 10 s needs 6.7 Mbit/s of *upload*, which almost no
 * household line has.
 *
 * The arithmetic behind 120 s: 8 MiB / 120 s is about 70 KB/s, so the deadline tolerates
 * any uplink at or above roughly 0.6 Mbit/s at the maximum recording size, and a typical
 * spoken answer is a small fraction of that ceiling.
 *
 * Bounded rather than absent, because the failure this replaces is worse than a slow
 * upload: without a deadline a hung connection leaves a child watching "wird gesendet"
 * forever, with no way back to the button. AbortSignal.timeout is a TOTAL deadline and not
 * an idle one - fetch offers no upload-progress signal without duplex streaming, so a
 * genuinely slower uplink ends as a retryable "we could not reach the project" with the
 * recording still in hand.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

export type HttpAudioAnswerInboxOptions = Readonly<{
  endpoint?: string;
  fetchImplementation?: Fetch;
  timeoutMs?: number;
}>;

/**
 * Which failure a refusal is, from the status alone.
 *
 * A total decision rather than a chain of `>= 400` tests, because the difference between
 * these is the difference between the sentences a child reads. 403 is folded in with 401:
 * this route only ever answers 401, but a proxy in front of it can answer 403, and both
 * mean the same thing to a child - this browser is not signed in any more.
 */
function refusalReason(status: number): AudioInboxFailureReason {
  if (status === 401 || status === 403) {
    return "unauthorized";
  }

  if (status === 429) {
    return "rate-limited";
  }

  // Everything the server cannot do right now, including a proxy's own 502/504. Retrying
  // can work, so this must not be reported as a refusal of the recording itself.
  if (status >= 500) {
    return "unavailable";
  }

  return "refused";
}

/**
 * Same-origin delivery of one recording to the family project inbox (MCL-30B).
 *
 * Carries no credential of its own: the family session is an HttpOnly cookie the browser
 * attaches, and this adapter never reads it. It knows nothing about microphones either -
 * it is handed bytes and three identifiers and reports exactly one of two things back, a
 * receipt or a named failure.
 *
 * The bytes are sent as the request body, unwrapped. Not multipart, not base64: a
 * multipart envelope would introduce a filename field the route deliberately has no code
 * path for, and base64 would grow an 8 MiB recording past the cap for nothing.
 */
export class HttpAudioAnswerInbox implements AudioAnswerInbox {
  private readonly endpoint: string;
  private readonly fetchImplementation: Fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpAudioAnswerInboxOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImplementation = options.fetchImplementation ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async deliver(draft: AudioAnswerDraft): Promise<ServerReceipt> {
    let response: Response;

    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          // The sniffed type, not the Blob's own label. The route refuses a request whose
          // declared type disagrees with what the bytes say they are, and a browser's
          // label carries codec parameters and vendor spellings that would not match.
          "content-type": draft.mimeType,
          [IDENTIFIER_HEADERS.submissionId]: draft.submissionId,
          [IDENTIFIER_HEADERS.questionId]: draft.questionId,
          [IDENTIFIER_HEADERS.createdAt]: draft.createdAt,
        },
        // The captured object itself. fetch derives content-length from it, which is what
        // lets the route refuse an oversized upload from the declared length before it
        // reads a single byte.
        body: draft.bytes,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // Offline, aborted, DNS, the deadline - none of them tell us whether the server
      // saw the request. `transport` is the honest answer and the retryable one, and the
      // route's idempotency by submissionId is what makes that retry safe.
      throw new AudioAnswerInboxError("transport", { cause });
    }

    if (!response.ok) {
      throw new AudioAnswerInboxError(refusalReason(response.status));
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch (cause) {
      // A 200 whose body cannot be read is not an acknowledgement. It is also not a
      // refusal of the recording: the server may well have stored it, so this stays
      // retryable rather than telling a child to record something else.
      throw new AudioAnswerInboxError("transport", { cause });
    }

    const receipt = readServerReceipt(body);
    if (receipt === null) {
      // The one case this class exists to get right - and the one that is easy to get
      // wrong twice over.
      //
      // First half: a positive-looking answer without two real receipt fields must never
      // become "Im Projekt angekommen", however cheerful its status code was. That much
      // `readServerReceipt` returning null has already decided, and nothing below relaxes
      // it - this method still produces no receipt, so no success is drawn.
      //
      // Second half, and MCL-30B review finding F1: this is NOT a refusal. A receipt-less
      // 2xx proves exactly one thing - that THIS CLIENT holds no durable acknowledgement.
      // It proves nothing about the server, which may already have written the blob, the
      // row and a receipt that a proxy, a response rewrite, a truncated body or a contract
      // regression then removed on the way back. Classifying that as `refused` hands the
      // child the one sentence a retry cannot follow - record something new - and a child
      // who obeys it files a SECOND answer for a recording the project already holds.
      //
      // `transport` is the honest reading and the retryable one: no usable answer reached
      // us. It is the same answer this file gives a 2xx whose body will not parse, for the
      // same reason, and the route's idempotency by submissionId is what makes the retry
      // it invites converge on the receipt that may already exist rather than duplicate it.
      throw new AudioAnswerInboxError("transport");
    }

    return receipt;
  }
}

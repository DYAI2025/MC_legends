import { type SubmissionInbox, SubmissionInboxError } from "@/application/submissions/submission-inbox";
import type { ServerReceipt, TextSubmission } from "@/domain/submissions/submission";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_ENDPOINT = "/api/inbox/submissions";
const DEFAULT_TIMEOUT_MS = 10_000;

export type HttpSubmissionInboxOptions = Readonly<{
  endpoint?: string;
  fetchImplementation?: Fetch;
  timeoutMs?: number;
}>;

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Reads a receipt out of a server answer. Anything less than an explicit
 * `acknowledged: true` plus two non-blank receipt fields is treated as a refusal,
 * so a well-meaning-but-wrong server cannot produce a fake acknowledgement.
 */
function readReceipt(body: unknown): ServerReceipt | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const answer = body as Record<string, unknown>;
  if (answer.acknowledged !== true) {
    return null;
  }

  if (!nonBlankString(answer.receiptId) || !nonBlankString(answer.receivedAt)) {
    return null;
  }

  return { receiptId: answer.receiptId.trim(), receivedAt: answer.receivedAt.trim() };
}

/**
 * Same-origin delivery adapter for the family project inbox. It carries no
 * credentials and knows no secrets - the route it talks to owns all server access.
 *
 * Options rather than positional arguments so the production defaults can be used
 * with any single one of them overridden; a test that had to restate the endpoint in
 * order to inject a fetch would leave the real default endpoint unexercised.
 */
export class HttpSubmissionInbox implements SubmissionInbox {
  private readonly endpoint: string;
  private readonly fetchImplementation: Fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpSubmissionInboxOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImplementation = options.fetchImplementation ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async deliver(submission: TextSubmission): Promise<ServerReceipt> {
    let response: Response;

    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          submissionId: submission.id,
          questionId: submission.questionId,
          createdAt: submission.createdAt,
          originalText: submission.originalText,
        }),
        // A server that hangs instead of answering must still end this attempt,
        // otherwise the child is left waiting on a promise that never settles.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new SubmissionInboxError("transport", { cause });
    }

    if (!response.ok) {
      // A failing inbox may work in a minute; a rejected submission will not.
      throw new SubmissionInboxError(response.status >= 500 ? "transport" : "refused");
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch (cause) {
      throw new SubmissionInboxError("transport", { cause });
    }

    const receipt = readReceipt(body);
    if (receipt === null) {
      throw new SubmissionInboxError("refused");
    }

    return receipt;
  }
}

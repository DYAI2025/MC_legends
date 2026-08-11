import type { SubmissionInbox } from "@/application/submissions/submission-inbox";
import type { ServerReceipt, TextSubmission } from "@/domain/submissions/submission";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_ENDPOINT = "/api/inbox/submissions";
const NOT_ACKNOWLEDGED = "inbox did not acknowledge the submission";

function notAcknowledged(cause?: unknown): Error {
  return cause === undefined ? new Error(NOT_ACKNOWLEDGED) : new Error(NOT_ACKNOWLEDGED, { cause });
}

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

  return { receiptId: answer.receiptId, receivedAt: answer.receivedAt };
}

/**
 * Same-origin delivery adapter for the family project inbox. It carries no
 * credentials and knows no secrets - the route it talks to owns all server access.
 */
export class HttpSubmissionInbox implements SubmissionInbox {
  constructor(
    private readonly endpoint: string = DEFAULT_ENDPOINT,
    private readonly fetchImplementation: Fetch = (input, init) => fetch(input, init),
  ) {}

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
      });
    } catch (cause) {
      throw notAcknowledged(cause);
    }

    if (!response.ok) {
      throw notAcknowledged();
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch (cause) {
      throw notAcknowledged(cause);
    }

    const receipt = readReceipt(body);
    if (receipt === null) {
      throw notAcknowledged();
    }

    return receipt;
  }
}

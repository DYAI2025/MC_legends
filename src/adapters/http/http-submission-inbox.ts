import { readServerReceipt } from "@/adapters/http/server-receipt";
import { type SubmissionInbox, SubmissionInboxError } from "@/application/submissions/submission-inbox";
import type { ServerReceipt, TextSubmission } from "@/domain/submissions/submission";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_ENDPOINT = "/api/inbox/submissions";
/**
 * Sized for this route's payload and no other: a JSON document the server caps at 16 KiB.
 * The audio inbox deliberately does NOT share it - 8 MiB of recording needs a different
 * deadline, and HttpAudioAnswerInbox states its own rather than inheriting this one.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export type HttpSubmissionInboxOptions = Readonly<{
  endpoint?: string;
  fetchImplementation?: Fetch;
  timeoutMs?: number;
}>;

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

    const receipt = readServerReceipt(body);
    if (receipt === null) {
      throw new SubmissionInboxError("refused");
    }

    return receipt;
  }
}

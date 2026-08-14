import type {
  AdminInboxClient,
  AdminInboxResult,
} from "@/application/submissions/admin-inbox-client";
import type { InboxPage, InboxQuery } from "@/application/submissions/submission-inbox-reader";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_ENDPOINT = "/api/admin/inbox/submissions";
const DEFAULT_TIMEOUT_MS = 10_000;

export type HttpAdminInboxClientOptions = Readonly<{
  endpoint?: string;
  fetchImplementation?: Fetch;
  timeoutMs?: number;
}>;

/**
 * Same-origin read adapter for the protected inbox.
 *
 * It carries no credential of its own: the admin session is an HttpOnly cookie the
 * browser attaches and this code can never read. There is nothing here for a script to
 * steal or for a bundle to carry.
 */
export class HttpAdminInboxClient implements AdminInboxClient {
  private readonly endpoint: string;
  private readonly fetchImplementation: Fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpAdminInboxClientOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImplementation = options.fetchImplementation ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async list(query: InboxQuery): Promise<AdminInboxResult> {
    const parameters = new URLSearchParams();
    // Only what was actually set. An empty `kind=` is a value the route refuses, and
    // sending one would turn "no filter" into a 400 the user never asked for.
    if (query.status !== undefined) parameters.set("status", query.status);
    if (query.kind !== undefined) parameters.set("kind", query.kind);
    if (query.questionId !== undefined) parameters.set("questionId", query.questionId);
    if (query.limit !== undefined) parameters.set("limit", String(query.limit));

    const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;

    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.endpoint}${suffix}`, {
        method: "GET",
        credentials: "same-origin",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { outcome: "transport" };
    }

    if (response.ok) {
      try {
        // Trusted as the shape the route just sent, not re-validated field by field:
        // this is our own endpoint, and a mismatch is a bug to fix at the source rather
        // than a condition to handle at every call site.
        return { outcome: "granted", page: (await response.json()) as InboxPage };
      } catch {
        return { outcome: "transport" };
      }
    }

    // Mapped from the status, not from the body: the wording is the server's business,
    // and a body this code failed to read must not become a wrong outcome.
    switch (response.status) {
      case 401:
        return { outcome: "denied" };
      case 400:
        return { outcome: "invalid-query" };
      case 429:
        return { outcome: "rate-limited" };
      case 503:
        return { outcome: "unavailable" };
      default:
        return { outcome: "transport" };
    }
  }
}

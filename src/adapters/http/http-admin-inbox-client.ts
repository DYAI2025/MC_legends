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
 * Proves the envelope and nothing deeper.
 *
 * A 200 is not proof the inbox answered: a captive portal, an SSO consent page, a proxy
 * or a stale cached payload can all return valid JSON of some other shape, and passing
 * that on as `granted` would let the view report "3 answers" when there are 300 - which
 * the reader port itself calls worse than showing no number at all.
 *
 * Deliberately shallow. The entries are not checked field by field: those come from our
 * own route, a mismatch there is a bug to fix at the source, and per-entry validation of
 * a child's original text at this boundary would be the wrong place to decide what that
 * text is. So the narrowing to InboxPage is proven for `entries` and `total` and trusted
 * below that - stated here rather than hidden, because it is the one assumption left.
 */
function hasInboxPageEnvelope(value: unknown): value is InboxPage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { entries?: unknown; total?: unknown };
  return Array.isArray(candidate.entries) && typeof candidate.total === "number";
}

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
    // Only what was actually set. The route refuses a blank value on every one of these -
    // an unknown `status=`, an empty `kind=`, a whitespace-only `questionId=` are all 400 -
    // so sending a present-but-empty parameter would turn "no filter" into a refusal the
    // user never asked for.
    if (query.status !== undefined) parameters.set("status", query.status);
    if (query.kind !== undefined) parameters.set("kind", query.kind);
    // Trimmed only here, and only for absence. questionId is the only free-text filter, so
    // it is the one that arrives as "" from an empty input element; an adult who cleared
    // the search box asked for no filter, not for an invalid one. The value that is sent
    // is never rewritten - a questionId with content goes out exactly as given.
    if (query.questionId !== undefined && query.questionId.trim().length > 0) {
      parameters.set("questionId", query.questionId);
    }
    if (query.limit !== undefined) parameters.set("limit", String(query.limit));

    const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;

    // One try around the whole exchange, including the status mapping. The port promises
    // this method never throws, and `fetchImplementation` defaults to resolving the global
    // `fetch` at call time - so a monkey-patched window.fetch that forgets to return its
    // value would otherwise turn that promise into an unhandled rejection on the line that
    // reads `response.ok`.
    try {
      const response = await this.fetchImplementation(`${this.endpoint}${suffix}`, {
        method: "GET",
        credentials: "same-origin",
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        const body: unknown = await response.json();

        if (!hasInboxPageEnvelope(body)) {
          return { outcome: "transport" };
        }

        return { outcome: "granted", page: body };
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
    } catch {
      return { outcome: "transport" };
    }
  }
}

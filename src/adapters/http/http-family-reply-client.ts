import type {
  FamilyReplyClient,
  FamilyReplyResult,
} from "@/application/replies/family-reply-client";
import type { ReplyView } from "@/application/replies/submission-reply-reader";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_ENDPOINT = "/api/family/replies";
const DEFAULT_TIMEOUT_MS = 10_000;

export type HttpFamilyReplyClientOptions = Readonly<{
  endpoint?: string;
  fetchImplementation?: Fetch;
  timeoutMs?: number;
}>;

/**
 * Proves the envelope and nothing deeper.
 *
 * A 200 is not proof this route answered: a captive portal or a proxy returns valid JSON
 * of some other shape, and passing that on as `granted` would replace a child's list of
 * replies with an empty one - which reads, on their screen, as the answers having been
 * taken away.
 */
function hasReplyEnvelope(value: unknown): value is { replies: ReplyView[] } {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as { replies?: unknown }).replies);
}

/**
 * Same-origin read of the household's replies (MCL-74).
 *
 * Carries no credential of its own: the family session is an HttpOnly cookie the browser
 * attaches and this code can never read.
 */
export class HttpFamilyReplyClient implements FamilyReplyClient {
  private readonly endpoint: string;
  private readonly fetchImplementation: Fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpFamilyReplyClientOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImplementation = options.fetchImplementation ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async list(since?: string): Promise<FamilyReplyResult> {
    const suffix = since === undefined ? "" : `?since=${encodeURIComponent(since)}`;

    // One try around the whole exchange, including the status mapping: the port promises
    // this never throws, and the child surface has no handler for a rejection.
    try {
      const response = await this.fetchImplementation(`${this.endpoint}${suffix}`, {
        method: "GET",
        credentials: "same-origin",
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        const body: unknown = await response.json();
        if (!hasReplyEnvelope(body)) return { outcome: "transport" };
        return { outcome: "granted", replies: body.replies };
      }

      switch (response.status) {
        case 401:
          return { outcome: "denied" };
        case 503:
          return { outcome: "unavailable" };
        default:
          // 400 included. A `since` this client built and the route refused is our bug,
          // not something a child can act on, so it reads as "nothing new right now".
          return { outcome: "transport" };
      }
    } catch {
      return { outcome: "transport" };
    }
  }
}

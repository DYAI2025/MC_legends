import type {
  AdminReplyClient,
  AdminReplyListResult,
  AdminReplyPostResult,
  ReplyDraft,
} from "@/application/replies/admin-reply-client";
import type { ComposeReplyRefusal } from "@/application/replies/compose-reply";
import type { SubmissionReply } from "@/domain/replies/reply";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10_000;

export type HttpAdminReplyClientOptions = Readonly<{
  basePath?: string;
  fetchImplementation?: Fetch;
  timeoutMs?: number;
}>;

function endpointFor(basePath: string, submissionId: string): string {
  // Encoded, because a submission id reaches this client from a store rather than from a
  // literal: an id with a slash in it would otherwise address a different route.
  return `${basePath}/${encodeURIComponent(submissionId)}/replies`;
}

function isReply(value: unknown): value is SubmissionReply {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.replyId === "string" && typeof candidate.question === "string";
}

/**
 * The refusal reason, read from the body rather than guessed from the status.
 *
 * This is the one place a body is trusted, and only for a string the server chose from a
 * closed set. It is what lets the form tell an adult "two questions" rather than "das hat
 * nicht geklappt" - and an unrecognised value falls back to the generic reason instead of
 * being rendered raw, so a future server can add one without this build printing it at
 * somebody.
 */
const KNOWN_REFUSALS: ReadonlySet<string> = new Set<ComposeReplyRefusal>([
  "understood-blank",
  "understood-too-long",
  "understood-too-many-sentences",
  "question-blank",
  "question-too-long",
  "question-not-single",
  "unsafe-vocabulary",
  "blocked-name",
]);

function refusalFrom(body: unknown): ComposeReplyRefusal {
  const reason = (body as { reason?: unknown } | null)?.reason;
  // Checked against the known set, not cast into it. A newer server answering with a
  // reason this build has never heard of would otherwise reach the message table as a
  // key it has no entry for, and the form would render an empty status box - a refusal an
  // adult can neither read nor act on.
  return typeof reason === "string" && KNOWN_REFUSALS.has(reason)
    ? (reason as ComposeReplyRefusal)
    : "unsafe-vocabulary";
}

/**
 * Writing and reading replies from the admin browser (MCL-74).
 *
 * Carries no credential of its own: the admin session is an HttpOnly cookie.
 */
export class HttpAdminReplyClient implements AdminReplyClient {
  private readonly basePath: string;
  private readonly fetchImplementation: Fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpAdminReplyClientOptions = {}) {
    this.basePath = options.basePath ?? "/api/admin/inbox/submissions";
    this.fetchImplementation = options.fetchImplementation ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async list(submissionId: string): Promise<AdminReplyListResult> {
    try {
      const response = await this.fetchImplementation(endpointFor(this.basePath, submissionId), {
        method: "GET",
        credentials: "same-origin",
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        const body: unknown = await response.json();
        const replies = (body as { replies?: unknown })?.replies;
        if (!Array.isArray(replies)) return { outcome: "transport" };
        return { outcome: "granted", replies: replies as readonly SubmissionReply[] };
      }

      switch (response.status) {
        case 401:
          return { outcome: "denied" };
        case 404:
          return { outcome: "unknown-submission" };
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

  async post(submissionId: string, draft: ReplyDraft): Promise<AdminReplyPostResult> {
    try {
      const response = await this.fetchImplementation(endpointFor(this.basePath, submissionId), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        const body: unknown = await response.json();
        const reply = (body as { reply?: unknown })?.reply;
        if (!isReply(reply)) return { outcome: "transport" };
        return { outcome: "created", reply };
      }

      switch (response.status) {
        case 400:
          return { outcome: "invalid", reason: refusalFrom(await response.json().catch(() => null)) };
        case 401:
          return { outcome: "denied" };
        case 404:
          return { outcome: "unknown-submission" };
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

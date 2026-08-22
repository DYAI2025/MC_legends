import type {
  QuestionBoardClient,
  QuestionBoardPage,
  QuestionBoardResult,
  QuestionChangeResult,
} from "@/application/questions/question-board-client";
import type { QuestionState } from "@/domain/questions/question-lifecycle";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_ENDPOINT = "/api/admin/questions";
const DEFAULT_TIMEOUT_MS = 10_000;

export type HttpQuestionBoardClientOptions = Readonly<{
  endpoint?: string;
  fetchImplementation?: Fetch;
  timeoutMs?: number;
}>;

/**
 * Proves the envelope and nothing deeper.
 *
 * A 200 is not proof the board answered: a captive portal, an SSO consent page or a
 * proxy can all return valid JSON of some other shape, and passing that on as `granted`
 * would render a board with no questions on it - which reads as "every question is
 * closed", the single most misleading thing this screen could say.
 */
function hasBoardEnvelope(value: unknown): value is QuestionBoardPage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { questions?: unknown; history?: unknown; historyTotal?: unknown };
  return (
    Array.isArray(candidate.questions) &&
    Array.isArray(candidate.history) &&
    typeof candidate.historyTotal === "number"
  );
}

function isState(value: unknown): value is QuestionState {
  return value === "open" || value === "closed";
}

/**
 * Same-origin client for the question board (MCL-35).
 *
 * It carries no credential of its own: the admin session is an HttpOnly cookie the
 * browser attaches and this code can never read. There is nothing here for a script to
 * steal or for a bundle to carry.
 */
export class HttpQuestionBoardClient implements QuestionBoardClient {
  private readonly endpoint: string;
  private readonly fetchImplementation: Fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpQuestionBoardClientOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImplementation = options.fetchImplementation ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async list(): Promise<QuestionBoardResult> {
    // One try around the whole exchange, including the status mapping: the port promises
    // this never throws, and the global fetch is resolved at call time.
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "GET",
        credentials: "same-origin",
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        const body: unknown = await response.json();
        return hasBoardEnvelope(body)
          ? { outcome: "granted", page: body }
          : { outcome: "transport" };
      }

      // Mapped from the status, not from the body: the wording is the server's business,
      // and a body this code failed to read must not become a wrong outcome.
      switch (response.status) {
        case 401:
          return { outcome: "denied" };
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

  async change(
    questionId: string,
    nextState: QuestionState,
    expectedState: QuestionState,
  ): Promise<QuestionChangeResult> {
    const body = JSON.stringify({
      action: nextState === "closed" ? "close" : "reopen",
      expectedState,
    });

    try {
      const response = await this.fetchImplementation(
        `${this.endpoint}/${encodeURIComponent(questionId)}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );

      if (response.ok) {
        const answered: unknown = await response.json();
        const state = (answered as { state?: unknown } | null)?.state;
        // The state the SERVER says the question is in, never the one this client asked
        // for: an answer that does not carry it is an answer this client cannot read, and
        // assuming the request succeeded would put a wrong state on the board.
        return isState(state) ? { outcome: "applied", state } : { outcome: "transport" };
      }

      if (response.status === 409) {
        const answered: unknown = await response.json().catch(() => null);
        const currentState = (answered as { currentState?: unknown } | null)?.currentState;
        // A 409 whose body cannot be read still means "somebody got there first". It is
        // reported as transport rather than as a stale state this client invented,
        // because the board reacts to `stale` by showing a state - and showing a guessed
        // one is the mistake the whole optimistic-concurrency contract exists to avoid.
        return isState(currentState)
          ? { outcome: "stale", currentState }
          : { outcome: "transport" };
      }

      switch (response.status) {
        case 400:
          return { outcome: "invalid-request" };
        case 401:
          return { outcome: "denied" };
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

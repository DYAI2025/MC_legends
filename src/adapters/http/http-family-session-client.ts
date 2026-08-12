import type {
  FamilySessionAttempt,
  FamilySessionClient,
} from "@/application/access/family-session-client";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_ENDPOINT = "/api/family/session";
const DEFAULT_TIMEOUT_MS = 10_000;

export type HttpFamilySessionClientOptions = Readonly<{
  endpoint?: string;
  fetchImplementation?: Fetch;
  timeoutMs?: number;
}>;

/**
 * Same-origin sign-in adapter.
 *
 * It sends the code the family typed and reads back nothing but an outcome: the
 * session lives in an HttpOnly cookie the browser stores and this code can never see.
 * That is the point - there is no value here for a script to steal or for a bundle to
 * carry.
 */
export class HttpFamilySessionClient implements FamilySessionClient {
  private readonly endpoint: string;
  private readonly fetchImplementation: Fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpFamilySessionClientOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImplementation = options.fetchImplementation ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async openSession(accessCode: string): Promise<FamilySessionAttempt> {
    let response: Response;

    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessCode }),
        // Same-origin, but stated rather than inherited: this is the one request in
        // the app whose whole purpose is to have a cookie set.
        credentials: "same-origin",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return "transport";
    }

    if (response.ok) {
      return "granted";
    }

    // Mapped from the status, not from the body: the answer's wording is the server's
    // business, and a body this code failed to read must not become a wrong outcome.
    switch (response.status) {
      case 401:
      case 400:
        return "denied";
      case 429:
        return "rate-limited";
      case 503:
        return "unavailable";
      default:
        return "transport";
    }
  }
}

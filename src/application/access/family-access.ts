/**
 * Server-side access boundary for the private family MVP (MCL-34).
 *
 * The family proves itself once with a shared access code that only the server knows.
 * What travels back to the browser is a session value derived from that code, never
 * the code itself - so a browser, a bundle or a captured cookie cannot yield the
 * secret the server compares against.
 *
 * Three outcomes rather than a boolean, because "no access code is configured" must
 * never be answered the same way as "this caller is not the family": the first is a
 * server fault that has to fail closed *and* be visible as a fault, the second is a
 * normal refusal. Collapsing them is how a misconfigured gate silently turns into an
 * open one.
 */
export type FamilySession = Readonly<{
  /** Opaque value for the session cookie. Carries no secret and no personal data. */
  value: string;
  maxAgeSeconds: number;
}>;

export type SessionGrant =
  | Readonly<{ outcome: "granted"; session: FamilySession }>
  | Readonly<{ outcome: "denied" }>
  | Readonly<{ outcome: "unavailable" }>;

export type SessionCheck =
  | Readonly<{ outcome: "granted" }>
  | Readonly<{ outcome: "denied" }>
  | Readonly<{ outcome: "unavailable" }>;

/**
 * The reusable gate. MCL-34 protects the inbox write path with it; the protected
 * read/admin flow of MCL-50 is meant to verify the same session through the same port
 * rather than inventing a second notion of "is this the family".
 */
export interface FamilyAccessGate {
  /** Exchanges a submitted access code for a session. */
  openSession(submittedAccessCode: string): SessionGrant;

  /** Verifies a session value previously produced by `openSession`. */
  verifySession(sessionValue: string | null): SessionCheck;
}

/**
 * What a protected endpoint learned about one request, before it read any body.
 *
 * - `granted` - carry on.
 * - `unauthorized` - no valid session; the caller may retry after signing in.
 * - `rate-limited` - a valid caller asking too often.
 * - `unavailable` - the gate itself cannot decide, so nothing may pass.
 */
export type ProtectedRequestOutcome =
  | "granted"
  | "unauthorized"
  | "rate-limited"
  | "unavailable";

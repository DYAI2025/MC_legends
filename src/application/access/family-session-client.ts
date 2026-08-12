/**
 * What one sign-in attempt from the browser produced.
 *
 * `transport` is the browser-only case the server-side outcomes cannot express: the
 * request never got an answer at all. It is kept apart from `denied` because telling a
 * family "that code is wrong" when the request never arrived would send them looking
 * for a problem that is not theirs.
 */
export type FamilySessionAttempt =
  | "granted"
  | "denied"
  | "rate-limited"
  | "unavailable"
  | "transport";

/**
 * Delivery boundary for signing in. The UI depends on this port, not on fetch, so the
 * sign-in panel can be tested without a browser and the transport can be replaced.
 */
export interface FamilySessionClient {
  /** Never throws: every failure is one of the outcomes above. */
  openSession(accessCode: string): Promise<FamilySessionAttempt>;
}

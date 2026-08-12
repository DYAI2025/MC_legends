/**
 * Abuse brake for the protected endpoints.
 *
 * A port rather than a direct implementation so the process-local counter this sprint
 * ships can be replaced by a shared one later without the routes changing. The MVP
 * limitation is documented at the implementation and in docs/security.
 */
export interface RateLimiter {
  /**
   * Records one attempt for `key` and answers whether it is still within the
   * allowance. A refused attempt is not counted again, so a caller cannot push its
   * own window further out by hammering the endpoint.
   */
  tryConsume(key: string): boolean;
}

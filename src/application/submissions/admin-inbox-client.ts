import type { InboxPage, InboxQuery } from "@/application/submissions/submission-inbox-reader";

/**
 * What one protected read from the browser produced.
 *
 * `denied` and `unavailable` are kept apart deliberately: "your session is not valid"
 * sends an adult back to the sign-in panel, while "the inbox cannot answer right now"
 * sends them to the deployment. Collapsing them would send them to the wrong place
 * every second time.
 *
 * `transport` is the browser-only outcome the server cannot express: no usable answer
 * arrived. That covers three things, and the copy written from this comment has to fit
 * all of them - the request never got an answer at all; an answer arrived that this
 * client does not map to a meaning of its own (404, 500, 502, 504); or a 200 arrived
 * whose body is not an inbox page, which is what a captive portal or a proxy returns.
 * They share one outcome because they share the only honest thing that can be said to
 * an adult about them: we could not read the inbox, and trying again is worth a shot.
 */
export type AdminInboxResult =
  | { outcome: "granted"; page: InboxPage }
  | { outcome: "denied" }
  | { outcome: "invalid-query" }
  | { outcome: "rate-limited" }
  | { outcome: "unavailable" }
  | { outcome: "transport" };

/**
 * Read boundary for the browser. The admin view depends on this port rather than on
 * fetch, so the list and its filters can be tested without a browser and without a
 * server.
 */
export interface AdminInboxClient {
  /** Never throws: every failure is one of the outcomes above. */
  list(query: InboxQuery): Promise<AdminInboxResult>;
}

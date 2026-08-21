import type { AudioArtifact } from "@/domain/media/audio-artifact";
import type { SubmissionKind } from "@/domain/submissions/submission";

/**
 * Processing state as the durable store records it.
 *
 * Exactly one value today, matching the `submission_inbox_status_known` CHECK in
 * migration 0001. Widening it is a migration plus a change here, in that order - which
 * is the point: a writer must not be able to invent a status the database would refuse,
 * and the admin view must not be able to display one the schema has never heard of.
 */
export type InboxEntryStatus = "RECEIVED";

/**
 * What every inbox entry carries, whatever kind it is.
 *
 * Deliberately a different type from InboxRecord rather than an extension of it.
 * InboxRecord is the *write* shape: what the POST route mints and hands to the store.
 * This is the *read* shape, and it carries `status`, which no writer supplies - the
 * database defaults it. Folding both into one type would mean either the route
 * pretending to know a status it never sets, or this view treating a required column as
 * optional.
 */
type InboxEntryBase = Readonly<{
  submissionId: string;
  questionId: string;
  createdAt: string;
  receivedAt: string;
  receiptId: string;
  status: InboxEntryStatus;
}>;

/**
 * One typed answer as the protected read side sees it.
 *
 * `originalText` is the unchanged original artifact. Derived artifacts - transcripts,
 * normalisations, anything an LLM produces later - are NOT part of this type and must
 * not be folded into this field. AGENTS.md requires original and derived to stay
 * separate representations, and a single field carrying either would erase exactly that
 * distinction at the boundary where somebody is about to read a child's words and
 * decide what they are.
 *
 * That rule is why MCL-54's transcript will not arrive as an `originalText` on
 * AudioInboxEntry either: a spoken answer's original is the recording.
 */
export type TextInboxEntry = InboxEntryBase &
  Readonly<{
    kind: "text";
    originalText: string;
  }>;

/**
 * One audio answer as the protected read side sees it (MCL-49).
 *
 * Carries the metadata and NOT a URL. The recording is fetched through a separate
 * authorized route that looks the object key up from the database by submissionId, so the
 * admin client never holds a path and there is no value here that could become a public
 * media link if it leaked into a page.
 */
export type AudioInboxEntry = InboxEntryBase &
  Readonly<{
    kind: "audio";
    audio: AudioArtifact;
  }>;

export type InboxEntry = TextInboxEntry | AudioInboxEntry;

/**
 * Server-side filters. An absent field means no constraint on that dimension, which is
 * why every one of them is optional rather than nullable: "not filtering by status" and
 * "filtering by a status that is null" are different questions, and only the first one
 * exists here.
 */
export type InboxQuery = Readonly<{
  status?: InboxEntryStatus;
  kind?: SubmissionKind;
  questionId?: string;
  limit?: number;
}>;

export type InboxPage = Readonly<{
  entries: readonly InboxEntry[];
  /**
   * How many entries match the filter, independent of `limit`.
   *
   * Separate from entries.length so a capped page cannot make the view understate how
   * much exists - "3 answers" when there are 300 is worse than no number at all.
   */
  total: number;
}>;

/**
 * The largest page any caller can ask for.
 *
 * Enforced by the adapter, not by the route: a limit is a memory question, and the
 * answer must not depend on which caller asked or on a route remembering to clamp it.
 */
export const MAX_INBOX_PAGE_SIZE = 200;

/**
 * Read boundary for the protected inbox (MCL-50).
 *
 * A separate port from SubmissionInboxStore rather than another method on it. The write
 * path is reached by children through the family gate; the read path only by the admin
 * gate. Two ports make it structurally impossible for a route to acquire read capability
 * by asking for the writer, and the composition root stays the only place that can hand
 * out either. One interface with both methods would make that a matter of discipline
 * instead - and discipline is not what should stand between a child's answer and
 * whoever can reach the submit endpoint.
 *
 * Newest-first ordering is part of the contract, not an adapter's preference: an inbox
 * that reorders itself between adapters is an inbox whose "latest" cannot be trusted.
 */
export interface SubmissionInboxReader {
  list(query: InboxQuery): Promise<InboxPage>;

  /**
   * One entry by its submission id, or null when the inbox does not hold it.
   *
   * On this port rather than a port of its own (MCL-49). Playing a recording back is a
   * read of the protected inbox by the admin identity - the same capability, the same
   * gate, the same adapter pair - and a third port would be a third thing the composition
   * root can hand to the wrong route. The playback route needs the object key and the
   * stored mime type, and both of them are already what this port returns.
   *
   * `null` rather than a throw for the absent case. "No such submission" is a normal
   * answer to an id typed into a URL, and the route turns it into a 404; a throw would
   * make an ordinary miss indistinguishable from a database that is down.
   *
   * Never a lookup by object key. The key is a filesystem path fragment, and a read port
   * that accepted one would be a way to ask this application for a file rather than for a
   * submission.
   */
  find(submissionId: string): Promise<InboxEntry | null>;
}

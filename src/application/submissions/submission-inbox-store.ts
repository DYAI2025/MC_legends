import type { AudioArtifact } from "@/domain/media/audio-artifact";

/**
 * The fields every stored submission has, whatever kind it is.
 *
 * `kind` is the discriminant, mirroring Submission.kind. Without it the text lines already
 * on disk would be indistinguishable from the audio ones written after MCL-49, which is
 * exactly the ambiguity the field was reserved to prevent.
 */
type InboxRecordBase = Readonly<{
  receiptId: string;
  receivedAt: string;
  submissionId: string;
  questionId: string;
  createdAt: string;
}>;

export type TextInboxRecord = InboxRecordBase &
  Readonly<{
    kind: "text";
    /** Unchanged original text as submitted. */
    originalText: string;
  }>;

/**
 * One stored audio answer, as metadata only (MCL-49).
 *
 * The bytes are not here and must never be: they live in the private blob store, and this
 * record is what goes into a database row. `audio.objectKey` is the reference between the
 * two, and it is derived from a server-computed hash rather than from anything a client
 * sent - which is what makes it safe to put in a path.
 *
 * A union member rather than optional fields on one flat record. Optional fields would make
 * "an audio record whose objectKey is missing" a representable value, and the shape of that
 * bug is a database row promising a recording that was never written.
 */
export type AudioInboxRecord = InboxRecordBase &
  Readonly<{
    kind: "audio";
    audio: AudioArtifact;
  }>;

export type InboxRecord = TextInboxRecord | AudioInboxRecord;

/**
 * What one delivery attempt did to the store.
 *
 * `stored: false` is not a failure: it is the answer to a retry of a submissionId the
 * store already holds, and it carries the record that was kept so the caller can reply
 * with the receipt that submission already has. Without the existing record here, a
 * retry would either mint a second contradictory receipt or have to be refused - and a
 * refusal would leave a child's answer looking undelivered when it arrived long ago.
 */
export type AppendOutcome =
  | Readonly<{ stored: true }>
  | Readonly<{ stored: false; existing: InboxRecord }>;

/**
 * The store refused the record itself. Retrying the same payload can never succeed.
 *
 * On the port and not in one adapter, because the caller has to tell "this submission
 * is not storable" from "the store is unavailable" without knowing which adapter it was
 * handed: the first is a refusal that ends there, the second is worth retrying and is
 * what an outage looks like. Every other failure stays untyped and means the second -
 * classifying too widely would tell a child their answer is invalid every time the
 * database blinks.
 */
export class SubmissionPayloadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SubmissionPayloadError";
  }
}

/**
 * Server-side persistence boundary for the family project inbox.
 *
 * `appendIfAbsent` rather than `append` so idempotency is a property of the boundary
 * and not of one adapter's implementation: the file adapter enforces it by scanning
 * what it wrote, and the PostgreSQL adapter of MCL-48 is expected to enforce it with a
 * unique constraint on submissionId. Both satisfy the same contract, so the route does
 * not change when the store does.
 */
export interface SubmissionInboxStore {
  appendIfAbsent(record: InboxRecord): Promise<AppendOutcome>;
}

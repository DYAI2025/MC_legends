import { createHash } from "node:crypto";
import { declaresAcceptableSize, readBoundedBytes } from "@/adapters/http/bounded-json-body";
import { guardFamilyRequest } from "@/adapters/http/family-request-guard";
import {
  describeAudioArtifact,
  isAudioMimeType,
  sniffAudioMimeType,
  type AudioMimeType,
} from "@/domain/media/audio-artifact";
import {
  SubmissionPayloadError,
  type AudioInboxRecord,
  type InboxRecord,
} from "@/application/submissions/submission-inbox-store";
import {
  audioMaxBytes,
  createAudioBlobStore,
  createAudioInboxRateLimiter,
  createFamilyAccessGate,
  createReceiptId,
  createSubmissionInboxStore,
} from "@/composition/server";

/**
 * Where a spoken answer arrives (MCL-49).
 *
 * A sibling of the text route rather than a widening of it. The two share the access
 * decision and the streaming byte cap - both of which live in adapters, where a second
 * caller can have them unchanged - and nothing else: one reads a JSON document under a
 * 16 KiB cap and stores a string in a database, the other reads up to 8 MiB of opaque
 * bytes and stores them in a private directory with only a reference in the database.
 * Folding the two into one handler would mean a single function whose body reading,
 * validation and persistence all branch on content type, and the branch that matters -
 * "did the bytes land before the row did" - would be the easiest one to lose.
 *
 * Four decisions this module is built on, recorded because none of them is visible from
 * the code alone:
 *
 * D1 - PERSISTENCE ORDER. validate -> sniff -> hash -> describe -> blob -> row -> receipt.
 * The receipt is minted into the record before the append, because the row has to carry
 * it, but it is never RETURNED unless the append resolved. A row referencing a recording
 * that was never written is unrecoverable and invisible: a child told their answer
 * arrived, pointing at nothing. An orphan blob is neither - it is inert, and a retry
 * reuses it because the key is content-addressed.
 *
 * D2 - A FAILED ROW DOES NOT DELETE THE BLOB. Migration 0002 records why: the object key
 * is derived from the SHA-256 of the bytes and is deliberately not unique, so two
 * submissions may legitimately share one key. Deleting on rollback could delete another
 * child's recording.
 *
 * D4 - IDENTIFIERS RIDE IN HEADERS, THE BODY IS RAW BYTES. Not multipart. A custom
 * request header makes this a non-simple cross-origin request, so a form post from
 * another site cannot reach this route at all - the text route gets the same property
 * from its required application/json. And multipart would introduce a filename field,
 * which is the one input D5 forbids.
 *
 * D5 - NO CLIENT FILENAME IS READ, STORED, LOGGED OR DERIVED FROM. The extension comes
 * from the domain's total MIME table. There is no code path here that accepts one, which
 * is why there is no sanitisation step to forget.
 */

/** The identifiers a client supplies; the receipt fields are added by this server. */
type SubmittedIdentifiers = Pick<AudioInboxRecord, "submissionId" | "questionId" | "createdAt">;

/**
 * The header each identifier arrives in. A total table, so a new identifier is a compile
 * error here until its header is chosen rather than a field that silently arrives absent.
 */
const IDENTIFIER_HEADERS = {
  submissionId: "x-avaloria-submission-id",
  questionId: "x-avaloria-question-id",
  createdAt: "x-avaloria-created-at",
} as const satisfies Record<keyof SubmittedIdentifiers, string>;

/** Mirrors the text route's caps and the schema's, so the two writers cannot disagree. */
const MAX_LENGTHS = {
  submissionId: 200,
  questionId: 200,
  createdAt: 40,
} as const satisfies Record<keyof SubmittedIdentifiers, number>;

type AudioInboxError =
  | "invalid-payload"
  | "unauthorized"
  | "too-many-requests"
  | "inbox-unavailable";

/** Machine-readable codes only - never an exception message, path, object key or stack. */
function refuse(status: 400 | 401 | 429 | 503, error: AudioInboxError): Response {
  return Response.json({ acknowledged: false, error }, { status });
}

/**
 * The years both sides spell the same way, mirroring the text route.
 *
 * timestamptz has no year zero, and Date.toISOString() switches to the expanded six-digit
 * form outside 1..9999, which timestamptz reads as a time zone displacement and refuses.
 * An uninitialised field produces the first of those, and without this guard the child
 * retries an unchanged payload against a permanent 503 forever.
 */
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

function isStorableInstant(value: string): boolean {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return false;
  }

  const year = new Date(parsed).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

/**
 * One identifier header, or null.
 *
 * The same two shapes the text route refuses are refused here: a NUL, which PostgreSQL
 * cannot hold at all (22021), and a lone surrogate, which node-postgres silently rewrites
 * to U+FFFD - storing an identifier that is not the identifier that was sent. Neither is
 * reachable through a well-behaved HTTP client, and both are checked anyway: this route
 * and the text route must agree on what a valid submissionId is, or the same id means two
 * different things depending on which door it came through.
 */
function readIdentifier(request: Request, field: keyof SubmittedIdentifiers): string | null {
  const value = request.headers.get(IDENTIFIER_HEADERS[field]);

  if (value === null || value.trim().length === 0 || value.length > MAX_LENGTHS[field]) {
    return null;
  }

  if (value.includes("\u0000") || !value.isWellFormed()) {
    return null;
  }

  return value;
}

function readIdentifiers(request: Request): SubmittedIdentifiers | null {
  const submissionId = readIdentifier(request, "submissionId");
  const questionId = readIdentifier(request, "questionId");
  const createdAt = readIdentifier(request, "createdAt");

  if (submissionId === null || questionId === null || createdAt === null) {
    return null;
  }

  if (!isStorableInstant(createdAt)) {
    return null;
  }

  return { submissionId, questionId, createdAt };
}

/**
 * The type the client says it is sending, or null when it is not one this project stores.
 *
 * The parameter is dropped, the type is not: MediaRecorder sends
 * `audio/webm;codecs=opus`, and refusing that would refuse every Chromium recording. An
 * exact match against the domain's table, never a `startsWith("audio/")` - a prefix test
 * accepts `audio/x-anything`, which is precisely the category nobody has decided to store.
 */
function declaredMimeType(request: Request): AudioMimeType | null {
  const header = request.headers.get("content-type");
  if (header === null) {
    return null;
  }

  const declared = header.split(";")[0].trim().toLowerCase();
  return isAudioMimeType(declared) ? declared : null;
}

/** The one shape a positive answer has, whether this call stored the record or found it. */
function acknowledge(record: InboxRecord, status: 200 | 201): Response {
  return Response.json(
    { acknowledged: true, receiptId: record.receiptId, receivedAt: record.receivedAt },
    { status },
  );
}

export async function POST(request: Request): Promise<Response> {
  // First, and from headers alone. An unauthorised caller must not be able to make this
  // server read, buffer or hash a single byte - and on this route that byte count is up
  // to 8 MiB, which is why the audio bucket is its own and tighter than the text one.
  const access = guardFamilyRequest(
    request,
    createFamilyAccessGate(),
    createAudioInboxRateLimiter(),
  );

  if (access === "unavailable") {
    console.error("family access gate unavailable: no access code configured");
    return refuse(503, "inbox-unavailable");
  }

  if (access === "unauthorized") {
    return refuse(401, "unauthorized");
  }

  if (access === "rate-limited") {
    return refuse(429, "too-many-requests");
  }

  const declared = declaredMimeType(request);
  if (declared === null) {
    return refuse(400, "invalid-payload");
  }

  const maxBytes = audioMaxBytes();
  if (!declaresAcceptableSize(request, maxBytes)) {
    // Refused from the declared length, before the body is touched: a request this route
    // is going to reject must not cost the instance its memory first.
    return refuse(400, "invalid-payload");
  }

  const identifiers = readIdentifiers(request);
  if (identifiers === null) {
    return refuse(400, "invalid-payload");
  }

  const bytes = await readBoundedBytes(request, maxBytes);
  if (bytes === null || bytes.byteLength === 0) {
    // null covers both an absent body and one that crossed the cap mid-stream; the caller
    // is told no without learning which guard said it. An empty body is not a recording.
    return refuse(400, "invalid-payload");
  }

  // The declared type is client input. This is what the bytes actually are - and they
  // have to agree. Not "the sniffer wins": a mismatch means the client and its own
  // payload disagree, which is a refusal rather than something to silently resolve.
  if (sniffAudioMimeType(bytes) !== declared) {
    return refuse(400, "invalid-payload");
  }

  // Computed here and nowhere else. The digest is the identity of the bytes, the object
  // key is derived from it, and both are this server's, not the client's.
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const audio = describeAudioArtifact({
    sha256,
    mimeType: declared,
    sizeBytes: bytes.byteLength,
  });

  try {
    // Stage one. Resolves only once the bytes are durable - the adapter writes to a
    // temporary name in the same directory, fsyncs, renames and fsyncs the directory - so
    // everything after this line runs with the recording already on the device.
    await createAudioBlobStore().store(audio.objectKey, bytes);
  } catch (cause) {
    // Server-side only. The response stays a bare code: the cause names a filesystem path
    // and this answer goes to a child's browser.
    console.error("audio blob store failed", cause);
    // Nothing has touched the database, which is the whole point of doing this first.
    return refuse(503, "inbox-unavailable");
  }

  // Receipt minted into the record, not returned yet. The server's authority over it is
  // structural rather than a matter of the validator happening to drop a client-supplied
  // one - and `kind` is set here rather than read from anything a client sent, because
  // this route validates a recording and nothing else.
  const record: AudioInboxRecord = {
    ...identifiers,
    kind: "audio",
    audio,
    receiptId: createReceiptId(),
    receivedAt: new Date().toISOString(),
  };

  let outcome: Awaited<
    ReturnType<ReturnType<typeof createSubmissionInboxStore>["appendIfAbsent"]>
  >;

  try {
    // Stage two. Until this resolves there is no receipt, whatever happened above.
    outcome = await createSubmissionInboxStore().appendIfAbsent(record);
  } catch (cause) {
    if (cause instanceof SubmissionPayloadError) {
      // The store refused the values, not the request that carried them. 503 here would
      // report a permanent refusal as an outage and the child would retry an unchanged
      // payload against it forever. Logged as an error all the same: a payload the guards
      // above let through and the store would not hold is a hole in those guards.
      console.error("audio inbox append refused the payload", cause);
      return refuse(400, "invalid-payload");
    }

    console.error("audio inbox append failed", cause);

    // The blob stays where it is (D2). The object key is content-addressed and migration
    // 0002 deliberately does not make it unique, so it may already be another submission's
    // recording - deleting it here would delete a different child's answer. An
    // unreferenced blob is inert, and the retry that follows reuses it for free.
    return refuse(503, "inbox-unavailable");
  }

  if (!outcome.stored) {
    // A retry of something already held. Answered with the receipt that submission
    // already has, so one submissionId can never carry two different receipts - and 200
    // rather than 201, because this call created nothing.
    return acknowledge(outcome.existing, 200);
  }

  // 201: both stages are durable before this answer is sent. No Location header - the
  // recording is readable only through the admin-gated playback route, and a URL here
  // would be the public media reference MCL-49 exists to not have.
  return acknowledge(record, 201);
}

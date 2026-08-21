import {
  isAudioMimeType,
  isSha256Hex,
  type AudioArtifact,
} from "@/domain/media/audio-artifact";
import type { InboxRecord } from "@/application/submissions/submission-inbox-store";

/**
 * Runtime shape check for one line of the JSONL inbox.
 *
 * `JSON.parse` returns `unknown`, and the adapter used to push the result straight into
 * an `InboxRecord[]` with a cast. A cast is a claim about data this process did not
 * produce: a syntactically valid JSON object of any shape became a record, so a damaged
 * line carrying a retried submissionId could answer a retry with `stored: false` and a
 * receipt that is not a receipt - a positive acknowledgement built out of corruption.
 *
 * So this returns a record it has actually checked, field by field, or the reason keys
 * that disqualified the value. The reasons are field names on purpose: they are safe to
 * log, and the line's content - which can hold a child's own words - is not.
 *
 * It reads both kinds since MCL-49, and it has to. Measured on e3db9c3, when it did not:
 * the upload route wrote an audio line to the JSONL file and this function refused it for
 * its `kind`, so the adapter skipped it on every read. Silently - the duplicate check
 * could not see the line, so a retry appended a second line with a second receipt for one
 * submission, and the admin list showed neither. The file adapter is MCL-48's rollback
 * path, so the moment that costs somebody data is the moment they are already dealing
 * with a problem.
 *
 * Deliberately NOT shared with `scripts/import-inbox-jsonl.mjs`. That script is plain
 * `.mjs` run by `node` with no build step, so it cannot import this module at all, and
 * its policy is the opposite of this one: an importer must refuse a line it cannot read,
 * a reader must skip it. Two callers with opposing policies are not duplication.
 */
export type InboxRecordCheck =
  | Readonly<{ ok: true; record: InboxRecord }>
  | Readonly<{ ok: false; defects: readonly string[] }>;

/** Present, a string, and not empty. */
const IDENTIFIERS = ["receiptId", "submissionId", "questionId"] as const;

/** Present, a string, and an instant the durable store could hold. */
const TIMESTAMPS = ["createdAt", "receivedAt"] as const;

/**
 * The years PostgreSQL and JavaScript spell the same way, mirroring the POST route.
 *
 * timestamptz has no year zero, and Date.toISOString() switches to the expanded
 * ±YYYYYY form outside 1..9999, which timestamptz reads as a time zone displacement.
 * A line holding one of those is a line the rollback path could never hand to the
 * durable store, so it is not a record this reader will vouch for either.
 */
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

/**
 * The two ways a string can survive every other check and still not arrive intact.
 *
 * PostgreSQL's UTF8 encoding cannot hold a NUL and refuses it outright (22021). A lone
 * surrogate is worse: node-postgres encodes parameters with Buffer.from(str, "utf8"),
 * which silently rewrites it to U+FFFD - the stored text would not be the text that was
 * submitted, which is precisely what "never trimmed, never normalised" forbids. Both are
 * refused at the route, so no line this adapter wrote can carry them; a line that does
 * came from somewhere else and must not be treated as a record.
 */
function isRepresentable(value: string): boolean {
  return !value.includes("\u0000") && value.isWellFormed();
}

function isStorableInstant(value: string): boolean {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return false;
  }

  const year = new Date(parsed).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

function isReadableIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isRepresentable(value);
}

/**
 * Checks the value and, when it passes, builds the record from named fields rather than
 * casting the parsed object. The construction is what makes the return type honest: a
 * field added to InboxRecord fails to compile here until this function is taught to read
 * it, instead of arriving as `undefined` behind a cast.
 *
 * `originalText` is checked for type and representability and for nothing else. It is a
 * child's own words: an empty string is legitimate, surrounding whitespace is data, and
 * this function neither trims, normalises nor repairs it.
 *
 * Length caps are deliberately not mirrored from the schema. Exceeding one is a loud
 * refusal at write or import time, never a silent mutation, and mirroring the numbers
 * here would make the reader reject lines it wrote itself the day the caps change.
 */
export function readInboxRecord(value: unknown): InboxRecordCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, defects: ["not-an-object"] };
  }

  const source = value as Record<string, unknown>;
  const defects: string[] = [];

  // Checked, not narrowed by assertion. The union has two members since MCL-49, and a
  // line has to say which one it is: without the discriminant the text lines written
  // before MCL-49 and the audio lines written after would be indistinguishable, which is
  // exactly the ambiguity the field was reserved to prevent.
  const kind = source.kind;
  if (kind !== "text" && kind !== "audio") {
    defects.push("kind");
  }

  for (const field of IDENTIFIERS) {
    if (!isReadableIdentifier(source[field])) {
      defects.push(field);
    }
  }

  for (const field of TIMESTAMPS) {
    const timestamp = source[field];
    if (typeof timestamp !== "string" || !isStorableInstant(timestamp)) {
      defects.push(field);
    }
  }

  if (kind === "text" && (typeof source.originalText !== "string" || !isRepresentable(source.originalText))) {
    defects.push("originalText");
  }

  const audio = kind === "audio" ? readAudioArtifact(source.audio) : null;
  if (kind === "audio" && audio === null) {
    defects.push("audio");
  }

  if (defects.length > 0) {
    return { ok: false, defects };
  }

  const base = {
    receiptId: source.receiptId as string,
    receivedAt: source.receivedAt as string,
    submissionId: source.submissionId as string,
    questionId: source.questionId as string,
    createdAt: source.createdAt as string,
  };

  // Built member by member rather than spread out of `source`, so a field added to
  // InboxRecord fails to compile here until this function is taught to read it - instead
  // of arriving as `undefined` behind a cast. The `if` is what narrows `kind`; a switch
  // over a `string` would not.
  if (kind === "text") {
    return {
      ok: true,
      record: { ...base, kind: "text", originalText: source.originalText as string },
    };
  }

  return { ok: true, record: { ...base, kind: "audio", audio: audio as AudioArtifact } };
}

/**
 * The five media fields, checked together, or null.
 *
 * Constructed rather than cast, for the same reason the record above is: a field added to
 * AudioArtifact is a compile error here rather than an `undefined` travelling on to a
 * route that will try to open it.
 *
 * What is checked is the SHAPE - the mime type is on the allowlist, the digest looks like
 * a digest, the size is a byte count that can be represented exactly. What is deliberately
 * NOT checked is that the object key is the one the domain would derive from that digest
 * and that mime type. Mirroring the derivation here would make this reader reject lines it
 * wrote itself the day the extension table changes, which is the same argument that keeps
 * the schema's length caps out of this module. The last guard on the path is the blob
 * store's own key pattern, which refuses anything it did not mint - by construction, and
 * at the point where a string is about to become a filesystem path.
 */
function readAudioArtifact(value: unknown): AudioArtifact | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;

  const objectKey = source.objectKey;
  const mimeType = source.mimeType;
  const extension = source.extension;
  const sizeBytes = source.sizeBytes;
  const sha256 = source.sha256;

  if (!isReadableIdentifier(objectKey) || !isReadableIdentifier(extension)) {
    return null;
  }

  if (typeof mimeType !== "string" || !isAudioMimeType(mimeType)) {
    return null;
  }

  // A positive safe integer. `Number.isSafeInteger` is what keeps a size beyond 2^53 -
  // which a bigint column can hold and a JS number cannot represent exactly - from
  // becoming a rounded byte count that silently disagrees with the file on disk.
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return null;
  }

  if (typeof sha256 !== "string" || !isSha256Hex(sha256)) {
    return null;
  }

  return { objectKey, mimeType, extension, sizeBytes, sha256 };
}

import { readBoundedJson } from "@/adapters/http/bounded-json-body";
import { guardFamilyRequest } from "@/adapters/http/family-request-guard";
import {
  SubmissionPayloadError,
  type InboxRecord,
  type TextInboxRecord,
} from "@/application/submissions/submission-inbox-store";
import {
  createFamilyAccessGate,
  createProtectedRouteRateLimiter,
  createReceiptId,
  createSubmissionInboxStore,
} from "@/composition/server";

/**
 * Validation and receipt minting live in this route on purpose: with a single
 * endpoint, a use case in src/application would be indirection without a second
 * caller. The access decision and the body guards are the exception - they are shared
 * with the sign-in route and with the protected read of MCL-50, so they live in
 * adapters where a second caller can have them unchanged.
 */

/** The fields a client submits; the receipt fields are added by this server. */
type SubmittedFields = Pick<
  TextInboxRecord,
  "submissionId" | "questionId" | "createdAt" | "originalText"
>;

/**
 * Total table: adding a submitted field fails to compile until its limit is set here.
 */
const MAX_LENGTHS = {
  submissionId: 200,
  questionId: 200,
  createdAt: 40,
  originalText: 4000,
} satisfies Record<keyof SubmittedFields, number>;

/**
 * Generous headroom over the field limits above, and small enough that a request this
 * route *rejects* cannot cost the instance its memory. The field limits alone are no
 * protection: they only apply once the whole body has been buffered and parsed.
 */
const MAX_BODY_BYTES = 16 * 1024;

type InboxError =
  | "invalid-payload"
  | "unauthorized"
  | "too-many-requests"
  | "inbox-unavailable";

/** Machine-readable codes only - never an exception message, path or stack trace. */
function refuse(status: 400 | 401 | 429 | 503, error: InboxError): Response {
  return Response.json({ acknowledged: false, error }, { status });
}

function readField(source: Record<string, unknown>, field: keyof SubmittedFields): string | null {
  const value = source[field];

  if (typeof value !== "string") {
    return null;
  }

  if (value.trim().length === 0 || value.length > MAX_LENGTHS[field]) {
    return null;
  }

  // Two shapes that pass every check above and that the store cannot hold.
  //
  // A NUL arrives as a JSON escape, so it survives the strict UTF-8 decode in
  // bounded-json-body; it is not whitespace, so it survives trim(); and it is one
  // character, so it is under every cap. PostgreSQL then refuses it outright (22021) -
  // a validation problem reported as an outage, repeating forever because the payload
  // never changes.
  //
  // A lone surrogate is worse: node-postgres encodes parameters with
  // Buffer.from(str, "utf8"), which silently rewrites it to U+FFFD. The text stored
  // would not be the text the child sent, which the schema, the body guard and MCL-48
  // all say it must be.
  //
  // Refused, never sanitised. Stripping the NUL or repairing the surrogate would be
  // this server quietly editing a child's words - exactly what "never trimmed, never
  // normalised" forbids. isWellFormed() is ES2024 and present on Node 20+.
  if (value.includes("\u0000") || !value.isWellFormed()) {
    return null;
  }

  return value;
}

/**
 * The years both sides spell the same way.
 *
 * PostgreSQL has no year zero, and Date.toISOString() - which the adapter binds -
 * switches to the expanded ±YYYYYY form outside 1..9999, which timestamptz reads as a
 * time zone displacement and refuses. So "0000-01-01", "-000001-01-01" and
 * "+275760-09-13" are all values Date.parse reads happily and the database will not
 * store, and none of them is exotic: an uninitialised field or a buggy date picker
 * produces the first.
 */
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

/** True only for an instant the store can hold, not merely one Date.parse understands. */
function isStorableInstant(value: string): boolean {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return false;
  }

  const year = new Date(parsed).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

function readSubmittedFields(body: unknown): SubmittedFields | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const source = body as Record<string, unknown>;
  const submissionId = readField(source, "submissionId");
  const questionId = readField(source, "questionId");
  const createdAt = readField(source, "createdAt");
  const originalText = readField(source, "originalText");

  if (
    submissionId === null ||
    questionId === null ||
    createdAt === null ||
    originalText === null
  ) {
    return null;
  }

  // A createdAt that is not a real instant would sort as garbage in the admin view
  // MCL-50 adds later - and one outside the storable year range would not reach the
  // admin view at all, because the store refuses it.
  if (!isStorableInstant(createdAt)) {
    return null;
  }

  return { submissionId, questionId, createdAt, originalText };
}

/** The one shape a positive answer has, whether this call stored the record or found it. */
function acknowledge(record: InboxRecord, status: 200 | 201): Response {
  return Response.json(
    { acknowledged: true, receiptId: record.receiptId, receivedAt: record.receivedAt },
    { status },
  );
}

export async function POST(request: Request): Promise<Response> {
  // First, and from headers alone. An unauthorised caller must not be able to make
  // this server read, decode or parse a single byte of its body - which is also why
  // the guard takes the request rather than anything derived from it.
  const access = guardFamilyRequest(
    request,
    createFamilyAccessGate(),
    createProtectedRouteRateLimiter(),
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

  const body = await readBoundedJson(request, MAX_BODY_BYTES);
  const fields = readSubmittedFields(body);
  if (fields === null) {
    return refuse(400, "invalid-payload");
  }

  // Receipt last: the server's authority over it is structural, not a matter of the
  // validator happening to drop a client-supplied one.
  // kind is set here, not read from the payload: this route validates a text answer
  // and nothing else, so a client claiming otherwise must not be believed.
  const record: TextInboxRecord = {
    ...fields,
    kind: "text",
    receiptId: createReceiptId(),
    receivedAt: new Date().toISOString(),
  };

  let outcome: Awaited<ReturnType<ReturnType<typeof createSubmissionInboxStore>["appendIfAbsent"]>>;

  try {
    outcome = await createSubmissionInboxStore().appendIfAbsent(record);
  } catch (cause) {
    if (cause instanceof SubmissionPayloadError) {
      // The store refused the values, not the request that carried them. 503 here would
      // report a permanent refusal as an outage, and the child would retry an unchanged
      // payload against it forever - so it gets the same 400 this route's own guards
      // answer with. Logged all the same, and as an error: a payload the guards above
      // let through and the store would not hold is a hole in those guards, and the
      // only place it can be seen is here.
      console.error("inbox append refused the payload", cause);
      return refuse(400, "invalid-payload");
    }

    // Server-side only. The response stays a bare code so nothing internal reaches a
    // child's browser, but an outage has to leave a trace somewhere.
    console.error("inbox append failed", cause);
    return refuse(503, "inbox-unavailable");
  }

  if (!outcome.stored) {
    // A retry of something already held. Answered with the receipt that submission
    // already has, so the same submissionId can never carry two different receipts -
    // and 200 rather than 201, because this call created nothing.
    return acknowledge(outcome.existing, 200);
  }

  // 201: the record is durably appended before this answer is sent, so nothing is
  // merely accepted for later processing. No Location header on purpose - there is no
  // readable resource until the protected read side of MCL-50 lands.
  return acknowledge(record, 201);
}

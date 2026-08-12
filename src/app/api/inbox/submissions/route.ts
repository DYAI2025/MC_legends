import { readBoundedJson } from "@/adapters/http/bounded-json-body";
import { guardFamilyRequest } from "@/adapters/http/family-request-guard";
import type { InboxRecord } from "@/application/submissions/submission-inbox-store";
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
  InboxRecord,
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

  return value;
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
  // MCL-50 adds later.
  if (Number.isNaN(Date.parse(createdAt))) {
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
  const record: InboxRecord = {
    ...fields,
    kind: "text",
    receiptId: createReceiptId(),
    receivedAt: new Date().toISOString(),
  };

  let outcome: Awaited<ReturnType<ReturnType<typeof createSubmissionInboxStore>["appendIfAbsent"]>>;

  try {
    outcome = await createSubmissionInboxStore().appendIfAbsent(record);
  } catch (cause) {
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

import type { InboxRecord } from "@/application/submissions/submission-inbox-store";
import { createReceiptId, createSubmissionInboxStore } from "@/composition/server";

/**
 * Validation and receipt minting live in this route on purpose: with a single
 * endpoint, a use case in src/application would be indirection without a second
 * caller. When the authenticated inbox work adds auth, de-duplication and an admin
 * read to this file - and `append` likely becomes `appendIfAbsent` - that is the
 * moment to lift this logic into src/application behind a receiveSubmission use case.
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

/** Machine-readable codes only - never an exception message, path or stack trace. */
function refuse(status: 400 | 503, error: "invalid-payload" | "inbox-unavailable"): Response {
  return Response.json({ acknowledged: false, error }, { status });
}

/**
 * Required, so that once the authenticated family gate lands, a cross-origin
 * `text/plain` POST cannot reach this route as a simple request without a preflight.
 */
function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType !== null && contentType.split(";")[0].trim().toLowerCase() === "application/json";
}

/** False only when the client itself declares a body too large to accept. */
function declaresAcceptableSize(request: Request): boolean {
  const declared = request.headers.get("content-length");
  if (declared === null) {
    // No declared length means chunked framing. It is not refused here - an
    // intermediary may legitimately re-frame a request - but nothing is trusted
    // either: readBoundedBody caps what is actually read.
    return true;
  }

  const bytes = Number(declared);
  return Number.isInteger(bytes) && bytes >= 0 && bytes <= MAX_BODY_BYTES;
}

/**
 * Reads the body with a hard byte cap instead of buffering whatever arrives. Returns
 * null as soon as the cap is passed, so an oversized body is abandoned mid-stream and
 * never fully held in memory or handed to the parser.
 */
async function readBoundedBody(request: Request): Promise<string | null> {
  const stream = request.body;
  if (stream === null) {
    return null;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Strict decoding: malformed UTF-8 must be refused, not silently replaced,
    // because the submitted text has to survive byte for byte.
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    return null;
  }
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
  // the authenticated inbox work adds later.
  if (Number.isNaN(Date.parse(createdAt))) {
    return null;
  }

  return { submissionId, questionId, createdAt, originalText };
}

export async function POST(request: Request): Promise<Response> {
  if (!hasJsonContentType(request) || !declaresAcceptableSize(request)) {
    return refuse(400, "invalid-payload");
  }

  const text = await readBoundedBody(request);
  if (text === null) {
    return refuse(400, "invalid-payload");
  }

  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, "invalid-payload");
  }

  const fields = readSubmittedFields(body);
  if (fields === null) {
    return refuse(400, "invalid-payload");
  }

  // Receipt last: the server's authority over it is structural, not a matter of the
  // validator happening to drop a client-supplied one.
  const record: InboxRecord = {
    ...fields,
    receiptId: createReceiptId(),
    receivedAt: new Date().toISOString(),
  };

  try {
    await createSubmissionInboxStore().append(record);
  } catch (cause) {
    // Server-side only. The response stays a bare code so nothing internal reaches a
    // child's browser, but an outage has to leave a trace somewhere.
    console.error("inbox append failed", cause);
    return refuse(503, "inbox-unavailable");
  }

  // 201, not 202: the record is durably appended before this answer is sent, so
  // nothing is merely accepted for later processing. No Location header on purpose -
  // there is no readable resource until the authenticated read side lands.
  return Response.json(
    { acknowledged: true, receiptId: record.receiptId, receivedAt: record.receivedAt },
    { status: 201 },
  );
}

import type { InboxRecord } from "@/application/submissions/submission-inbox-store";
import { createReceiptId, createSubmissionInboxStore } from "@/composition/server";

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

/** Machine-readable codes only - never an exception message, path or stack trace. */
function refuse(status: 400 | 503, error: "invalid-payload" | "inbox-unavailable"): Response {
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

  return { submissionId, questionId, createdAt, originalText };
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return refuse(400, "invalid-payload");
  }

  const fields = readSubmittedFields(body);
  if (fields === null) {
    return refuse(400, "invalid-payload");
  }

  const record: InboxRecord = {
    receiptId: createReceiptId(),
    receivedAt: new Date().toISOString(),
    ...fields,
  };

  try {
    await createSubmissionInboxStore().append(record);
  } catch {
    return refuse(503, "inbox-unavailable");
  }

  return Response.json(
    { acknowledged: true, receiptId: record.receiptId, receivedAt: record.receivedAt },
    { status: 202 },
  );
}

import type { ServerReceipt } from "@/domain/submissions/submission";

/**
 * What this project accepts as proof that the server really took a submission.
 *
 * One definition for both inboxes (MCL-30B). The text inbox carried a private copy of
 * this reader; the audio inbox needs exactly the same rule, and two copies would be two
 * chances for one of them to relax it. The rule is the load-bearing half of "never show
 * 'Im Projekt angekommen' without a server acknowledgement": every caller reaches the
 * arrived state only through a non-null answer from here.
 *
 * Anything less than an explicit `acknowledged: true` plus two non-blank receipt fields is
 * a refusal. Not a truthy check, not a missing-field default - a well-meaning-but-wrong
 * server, a proxy error page that happens to be JSON, or a 200 with an empty body must all
 * fail to produce a receipt rather than produce a hollow one.
 */
export function readServerReceipt(body: unknown): ServerReceipt | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const answer = body as Record<string, unknown>;
  if (answer.acknowledged !== true) {
    return null;
  }

  if (!nonBlankString(answer.receiptId) || !nonBlankString(answer.receivedAt)) {
    return null;
  }

  return { receiptId: answer.receiptId.trim(), receivedAt: answer.receivedAt.trim() };
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

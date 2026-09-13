import type { SubmissionReply } from "@/domain/replies/reply";

/**
 * MCL-74. The write side of the reply log.
 *
 * Two ports rather than one, for the reason MCL-50 recorded for the inbox and MCL-35
 * repeated for the question lifecycle: the child surface needs the READ capability and
 * must never be able to acquire the write one by asking the composition root for a
 * reader. Here the asymmetry is sharper than either - the writer speaks *as an adult to
 * a child*, and a single interface carrying both verbs would put that capability one
 * mistaken call away from a route behind the family gate.
 *
 * Append only. There is no update and no delete: a correction is a new reply, and the
 * one a child already heard read aloud stays readable afterwards.
 * `scripts/delete-submission.mjs` is the only remover, and it is an operator tool.
 */

/**
 * The reply names a submission the inbox does not hold.
 *
 * A typed error on the port rather than in one adapter, because the two adapters find
 * out differently - PostgreSQL raises a foreign-key violation, the file adapter has to
 * look - and the route has to tell "there is no such submission" (404) from "the store is
 * unavailable" (503) without knowing which adapter it was handed. Everything else stays
 * untyped and means the second.
 */
export class ReplyTargetError extends Error {
  constructor(
    readonly submissionId: string,
    options?: { cause?: unknown },
  ) {
    super("no submission with that id exists", options);
    this.name = "ReplyTargetError";
  }
}

export interface SubmissionReplyLog {
  append(reply: SubmissionReply): Promise<void>;
}

import { randomUUID } from "node:crypto";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import type { SubmissionInboxStore } from "@/application/submissions/submission-inbox-store";

const DEFAULT_INBOX_DIRECTORY = ".data/inbox";

/**
 * Server-only composition root. Never import this from browser code - it resolves a
 * filesystem location and must stay out of the client bundle.
 *
 * A store is built per request. That is right for an append-only file, which holds no
 * connection: a later database adapter must own its own pool internally rather than
 * being constructed per call from here.
 *
 * `||` rather than `??` on purpose: a host UI that defines AVALORIA_INBOX_DIR and
 * leaves it empty would otherwise hand `mkdir` an empty path, and every submission
 * would fail with 503 while the site and its health check still look fine.
 */
export function createSubmissionInboxStore(): SubmissionInboxStore {
  return new FileSubmissionInboxStore(
    process.env.AVALORIA_INBOX_DIR?.trim() || DEFAULT_INBOX_DIRECTORY,
  );
}

export function createReceiptId(): string {
  return randomUUID();
}

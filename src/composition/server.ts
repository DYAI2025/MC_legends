import { randomUUID } from "node:crypto";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import type { SubmissionInboxStore } from "@/application/submissions/submission-inbox-store";

const DEFAULT_INBOX_DIRECTORY = ".data/inbox";

/**
 * Server-only composition root. Never import this from browser code - it resolves a
 * filesystem location and must stay out of the client bundle.
 */
export function createSubmissionInboxStore(): SubmissionInboxStore {
  return new FileSubmissionInboxStore(process.env.AVALORIA_INBOX_DIR ?? DEFAULT_INBOX_DIRECTORY);
}

export function createReceiptId(): string {
  return randomUUID();
}

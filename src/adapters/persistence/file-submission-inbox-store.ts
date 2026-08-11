import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  InboxRecord,
  SubmissionInboxStore,
} from "@/application/submissions/submission-inbox-store";

const FILE_NAME = "submissions.jsonl";

/**
 * Append-only JSONL store for the family project inbox. Deliberately minimal:
 * durable multi-instance storage and the read/admin side belong to MCL-34 and the
 * later Supabase adapter, not to this sprint.
 */
export class FileSubmissionInboxStore implements SubmissionInboxStore {
  constructor(private readonly directory: string) {}

  async append(record: InboxRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await appendFile(join(this.directory, FILE_NAME), `${JSON.stringify(record)}\n`, "utf8");
  }
}

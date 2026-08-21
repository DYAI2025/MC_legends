import { expect } from "vitest";
import type {
  InboxEntry,
  TextInboxEntry,
} from "@/application/submissions/submission-inbox-reader";
import type {
  InboxRecord,
  TextInboxRecord,
} from "@/application/submissions/submission-inbox-store";

/**
 * Narrows a stored submission to its text member, failing the test if it is not one.
 *
 * Exists because MCL-49 turned InboxRecord and InboxEntry into discriminated unions, and
 * every assertion that reads `originalText` now has to say which member it expects.
 *
 * A cast would have compiled just as well and asserted nothing. These helpers assert the
 * discriminant first, so a store that starts returning an audio record where a text one was
 * written fails on that fact - with a readable message naming the kind it actually got -
 * rather than on a confusing `undefined` three lines later. The kind is the one field that
 * decides how a child's answer is read back, so a test touching the payload should be
 * pinning it, not assuming it.
 *
 * The `if` after the `expect` is not redundant: `expect` does not narrow for TypeScript, and
 * the throw is what gives these functions a non-optional return type.
 */
export function asTextRecord(record: InboxRecord | undefined): TextInboxRecord {
  expect(record?.kind).toBe("text");

  if (record === undefined || record.kind !== "text") {
    throw new Error(`expected a text inbox record, got kind=${String(record?.kind)}`);
  }

  return record;
}

export function asTextEntry(entry: InboxEntry | undefined): TextInboxEntry {
  expect(entry?.kind).toBe("text");

  if (entry === undefined || entry.kind !== "text") {
    throw new Error(`expected a text inbox entry, got kind=${String(entry?.kind)}`);
  }

  return entry;
}

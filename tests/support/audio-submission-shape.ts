import { expect } from "vitest";
import type {
  AudioInboxEntry,
  InboxEntry,
} from "@/application/submissions/submission-inbox-reader";
import type {
  AudioInboxRecord,
  InboxRecord,
} from "@/application/submissions/submission-inbox-store";

/**
 * Narrows a stored submission to its audio member, failing the test if it is not one.
 *
 * The sibling of `asTextRecord`/`asTextEntry`, and it exists for the same reason: a cast
 * would compile just as well and assert nothing. These assert the discriminant first, so
 * a store that returns a text record where a recording was written fails on that fact -
 * with a message naming the kind it actually got - rather than on a confusing `undefined`
 * three lines later.
 *
 * The `if` after the `expect` is not redundant: `expect` does not narrow for TypeScript,
 * and the throw is what gives these functions a non-optional return type.
 */
export function asAudioRecord(record: InboxRecord | undefined): AudioInboxRecord {
  expect(record?.kind).toBe("audio");

  if (record === undefined || record.kind !== "audio") {
    throw new Error(`expected an audio inbox record, got kind=${String(record?.kind)}`);
  }

  return record;
}

export function asAudioEntry(entry: InboxEntry | undefined): AudioInboxEntry {
  expect(entry?.kind).toBe("audio");

  if (entry === undefined || entry.kind !== "audio") {
    throw new Error(`expected an audio inbox entry, got kind=${String(entry?.kind)}`);
  }

  return entry;
}

import { describe, expect, it } from "vitest";
import type { InboxRecord } from "@/application/submissions/submission-inbox-store";
import type { SubmissionInboxReader } from "@/application/submissions/submission-inbox-reader";
import { asTextEntry } from "../support/text-submission-shape";
import { asAudioEntry } from "../support/audio-submission-shape";

/**
 * Seed data shared by every adapter's run of this contract.
 *
 * Four entries across two questions and both kinds, with deliberately non-monotonic
 * receivedAt values relative to their ids: `sub-mid` sorts between the others by time but
 * not by name. An adapter that accidentally orders by primary key instead of receivedAt
 * passes a two-row fixture and fails this one.
 *
 * `sub-delta` is a recording (MCL-49), and it is in the SHARED seed rather than in one
 * adapter's own file on purpose: the media round-trip is exactly the kind of thing two
 * adapters drift apart on. PostgreSQL stores the size in a bigint, which node-postgres
 * hands back as a string; the file adapter stores it as a JSON number. Both must return a
 * `number`, or the same recording reads as a different size depending on which store
 * happened to be configured.
 */
export function readerSeed(): readonly InboxRecord[] {
  return [
    {
      kind: "text",
      submissionId: "sub-alpha",
      questionId: "companion-animal",
      createdAt: "2026-08-13T08:00:00.000Z",
      receivedAt: "2026-08-13T09:00:00.000Z",
      receiptId: "receipt-alpha",
      originalText: "  ein drache mit  zwei koepfen  ",
    },
    {
      kind: "text",
      submissionId: "sub-charlie",
      questionId: "companion-animal",
      createdAt: "2026-08-13T10:00:00.000Z",
      receivedAt: "2026-08-13T11:00:00.000Z",
      receiptId: "receipt-charlie",
      originalText: "eine laterne die den weg kennt",
    },
    {
      kind: "text",
      submissionId: "sub-mid",
      questionId: "hidden-door",
      createdAt: "2026-08-13T09:30:00.000Z",
      receivedAt: "2026-08-13T10:00:00.000Z",
      receiptId: "receipt-mid",
      originalText: "hinter dem wasserfall",
    },
    {
      kind: "audio",
      submissionId: "sub-delta",
      questionId: "companion-animal",
      createdAt: "2026-08-13T10:15:00.000Z",
      receivedAt: "2026-08-13T10:30:00.000Z",
      receiptId: "receipt-delta",
      audio: AUDIO_ARTIFACT,
    },
  ];
}

/**
 * One stored recording's metadata, written out rather than derived.
 *
 * Every value satisfies migration 0002's CHECK constraints - the mime type and extension
 * are on the allowlists, the digest is 64 lowercase hex characters, the size is inside
 * 1..8388608 and the key is under 200 characters - so the PostgreSQL run of this contract
 * exercises the constraints rather than tripping over them.
 */
const AUDIO_ARTIFACT = {
  objectKey: "cd/cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd.webm",
  mimeType: "audio/webm",
  extension: "webm",
  sizeBytes: 128_000,
  sha256: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
} as const;

/**
 * The behaviour every SubmissionInboxReader must have, run against each adapter.
 * `createReader` must hand back a reader over exactly the records it is given.
 */
export function describeSubmissionInboxReaderContract(
  name: string,
  createReader: (seed: readonly InboxRecord[]) => Promise<SubmissionInboxReader>,
): void {
  describe(`${name} (SubmissionInboxReader contract)`, () => {
    it("lists every entry newest-first", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({});

      expect(page.entries.map((entry) => entry.submissionId)).toEqual([
        "sub-charlie",
        "sub-delta",
        "sub-mid",
        "sub-alpha",
      ]);
      expect(page.total).toBe(4);
    });

    it("returns the original text unchanged, including surrounding whitespace", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({});
      const alpha = page.entries.find((entry) => entry.submissionId === "sub-alpha");

      // Byte for byte. The admin view is a reader, and a reader that trims is an editor.
      expect(asTextEntry(alpha).originalText).toBe("  ein drache mit  zwei koepfen  ");
    });

    it("carries the receipt and both instants so an ACK stays traceable", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({});
      const charlie = page.entries.find((entry) => entry.submissionId === "sub-charlie");

      expect(charlie).toMatchObject({
        receiptId: "receipt-charlie",
        receivedAt: "2026-08-13T11:00:00.000Z",
        createdAt: "2026-08-13T10:00:00.000Z",
        questionId: "companion-animal",
        kind: "text",
      });
    });

    it("reports a processing status for an entry no writer ever set one on", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({});

      // The store defaults it; nothing in the write path supplies it. Both adapters must
      // agree on that default, or the same submission would show a different processing
      // state depending on which store happened to be configured.
      expect(page.entries.map((entry) => entry.status)).toEqual([
        "RECEIVED",
        "RECEIVED",
        "RECEIVED",
        "RECEIVED",
      ]);
    });

    it("filters by question reference", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({ questionId: "hidden-door" });

      expect(page.entries.map((entry) => entry.submissionId)).toEqual(["sub-mid"]);
      expect(page.total).toBe(1);
    });

    it("filters by status", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({ status: "RECEIVED" });

      expect(page.total).toBe(4);
    });

    it("filters by kind", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({ kind: "text" });

      // Three of the four: the recording must not be counted as a typed answer.
      expect(page.total).toBe(3);
    });

    it("filters recordings apart from typed answers", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({ kind: "audio" });

      expect(page.entries.map((entry) => entry.submissionId)).toEqual(["sub-delta"]);
      expect(page.total).toBe(1);
    });

    it("returns a recording's media metadata intact, with a numeric size", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({ kind: "audio" });
      const delta = asAudioEntry(page.entries[0]);

      expect(delta.audio).toEqual(AUDIO_ARTIFACT);
      // Not a string. PostgreSQL returns bigint as text so nothing is silently rounded;
      // an adapter that forwarded that text would make the admin view render "128000"
      // as a size and every arithmetic on it a string concatenation.
      expect(typeof delta.audio.sizeBytes).toBe("number");
    });

    it("combines filters rather than letting the last one win", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({ questionId: "hidden-door", status: "RECEIVED" });

      expect(page.entries.map((entry) => entry.submissionId)).toEqual(["sub-mid"]);
      expect(page.total).toBe(1);
    });

    it("matches a question reference exactly rather than by prefix", async () => {
      const reader = await createReader(readerSeed());

      // "companion" is a prefix of "companion-animal". A LIKE-based filter would return
      // two entries here and nobody would notice until a question id gained a suffix.
      const page = await reader.list({ questionId: "companion" });

      expect(page.entries).toEqual([]);
      expect(page.total).toBe(0);
    });

    it("caps the page at limit but still reports the full total", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({ limit: 1 });

      expect(page.entries.map((entry) => entry.submissionId)).toEqual(["sub-charlie"]);
      // Not 1. A capped page that also caps the count tells the reader the inbox is
      // smaller than it is - the one number they would use to decide they are done.
      expect(page.total).toBe(4);
    });

    it("returns an empty page rather than failing when nothing matches", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({ questionId: "a-question-nobody-answered" });

      expect(page.entries).toEqual([]);
      expect(page.total).toBe(0);
    });

    it("returns an empty page for an empty inbox", async () => {
      const reader = await createReader([]);

      const page = await reader.list({});

      expect(page.entries).toEqual([]);
      expect(page.total).toBe(0);
    });

    it("finds one typed answer by its submission id", async () => {
      const reader = await createReader(readerSeed());

      const entry = await reader.find("sub-alpha");

      expect(entry).toMatchObject({
        submissionId: "sub-alpha",
        kind: "text",
        status: "RECEIVED",
        receiptId: "receipt-alpha",
      });
      // Byte for byte, exactly as the list side returns it. A finder that trimmed would
      // be an editor, and this is the read the playback route is built on.
      expect(asTextEntry(entry ?? undefined).originalText).toBe(
        "  ein drache mit  zwei koepfen  ",
      );
    });

    it("finds one recording by its submission id, media metadata intact", async () => {
      const reader = await createReader(readerSeed());

      const entry = await reader.find("sub-delta");

      // This is the lookup the authorized playback route makes: everything it needs to
      // serve the bytes - the object key, the stored type, the size - comes from here.
      expect(asAudioEntry(entry ?? undefined).audio).toEqual(AUDIO_ARTIFACT);
      expect(typeof asAudioEntry(entry ?? undefined).audio.sizeBytes).toBe("number");
    });

    it("answers null for a submission id the inbox does not hold", async () => {
      const reader = await createReader(readerSeed());

      // null rather than a throw: "no such submission" is a normal answer to an id typed
      // into a URL, and the playback route turns it into a 404 rather than a 500.
      await expect(reader.find("sub-nobody-sent-this")).resolves.toBeNull();
    });

    it("answers null for an empty submission id rather than failing", async () => {
      const reader = await createReader(readerSeed());

      await expect(reader.find("")).resolves.toBeNull();
    });

    it("answers null for every id when the inbox is empty", async () => {
      const reader = await createReader([]);

      await expect(reader.find("sub-alpha")).resolves.toBeNull();
    });
  });
}

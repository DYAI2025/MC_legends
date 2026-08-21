import { describe, expect, it } from "vitest";
import type { InboxRecord } from "@/application/submissions/submission-inbox-store";
import type { SubmissionInboxReader } from "@/application/submissions/submission-inbox-reader";
import { asTextEntry } from "../support/text-submission-shape";

/**
 * Seed data shared by every adapter's run of this contract.
 *
 * Three entries across two questions, with deliberately non-monotonic receivedAt values
 * relative to their ids: `sub-mid` sorts between the other two by time but not by name.
 * An adapter that accidentally orders by primary key instead of receivedAt passes a
 * two-row fixture and fails this one.
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
  ];
}

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
        "sub-mid",
        "sub-alpha",
      ]);
      expect(page.total).toBe(3);
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

      expect(page.total).toBe(3);
    });

    it("filters by kind", async () => {
      const reader = await createReader(readerSeed());

      const page = await reader.list({ kind: "text" });

      expect(page.total).toBe(3);
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
      expect(page.total).toBe(3);
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
  });
}

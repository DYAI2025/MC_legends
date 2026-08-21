import { describe, expect, it } from "vitest";
import { asTextRecord } from "../support/text-submission-shape";
import type {
  TextInboxRecord,
  SubmissionInboxStore,
} from "@/application/submissions/submission-inbox-store";

export function inboxRecord(overrides: Partial<TextInboxRecord> = {}): TextInboxRecord {
  return {
    kind: "text",
    submissionId: "sub-1",
    questionId: "q-1",
    createdAt: "2026-08-13T09:00:00.000Z",
    receivedAt: "2026-08-13T09:00:01.000Z",
    receiptId: "receipt-1",
    originalText: "  ein drache mit  zwei koepfen  ",
    ...overrides,
  };
}

/**
 * The behaviour every SubmissionInboxStore must have, run against each adapter.
 * `createStore` must hand back an empty store each call.
 */
export function describeSubmissionInboxStoreContract(
  name: string,
  createStore: () => Promise<SubmissionInboxStore>,
): void {
  describe(`${name} (SubmissionInboxStore contract)`, () => {
    it("stores a record it has not seen", async () => {
      const store = await createStore();
      await expect(store.appendIfAbsent(inboxRecord())).resolves.toEqual({ stored: true });
    });

    it("returns the kept record for a repeated submissionId instead of storing again", async () => {
      const store = await createStore();
      const first = inboxRecord();
      await store.appendIfAbsent(first);

      const retry = inboxRecord({ receiptId: "receipt-2", receivedAt: "2026-08-13T10:00:00.000Z" });
      const outcome = await store.appendIfAbsent(retry);

      expect(outcome.stored).toBe(false);
      // The receipt the submission already has - byte for byte. A second receipt for
      // one submissionId is the exact failure this contract exists to prevent.
      expect(outcome.stored === false && outcome.existing.receiptId).toBe("receipt-1");
      expect(outcome.stored === false && outcome.existing.receivedAt).toBe(
        "2026-08-13T09:00:01.000Z",
      );
    });

    it("keeps the original text unchanged, including surrounding whitespace", async () => {
      const store = await createStore();
      const record = inboxRecord({ submissionId: "sub-ws" });
      await store.appendIfAbsent(record);

      const outcome = await store.appendIfAbsent(inboxRecord({ submissionId: "sub-ws" }));
      expect(outcome.stored).toBe(false);
      expect(asTextRecord(outcome.stored === false ? outcome.existing : undefined).originalText).toBe(
        "  ein drache mit  zwei koepfen  ",
      );
    });

    it("keeps distinct submissionIds apart", async () => {
      const store = await createStore();
      // A receipt each, as the route mints one per submission. Two records sharing a
      // receipt is not a state any store has to hold - the MCL-48 schema forbids it
      // outright, because a receipt a child is told their answer arrived under must
      // point at one submission and not two.
      await store.appendIfAbsent(inboxRecord({ submissionId: "sub-a", receiptId: "receipt-a" }));
      await expect(
        store.appendIfAbsent(inboxRecord({ submissionId: "sub-b", receiptId: "receipt-b" })),
      ).resolves.toEqual({
        stored: true,
      });
    });
  });
}

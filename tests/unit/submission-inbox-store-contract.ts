import { describe, expect, it } from "vitest";
import { asTextRecord } from "../support/text-submission-shape";
import {
  SubmissionPayloadError,
  type AudioInboxRecord,
  type TextInboxRecord,
  type SubmissionInboxStore,
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
 * The product maximum for one stored recording, written out rather than imported.
 *
 * Deliberate duplication, and the same choice the reader contract makes when it says its
 * fixture sits "inside 1..8388608": this suite runs against PostgreSQL, where the number
 * is also spelled out - in `submission_inbox_media_size_bounded` in migration 0002. A
 * suite that imported MAX_AUDIO_BYTES would follow the constant wherever it went and stay
 * green while the code and the schema drifted apart. Written out, the two have to agree or
 * the PostgreSQL run of this contract fails.
 */
const PRODUCT_MAXIMUM_BYTES = 8_388_608;

/**
 * One stored recording's metadata.
 *
 * Every value satisfies migration 0002's CHECK constraints - the mime type and extension
 * are on the allowlists, the digest is 64 lowercase hex characters and the key is under
 * 200 characters - so the size is the only thing a case here varies, and a refusal can
 * only be about the size.
 */
const AUDIO_ARTIFACT = {
  objectKey: "ab/abababababababababababababababababababababababababababababababab.webm",
  mimeType: "audio/webm",
  extension: "webm",
  sizeBytes: 128_000,
  sha256: "abababababababababababababababababababababababababababababababab",
} as const;

export function audioInboxRecord(sizeBytes: number, submissionId: string): AudioInboxRecord {
  return {
    kind: "audio",
    submissionId,
    questionId: "q-audio",
    createdAt: "2026-08-21T09:00:00.000Z",
    receivedAt: "2026-08-21T09:00:01.000Z",
    receiptId: `receipt-${submissionId}`,
    audio: { ...AUDIO_ARTIFACT, sizeBytes },
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

    it("stores a recording at exactly the product maximum", async () => {
      // The boundary is accepted, in both adapters. A store that refused it would make the
      // largest legitimate recording indistinguishable from an oversized one, and the
      // child would be told their answer is invalid for being exactly as long as allowed.
      const store = await createStore();
      await expect(
        store.appendIfAbsent(audioInboxRecord(PRODUCT_MAXIMUM_BYTES, "sub-at-max")),
      ).resolves.toEqual({ stored: true });
    });

    it("refuses a recording one byte above the product maximum, whichever adapter it is", async () => {
      // MCL-49 finding F1. PostgreSQL has always refused this - it is a 23514 check
      // violation on submission_inbox_media_size_bounded, which the adapter turns into a
      // SubmissionPayloadError. The file adapter is MCL-48's rollback path and had no
      // equivalent, so the same record it refuses in production was stored and
      // acknowledged with a receipt after a rollback.
      //
      // SubmissionPayloadError and not a bare Error, because the distinction is what the
      // route answers with: a payload the store will never accept is a 400 that ends
      // there, and anything else is a 503 the caller is invited to retry forever.
      const store = await createStore();
      await expect(
        store.appendIfAbsent(audioInboxRecord(PRODUCT_MAXIMUM_BYTES + 1, "sub-over-max")),
      ).rejects.toThrow(SubmissionPayloadError);
    });
  });
}

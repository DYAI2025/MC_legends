import { describe, expect, it } from "vitest";
import {
  readBoundedBody,
  readBoundedBytes,
} from "@/adapters/http/bounded-json-body";

/**
 * Pins the split between the streaming byte cap and the UTF-8 decode (MCL-49).
 *
 * The cap used to be welded to a strict `TextDecoder`, so the only way to read a body
 * with a bound was to also decode it. A recording has to survive byte for byte, and a
 * decode that "succeeded" on audio would be the bug rather than the check - so the loop
 * is extracted and this file pins both halves: that `readBoundedBytes` returns the bytes
 * untouched and abandons an oversized body mid-stream, and that `readBoundedBody` still
 * behaves exactly as it did before the extraction.
 *
 * Measured while writing this: `new Request(url, { body: stream, duplex: "half" })` on
 * Node 24 keeps the caller's ReadableStream as `request.body` (`req.body === stream`),
 * so a `cancel` on the underlying source really does observe the reader's cancel. That
 * is what makes the mid-stream case an assertion rather than a hope.
 */

const ENDPOINT = "http://localhost/api/anything";

/**
 * The first bytes of a real WebM recording: the EBML magic, then the header's first
 * element.
 *
 * Measured while writing this - the four magic bytes ALONE are valid UTF-8 (0xdf 0xa3 is
 * a well-formed two-byte sequence for U+07E3), so a fixture that stopped there would have
 * proven nothing about the strict decode. 0x9f is a lone continuation byte, which no
 * UTF-8 sequence may start with, and it is what makes these bytes genuinely undecodable.
 */
const EBML_HEADER = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);

function bodyRequest(body: BodyInit, duplex = false): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    body,
    ...(duplex ? { duplex: "half" } : {}),
  } as RequestInit);
}

/**
 * A body that is still arriving, and that reports whether the reader gave up on it.
 *
 * Deliberately never closed. Measured while writing this: a stream whose controller is
 * closed after the last enqueue transitions to "closed" the moment the reader takes the
 * final queued chunk, and `cancel()` on a closed stream is a no-op that never reaches
 * the underlying source - so a fixture that closed would report `cancelled === false`
 * however correct the code under test was. A real oversized upload is still in flight
 * when the cap is crossed, which is exactly what an unclosed stream models.
 *
 * `deliveredChunks` counts what the reader actually pulled, so "abandoned mid-stream"
 * can be asserted as a number rather than inferred.
 */
function chunkedRequest(chunks: readonly Uint8Array[]): {
  request: Request;
  wasCancelled: () => boolean;
  deliveredChunks: () => number;
} {
  let cancelled = false;
  let delivered = 0;
  let next = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next >= chunks.length) return;
      controller.enqueue(chunks[next]);
      next += 1;
      delivered += 1;
    },
    cancel() {
      cancelled = true;
    },
  });

  return {
    request: bodyRequest(stream, true),
    wasCancelled: () => cancelled,
    deliveredChunks: () => delivered,
  };
}

describe("readBoundedBytes", () => {
  it("returns exactly the bytes that arrived", async () => {
    const payload = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0x41]);

    const bytes = await readBoundedBytes(bodyRequest(payload), 1024);

    expect(bytes).not.toBeNull();
    expect(bytes?.byteLength).toBe(payload.byteLength);
    expect([...(bytes as Uint8Array)]).toEqual([...payload]);
  });

  it("accepts a body that is exactly the cap", async () => {
    // The boundary is `>`, not `>=`. A recording of exactly the documented maximum is a
    // legitimate upload, and an off-by-one here would refuse it with no way to tell that
    // refusal from a genuinely oversized one.
    const payload = new Uint8Array(64).fill(0x61);

    const bytes = await readBoundedBytes(bodyRequest(payload), 64);

    expect(bytes?.byteLength).toBe(64);
  });

  it("returns null when a single chunk already exceeds the cap", async () => {
    const payload = new Uint8Array(65).fill(0x61);

    await expect(readBoundedBytes(bodyRequest(payload), 64)).resolves.toBeNull();
  });

  it("abandons an oversized body mid-stream rather than buffering all of it", async () => {
    // Five chunks of 40 bytes against a 100-byte cap: the third crosses it, so the
    // refusal has to happen while the stream is still open and the last two must never
    // be pulled. A version that read to the end and checked the total would pass every
    // other case here and still let a caller hand this server an arbitrarily large body.
    const chunk = () => new Uint8Array(40).fill(0x62);
    const { request, wasCancelled, deliveredChunks } = chunkedRequest([
      chunk(),
      chunk(),
      chunk(),
      chunk(),
      chunk(),
    ]);

    await expect(readBoundedBytes(request, 100)).resolves.toBeNull();
    expect(wasCancelled(), "the reader must let go of an oversized body").toBe(true);
    // The third chunk is what crosses the cap (120 > 100), so the reader stops there.
    // The bound is 4 rather than 3 because a ReadableStream may pull one chunk ahead to
    // keep its queue non-empty; what matters is that the last chunks are never asked
    // for. A reader that drained the body and checked the total afterwards reports 5.
    expect(deliveredChunks()).toBeLessThanOrEqual(4);
  });

  it("returns null when the request carries no body at all", async () => {
    await expect(
      readBoundedBytes(new Request(ENDPOINT, { method: "POST" }), 1024),
    ).resolves.toBeNull();
  });

  it("returns bytes that are not valid UTF-8 unchanged", async () => {
    const bytes = await readBoundedBytes(bodyRequest(EBML_HEADER), 1024);

    expect([...(bytes as Uint8Array)]).toEqual([...EBML_HEADER]);
  });
});

describe("readBoundedBody", () => {
  it("still decodes a body that is valid UTF-8", async () => {
    const text = '{"originalText":"  Der Steinwolf trägt eine Laterne.  "}';

    await expect(readBoundedBody(bodyRequest(text), 1024)).resolves.toBe(text);
  });

  it("still refuses bytes that are not valid UTF-8", async () => {
    // The same header readBoundedBytes returns unchanged. The decode is strict, and a
    // JSON endpoint handed these bytes must be told no rather than handed U+FFFD.
    await expect(readBoundedBody(bodyRequest(EBML_HEADER), 1024)).resolves.toBeNull();
  });

  it("still refuses a body over the cap", async () => {
    const payload = "a".repeat(65);

    await expect(readBoundedBody(bodyRequest(payload), 64)).resolves.toBeNull();
  });

  it("still refuses a request with no body", async () => {
    await expect(
      readBoundedBody(new Request(ENDPOINT, { method: "POST" }), 1024),
    ).resolves.toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The audio size ceiling in the composition root (MCL-49).
 *
 * What this file pins: AVALORIA_AUDIO_MAX_BYTES may LOWER the accepted upload size and can
 * never RAISE it.
 *
 * Measured on a135e2b, when it could. audioMaxBytes() returned any positive value, so a
 * host that set 33554432 widened the upload route past what migration 0002's
 * submission_inbox_media_size_bounded allows, and the two persistence modes failed
 * differently for the same request:
 *
 * - PostgreSQL mode wrote the blob first - which is the correct ordering, and exactly why
 *   the limit has to be right before that write - then had the row refused by the CHECK.
 *   The bytes are deliberately never deleted after a database failure, so the widened
 *   ceiling bought an orphan recording on disk for every attempt.
 * - FileSubmissionInboxStore rollback mode refused nothing at all. There is no CHECK
 *   constraint on a JSONL file, so an oversized recording was stored and acknowledged
 *   with a receipt.
 *
 * The number is written out here rather than imported. This file is the independent
 * statement of the product maximum; a test that imported the constant would agree with
 * whatever value the constant happened to hold. The constant is tied to this number in
 * tests/unit/audio-artifact.test.ts, in one place.
 */

const PRODUCT_MAXIMUM = 8_388_608;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * A fresh module registry per read.
 *
 * audioMaxBytes() warns at most once per process about a configuration it had to clamp,
 * so a shared import would let the first case that warns be the only one that ever can.
 * The environment itself is read per call, not at module load, which is why the stub can
 * be set before the import or after it.
 */
async function readAudioMaxBytes(configured: string | undefined): Promise<number> {
  vi.resetModules();
  vi.stubEnv("AVALORIA_AUDIO_MAX_BYTES", configured);
  const { audioMaxBytes } = await import("@/composition/server");
  return audioMaxBytes();
}

describe("audioMaxBytes", () => {
  it("defaults to the product maximum when nothing is configured", async () => {
    await expect(readAudioMaxBytes(undefined)).resolves.toBe(PRODUCT_MAXIMUM);
  });

  it("lets a deployment lower the ceiling without a migration", async () => {
    // The whole legitimate use of the variable: a host with less memory, a slower link or
    // a stricter proxy narrows what it accepts, and nothing in the schema has to change
    // because a smaller recording still satisfies every constraint a larger one does.
    await expect(readAudioMaxBytes("1048576")).resolves.toBe(1_048_576);
    await expect(readAudioMaxBytes("1")).resolves.toBe(1);
  });

  it("accepts the product maximum spelled out exactly", async () => {
    await expect(readAudioMaxBytes(String(PRODUCT_MAXIMUM))).resolves.toBe(PRODUCT_MAXIMUM);
  });

  it("cannot be widened by one byte", async () => {
    // 8388609 is the smallest value that would have made the route accept something the
    // database is going to refuse, which makes it the case worth naming.
    await expect(readAudioMaxBytes("8388609")).resolves.toBe(PRODUCT_MAXIMUM);
  });

  it("cannot be widened by a much larger value either", async () => {
    for (const configured of ["33554432", "1073741824", "9007199254740991"]) {
      await expect(readAudioMaxBytes(configured)).resolves.toBe(PRODUCT_MAXIMUM);
    }
  });

  it("falls back to the product maximum for a value that is not a positive integer", async () => {
    // Unchanged behaviour, kept under test because the clamp rewrote the function around
    // it: a blank, a zero, a negative, a fraction and a word are all "not configured",
    // never "configured as something smaller than 1".
    for (const configured of ["", "   ", "0", "-1", "1.5", "acht", "8388608 bytes"]) {
      await expect(readAudioMaxBytes(configured)).resolves.toBe(PRODUCT_MAXIMUM);
    }
  });
});

describe("audioMaxBytes clamp reporting", () => {
  it("says once per process that it ignored a configured value", async () => {
    // A silently ignored configuration value is the failure this project does not accept:
    // whoever set 33554432 has to be able to find out from a log that the running server
    // is not honouring it. Once per process rather than once per request, because this is
    // read on the hot path of every upload.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    vi.stubEnv("AVALORIA_AUDIO_MAX_BYTES", "33554432");
    const { audioMaxBytes } = await import("@/composition/server");

    expect(audioMaxBytes()).toBe(PRODUCT_MAXIMUM);
    expect(audioMaxBytes()).toBe(PRODUCT_MAXIMUM);
    expect(audioMaxBytes()).toBe(PRODUCT_MAXIMUM);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("AVALORIA_AUDIO_MAX_BYTES");
  });

  it("stays quiet for a value it is honouring", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    vi.stubEnv("AVALORIA_AUDIO_MAX_BYTES", "1048576");
    const { audioMaxBytes } = await import("@/composition/server");

    expect(audioMaxBytes()).toBe(1_048_576);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet at exactly the product maximum", async () => {
    // The boundary belongs in the reporting test too: a deployment that spells the
    // documented maximum out is configuring nothing unusual and must not be told it was
    // overruled.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    vi.stubEnv("AVALORIA_AUDIO_MAX_BYTES", String(PRODUCT_MAXIMUM));
    const { audioMaxBytes } = await import("@/composition/server");

    expect(audioMaxBytes()).toBe(PRODUCT_MAXIMUM);
    expect(warn).not.toHaveBeenCalled();
  });
});

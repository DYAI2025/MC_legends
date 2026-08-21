/**
 * The smallest byte sequences `sniffAudioMimeType` identifies, one per allowlisted type,
 * plus the ones it must refuse (MCL-49).
 *
 * Real container headers rather than invented bytes: the sniffer reads a container's own
 * self-description, so a fixture made of arbitrary bytes would prove that the sniffer
 * matches this file and nothing about whether it matches a recording. Each fixture is
 * padded to a fixed length with a distinct filler byte, so no two fixtures share a
 * SHA-256 and a test asserting "one file on disk" cannot pass by accident.
 *
 * The hostile ones are the point of the file. HTML and ELF are what an upload of
 * something that is not audio looks like; RIFF_AVI is a container that passes a naive
 * `startsWith("RIFF")` check and is not a WAVE, which is exactly the check the sniffer
 * makes at offset 8.
 */

const FIXTURE_BYTES = 64;

/**
 * Header bytes, then filler, to a fixed length.
 *
 * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, which since TypeScript 5.7
 * means `Uint8Array<ArrayBufferLike>` and is NOT assignable to `BodyInit` - the DOM lib
 * declares that over `ArrayBufferView<ArrayBuffer>`, because a body cannot be backed by a
 * SharedArrayBuffer. Every fixture here is destined for `new Request(url, { body })`, so
 * the narrower type is the honest one and saves each call site a cast.
 */
function container(header: readonly number[], filler: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(FIXTURE_BYTES).fill(filler);
  bytes.set(header, 0);
  return bytes;
}

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/**
 * EBML magic, then the header's first element id.
 *
 * The four magic bytes alone are valid UTF-8 (0xdf 0xa3 spells U+07E3), so this carries
 * the following 0x9f as well - a lone continuation byte no UTF-8 sequence may start with.
 * A recording really is undecodable text, and the fixture has to be too or the byte path
 * would be proven with bytes that would have survived the old decode.
 */
export const WEBM = container([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01], 0x11);

/** "OggS" - the Ogg page header. */
export const OGG = container(ascii("OggS"), 0x22);

/** A 4-byte box size, then "ftyp" at offset 4, then a brand. m4a and Safari's output. */
export const MP4 = container([0x00, 0x00, 0x00, 0x18, ...ascii("ftypM4A ")], 0x33);

/** "ID3" - an MP3 carrying a tag header. */
export const MP3_ID3 = container(ascii("ID3"), 0x44);

/** "RIFF", a 4-byte size, then "WAVE" at offset 8. */
export const WAV = container([...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WAVE")], 0x55);

/** Not audio at all, and the shape of an upload that hopes to be served back as a page. */
export const HTML: Uint8Array<ArrayBuffer> = new Uint8Array(ascii("<script>alert(1)</script>"));

/** An executable. Nothing about it is on the allowlist and nothing may store it. */
export const ELF = container([0x7f, ...ascii("ELF")], 0x66);

/**
 * A RIFF container that is not a WAVE.
 *
 * The sniffer checks "WAVE" at offset 8, after the chunk size - so this proves the offset
 * check rather than a bare `startsWith("RIFF")`, which would accept every AVI ever made
 * as an audio answer.
 */
export const RIFF_AVI = container(
  [...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("AVI ")],
  0x77,
);

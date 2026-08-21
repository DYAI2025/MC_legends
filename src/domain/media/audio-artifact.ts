/**
 * What an audio answer is, independent of how it arrives or where it is stored (MCL-49).
 *
 * Framework-free and adapter-free on purpose: the allowlist, the extension table and the
 * object-key derivation are product invariants, not properties of a filesystem or of an
 * HTTP route. Both the upload route and the blob adapter have to agree on them, and the
 * only way to make that agreement structural rather than conventional is to give them one
 * place to agree in.
 */

/**
 * The audio types a child's answer may arrive as, and the one extension each is stored
 * under.
 *
 * A total table rather than two lists. An extension is not a fact about the upload - it is
 * this server's decision about the name it writes to disk. Deriving it from the client's
 * filename instead is how a `.webm` becomes a `.php` on a host that later learns to execute
 * one, and MCL-49 requires that stored audio is never delivered as executable web content.
 * Adding a MIME type here is a compile error until its extension is chosen.
 *
 * The set is what browsers actually produce plus what a file fallback realistically
 * carries: MediaRecorder emits webm/opus on Chromium and mp4 on Safari; a parent handing a
 * child a voice memo produces m4a, mp3, wav or ogg. Nothing here transcodes or
 * re-containers - MCL-49 requires the stored bytes to be the submitted bytes.
 */
export const AUDIO_MIME_EXTENSIONS = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
} as const satisfies Record<string, string>;

export type AudioMimeType = keyof typeof AUDIO_MIME_EXTENSIONS;

/**
 * The largest recording this project stores, in bytes. 8 MiB, decided 2026-08-21.
 *
 * Here rather than next to the environment read, and that placement is the whole point. It
 * is a product decision of the same class as the allowlist above - not a property of a
 * filesystem, an HTTP route or a deployment - and the upload route, both inbox adapters and
 * the composition root all have to agree on it. This module is the one place all of them
 * may import, which is what makes the agreement structural instead of four copies of a
 * number that drift.
 *
 * A deployment may LOWER what it accepts, through AVALORIA_AUDIO_MAX_BYTES; the composition
 * root clamps that value to this one and can never be pushed above it. Widening the product
 * maximum is a schema migration first - `submission_inbox_media_size_bounded` in
 * `db/migrations/0002_submission_audio.sql` spells the same number out - and a code change
 * second, in that order, exactly as it is for the text length cap.
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const AUDIO_MIME_TYPES = Object.keys(AUDIO_MIME_EXTENSIONS) as readonly AudioMimeType[];

/**
 * Whether a client-supplied string is one of the types this project accepts.
 *
 * Exact match against the table, never a `startsWith("audio/")`. A prefix test accepts
 * `audio/x-anything`, which is precisely the category of value nobody has decided to store.
 */
export function isAudioMimeType(value: string): value is AudioMimeType {
  return (AUDIO_MIME_TYPES as readonly string[]).includes(value);
}

export function audioExtensionFor(mimeType: AudioMimeType): string {
  return AUDIO_MIME_EXTENSIONS[mimeType];
}

/** A SHA-256 as this project writes it: 64 lowercase hex characters, nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * Where one audio artifact lives, derived only from values this server computed.
 *
 * This function is the whole path-traversal answer, and it is an answer by construction
 * rather than by filtering. The key is built from a verified SHA-256 and an extension read
 * out of the total table above - neither of which a client can influence. There is no
 * sanitisation step to forget, no filename to strip `../` out of, and no submissionId in
 * the path: a caller that hands this a hostile string gets a thrown error, not a cleaned-up
 * one, because a value that is not a SHA-256 means the caller skipped hashing and that is a
 * bug rather than an attack to be quietly absorbed.
 *
 * Content-addressed, which makes a retry idempotent for free: the same bytes produce the
 * same key, so re-storing an already-stored recording is a byte-identical rewrite rather
 * than a second copy under a second name.
 *
 * The two-character shard keeps any one directory from collecting every recording the
 * project ever receives - some filesystems degrade badly past a few tens of thousands of
 * entries in one directory, and a family inbox is cheap to shard now and expensive to
 * reshape later.
 */
export function audioObjectKey(sha256: string, mimeType: AudioMimeType): string {
  if (!isSha256Hex(sha256)) {
    throw new Error("audio object key requires a lowercase hex SHA-256");
  }

  return `${sha256.slice(0, 2)}/${sha256}.${audioExtensionFor(mimeType)}`;
}

/**
 * The metadata PostgreSQL keeps about one stored recording (MCL-49 acceptance criteria).
 *
 * The bytes themselves are deliberately absent: they live in the private file store, and a
 * type that could carry either would make it possible to hand a database row a megabyte of
 * audio by accident. `objectKey` is the reference between the two, and it is the only one.
 */
export type AudioArtifact = Readonly<{
  objectKey: string;
  mimeType: AudioMimeType;
  extension: string;
  sizeBytes: number;
  sha256: string;
}>;

/**
 * Builds the metadata record from a verified hash and a verified type.
 *
 * Takes the size rather than deriving it, because the only honest source for it is the
 * number of bytes actually written, and this module deliberately never sees the bytes.
 *
 * The ceiling is checked here as well as at the route, and the duplication is deliberate:
 * this is the backstop for a caller that did not come through the composition root. It
 * throws rather than returning a sentinel, for the same reason audioObjectKey does - a
 * caller arriving with an oversized size skipped a guard, which is a bug to surface and
 * not an input to absorb quietly. The upload route calls this BEFORE writing the blob, so
 * a backstop that does fire cannot leave an orphan recording on the device.
 */
export function describeAudioArtifact(input: {
  sha256: string;
  mimeType: AudioMimeType;
  sizeBytes: number;
}): AudioArtifact {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new Error("audio artifact size must be a positive integer byte count");
  }

  if (input.sizeBytes > MAX_AUDIO_BYTES) {
    throw new Error("audio artifact size exceeds the product maximum");
  }

  return Object.freeze({
    objectKey: audioObjectKey(input.sha256, input.mimeType),
    mimeType: input.mimeType,
    extension: audioExtensionFor(input.mimeType),
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
  });
}

/**
 * The declared Content-Type is client input. This is what the bytes actually are.
 *
 * MCL-49 allows a strict MIME allowlist, and an allowlist checked only against a header is
 * an allowlist a client opts into. Every signature below is at a fixed offset in the
 * container's own header, so this reads the file's self-description rather than the
 * uploader's claim about it.
 *
 * Returns null for anything it cannot identify, and the caller refuses on null. Guessing -
 * "it is probably webm" - is the one behaviour that would make this worse than no check at
 * all, because it would let an unidentified byte stream be stored under an audio extension.
 */
export function sniffAudioMimeType(bytes: Uint8Array): AudioMimeType | null {
  // "RIFF" .... "WAVE" - the format word sits at offset 8, after the 4-byte chunk size,
  // so a RIFF container that is not WAVE (an AVI, say) is correctly not matched.
  if (matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, 8, [0x57, 0x41, 0x56, 0x45])) {
    return "audio/wav";
  }

  // "OggS" - the Ogg page header.
  if (matches(bytes, 0, [0x4f, 0x67, 0x67, 0x53])) {
    return "audio/ogg";
  }

  // EBML header, shared by WebM and Matroska. Accepted as WebM: MediaRecorder produces it,
  // and the distinction between the two is a DocType string further in that says nothing
  // about whether the payload is audio this project should keep.
  if (matches(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return "audio/webm";
  }

  // ISO base media: a size field, then "ftyp" at offset 4. m4a and Safari's MediaRecorder
  // output are both this.
  if (matches(bytes, 4, [0x66, 0x74, 0x79, 0x70])) {
    return "audio/mp4";
  }

  // "ID3" - an MP3 carrying a tag header.
  if (matches(bytes, 0, [0x49, 0x44, 0x33])) {
    return "audio/mpeg";
  }

  // A bare MPEG audio frame: eleven set sync bits. Checked last, because it is the least
  // specific pattern here and would otherwise shadow a container whose header happens to
  // begin with 0xFF.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }

  return null;
}

function matches(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }

  return signature.every((byte, index) => bytes[offset + index] === byte);
}

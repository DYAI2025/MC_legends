/**
 * Where the unchanged original recording lives (MCL-49).
 *
 * A separate port from SubmissionInboxStore, not another method on it, for the same
 * reason the read and write sides of the inbox are separate: they are different
 * capabilities with different failure modes and different backing technology. The inbox
 * is a database; this is a private directory on a persistent volume. One interface over
 * both would mean every holder of the inbox writer could also write files.
 *
 * Deliberately byte-oriented rather than stream-oriented. MCL-49 bounds an upload at
 * 8 MiB, the route has to hash the whole payload before it can name the object key, and
 * a stream that is consumed for hashing cannot then be consumed again for writing. A
 * streaming port would be the right shape for a store that accepted arbitrarily large
 * media - and would be a lie about how this one is actually used.
 */
export interface AudioBlobStore {
  /**
   * Writes the bytes under `objectKey`, or does nothing if that key already holds them.
   *
   * Idempotent because the key is content-addressed: `objectKey` is derived from the
   * SHA-256 of these bytes, so a key that already exists already holds exactly this
   * content. That makes a retry free rather than a second copy, and it is why the caller
   * may safely re-store a recording it is not sure was written.
   *
   * Must be atomic: a crash mid-write may leave nothing under the key, and must never
   * leave a partial file under it. A truncated recording that a database row vouches for
   * is worse than a missing one, because only the missing one is detectable.
   *
   * Must be durable before it resolves. The route answers a child with "Im Projekt
   * angekommen" only after this settles, and an acknowledgement for bytes still sitting
   * in a page cache is a promise the machine has not yet made.
   */
  store(objectKey: string, bytes: Uint8Array): Promise<void>;

  /**
   * The stored bytes, or null when nothing is stored under that key.
   *
   * `null` rather than a throw for the absent case: a submission row whose blob is gone
   * is a real state - a restore that recovered the database but not the media, a blob
   * removed by a future retention policy - and the authorized playback route has to
   * answer 404 for it rather than 500. Every other failure throws.
   *
   * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, which since TypeScript 5.7
   * means `Uint8Array<ArrayBufferLike>` and is not assignable to `BodyInit` - a response
   * body cannot be backed by a SharedArrayBuffer. The playback route hands what this
   * returns straight to `new Response(...)`, so the narrower type is what lets it do that
   * without copying up to 8 MiB per playback to satisfy the compiler.
   */
  read(objectKey: string): Promise<Uint8Array<ArrayBuffer> | null>;

  /**
   * Throws unless the store can actually be written to right now.
   *
   * Readiness needs this to report storage separately from the database, and it has to
   * be a real write: a directory that exists and is not writable - a read-only remount, a
   * full disk, a volume that failed to mount and left an empty path behind - passes every
   * cheaper check and fails every submission.
   */
  checkWritable(): Promise<void>;
}

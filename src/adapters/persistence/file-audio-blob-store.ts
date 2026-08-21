import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { AudioBlobStore } from "@/application/media/audio-blob-store";
import { AUDIO_MIME_EXTENSIONS } from "@/domain/media/audio-artifact";

/**
 * The only key shape this adapter will touch: a two-character hex shard, a 64-character
 * lowercase hex digest, and an extension that is on the allowlist.
 *
 * `audioObjectKey` in the domain already builds exactly this and refuses anything else,
 * so in a correct program this pattern never rejects. It is here anyway because it is the
 * last thing between a string and a filesystem path, and the cost of the two being out of
 * step is not a bug report - it is a write outside the media directory. A guard that only
 * exists at the point where the value is produced protects the callers that exist today.
 *
 * It makes traversal unrepresentable rather than filtered: `.`, `/` beyond the single
 * shard separator, NUL, backslash and every absolute-path form fail outright. Nothing is
 * stripped or repaired - a key that does not match is a bug in the caller.
 *
 * The extension alternation is BUILT FROM the domain's table rather than written out as a
 * character class. Measured while writing this: a `[a-z0-9]{1,8}` extension pattern -
 * which is what "a short alphanumeric extension" naturally becomes - accepts
 * `01/<sha>.php`, and MCL-49 requires that stored audio is never delivered as executable
 * web content. Deriving the set means adding a format to the allowlist is the only way to
 * widen what can be written, and removing one closes this door too.
 */
const ALLOWED_EXTENSIONS = [...new Set(Object.values(AUDIO_MIME_EXTENSIONS))];

const OBJECT_KEY = new RegExp(
  `^([0-9a-f]{2})/([0-9a-f]{64})\\.(?:${ALLOWED_EXTENSIONS.join("|")})$`,
);

/**
 * Private, persistent storage for unchanged original recordings (MCL-49).
 *
 * The directory is expected to be a bind mount or volume on the VPS, outside the
 * container's writable layer, so a Coolify redeploy or a container restart does not take
 * the recordings with it. Nothing in this class enforces that - it cannot - which is why
 * it is an acceptance criterion checked against the real deployment rather than a claim
 * made here.
 *
 * Nothing serves this directory over HTTP. Playback goes through an authorized route that
 * reads through this adapter, so there is no public media URL and no static path that
 * could execute what it finds.
 */
export class FileAudioBlobStore implements AudioBlobStore {
  constructor(private readonly directory: string) {}

  async store(objectKey: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(objectKey);

    // Content-addressed: the key is the hash of these bytes, so a key that is already
    // present already holds exactly this content. Combined with the atomic rename below,
    // "the file exists" means "a complete copy of these bytes exists" - there is no
    // half-written state a rename could have left behind. So a retry costs one stat.
    if (await this.exists(path)) {
      return;
    }

    await mkdir(dirname(path), { recursive: true });

    // Written to a temporary name in the SAME directory, then renamed. rename(2) is
    // atomic within a filesystem, so a reader either sees no file or sees the whole one -
    // never the 300 KB that had been flushed when the process died. The temp name has to
    // share the directory for that guarantee to hold; /tmp is usually a different
    // filesystem, where rename degrades to a copy and stops being atomic.
    //
    // A random suffix rather than the pid: two processes storing the same recording
    // concurrently must not choose the same temporary path and truncate each other's.
    const temporary = `${path}.${randomUUID()}.part`;

    try {
      const handle = await open(temporary, "wx");
      try {
        await handle.write(bytes);
        // Before the rename, not after: a rename that lands in the directory entry while
        // the data is still in the page cache is exactly the durable-looking, empty file
        // this ordering exists to prevent.
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(temporary, path);
    } catch (cause) {
      // The partial file must not be left behind. It cannot be mistaken for a recording -
      // it is not under a valid key - but it would accumulate silently on a volume whose
      // free space is already the thing this feature spends.
      await rm(temporary, { force: true }).catch(() => undefined);
      throw cause;
    }

    // The directory entry itself. Without this a crash immediately after the rename can
    // lose the name even though the contents were synced, and the row in PostgreSQL would
    // then reference a recording the filesystem never admits to having.
    await this.syncDirectory(dirname(path));
  }

  async read(objectKey: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.pathFor(objectKey));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        // A real state, not a fault: a database restored without its media, or a blob a
        // future retention policy removed. The caller answers 404, not 500.
        return null;
      }
      throw cause;
    }
  }

  async checkWritable(): Promise<void> {
    await mkdir(this.directory, { recursive: true });

    // A real write and a real removal. `stat` would pass on a read-only remount, on a
    // full disk, and on a volume that failed to mount and left an empty directory behind -
    // all three of which fail every submission while readiness reports storage is fine.
    const probe = join(this.directory, `.writable-${randomUUID()}`);
    const handle = await open(probe, "wx");
    try {
      await handle.write(new Uint8Array([0]));
    } finally {
      await handle.close();
      await rm(probe, { force: true }).catch(() => undefined);
    }
  }

  /**
   * The absolute path for a key, refusing anything that is not a key this project mints.
   *
   * The resolve check after the pattern is belt and braces, and deliberately so: the
   * pattern is the guarantee, and this is the assertion that the guarantee held. If the
   * two ever disagree the answer is a thrown error naming the key, not a write.
   */
  private pathFor(objectKey: string): string {
    const parsed = OBJECT_KEY.exec(objectKey);
    if (parsed === null) {
      throw new Error(`refusing an object key this store did not mint: ${objectKey}`);
    }

    // The shard must be the digest's own first two characters. Without this check, one
    // recording could be written under 256 different keys that all pass the pattern, and
    // "the file exists" would stop meaning "these bytes are stored" - which is the
    // property the idempotent fast path in store() relies on.
    const [, shard, digest] = parsed;
    if (shard !== digest.slice(0, 2)) {
      throw new Error("refusing an object key whose shard does not match its digest");
    }

    const root = resolve(this.directory);
    const path = resolve(root, objectKey);

    if (path !== root && !path.startsWith(root + sep)) {
      throw new Error(`refusing an object key that resolves outside the media directory`);
    }

    return path;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw cause;
    }
  }

  /**
   * fsync on the directory descriptor, which is what persists a newly created name.
   *
   * Opened read-only: nothing here writes to the directory itself. What this does NOT
   * promise is that the drive flushed its own write cache - that needs F_FULLFSYNC on
   * macOS, which node exposes no API for. The kernel is asked for everything the platform
   * offers, and the remaining gap is the platform's.
   */
  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

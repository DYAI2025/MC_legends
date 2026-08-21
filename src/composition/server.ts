import { randomUUID } from "node:crypto";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { InMemoryRateLimiter } from "@/adapters/access/in-memory-rate-limiter";
import { FileAudioBlobStore } from "@/adapters/persistence/file-audio-blob-store";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import { PostgresSubmissionInboxStore } from "@/adapters/persistence/postgres-submission-inbox-store";
import type { FamilyAccessGate } from "@/application/access/family-access";
import type { AudioBlobStore } from "@/application/media/audio-blob-store";
import type { RateLimiter } from "@/application/access/rate-limiter";
import type { SubmissionInboxStore } from "@/application/submissions/submission-inbox-store";
import type { SubmissionInboxReader } from "@/application/submissions/submission-inbox-reader";

const DEFAULT_INBOX_DIRECTORY = ".data/inbox";
const DEFAULT_MEDIA_DIRECTORY = ".data/media";

/** 8 MiB. See audioMaxBytes below for why the number lives in three places. */
const DEFAULT_AUDIO_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Server-only composition root. Never import this from browser code - it resolves a
 * filesystem location and reads the family access secrets, and must stay out of the
 * client bundle. This module is the ONLY place in src that names those variables; an
 * architecture test pins that.
 *
 * A store is built per request. That is right for an append-only file, which holds no
 * connection, and it stays right for the PostgreSQL adapter: that adapter caches its
 * pool in a module-level Map keyed by connection string, so a store per request costs
 * an object and not a TCP connection.
 *
 * `||` rather than `??` on purpose: a host UI that defines AVALORIA_INBOX_DIR and
 * leaves it empty would otherwise hand `mkdir` an empty path, and every submission
 * would fail with 503 while the site and its health check still look fine.
 */
export function createSubmissionInboxStore(): SubmissionInboxStore {
  const url = databaseUrl();

  if (url !== null) {
    return new PostgresSubmissionInboxStore(url);
  }

  // Not a default and not dead code: this is MCL-48's rollback path, and it must stay
  // reachable. Removing the DATABASE_URL line from app.env and restarting returns the
  // app to the file store with the bind-mounted JSONL still in place - no code revert,
  // no redeploy of a different image, no schema drop. Rows already in PostgreSQL stay
  // in PostgreSQL.
  return new FileSubmissionInboxStore(
    process.env.AVALORIA_INBOX_DIR?.trim() || DEFAULT_INBOX_DIRECTORY,
  );
}

/**
 * The database connection string, or null when none is configured.
 *
 * Named here and nowhere else in src, which is what keeps the architecture rule intact:
 * this module is the only one allowed to read the environment, and an architecture test
 * pins that. The PostgreSQL adapter therefore takes its connection string as a
 * constructor argument, exactly as the file adapter takes its directory.
 *
 * `||` rather than `??`, for the same reason AVALORIA_INBOX_DIR uses it above: a host
 * that defines DATABASE_URL and leaves it empty has not configured a database. Treating
 * that as configured would hand the adapter an empty connection string, and pg would
 * quietly fall back to its own PG* environment defaults - a different database than
 * anyone chose, or none at all, with every submission failing 503 while the site and
 * /api/health both still look fine.
 *
 * Read per call rather than captured at module load, so a test can configure the
 * environment per case and a deployment that injects the variable late is seen without
 * a fresh module registry.
 */
export function databaseUrl(): string | null {
  return process.env.DATABASE_URL?.trim() || null;
}

/**
 * Where unchanged original recordings are written (MCL-49).
 *
 * `||` rather than `??`, for the third time in this module and for the same reason: a
 * host UI that defines AVALORIA_MEDIA_DIR and leaves it empty has not configured a
 * directory, and treating that as configured would hand `mkdir` an empty path while the
 * site and its health check still looked fine.
 *
 * Separate from AVALORIA_INBOX_DIR rather than a subdirectory of it. The inbox directory
 * is MCL-48's rollback artefact - a JSONL file that is read by an importer and must stay
 * small enough to reason about by eye. Recordings are megabytes and have a different
 * backup sizing, a different retention question and a different reason to exist. Putting
 * them under one path would mean one volume, one quota and one restore that has to
 * succeed for either to work.
 *
 * There is deliberately no PostgreSQL branch here. The recording never goes in the
 * database - that is the whole separation MCL-49 asks for - so unlike the inbox store
 * there is nothing for DATABASE_URL to select between.
 */
export function createAudioBlobStore(): AudioBlobStore {
  return new FileAudioBlobStore(
    process.env.AVALORIA_MEDIA_DIR?.trim() || DEFAULT_MEDIA_DIRECTORY,
  );
}

/**
 * The largest audio upload this server accepts, in bytes.
 *
 * 8 MiB, decided 2026-08-21. The number is enforced in three places that have to agree -
 * the reverse proxy in front of the app, the upload route, and a CHECK constraint in
 * migration 0002 - and each of them fails differently when they disagree: a proxy limit
 * below the app's turns a legitimate recording into an error the app never sees, and one
 * above it lets the app buffer bytes it is going to refuse.
 *
 * Overridable so a deployment can lower it without a release. Raising it past what the
 * database allows will be refused by the CHECK constraint, which is the intended order:
 * widening the ceiling is a migration, exactly as it is for the text length cap.
 */
export function audioMaxBytes(): number {
  return positiveInteger(process.env.AVALORIA_AUDIO_MAX_BYTES, DEFAULT_AUDIO_MAX_BYTES);
}

export function createReceiptId(): string {
  return randomUUID();
}

/**
 * The family access gate.
 *
 * Read per call rather than captured at module load, so a test can configure the
 * environment per case and so a deployment that injects the variable late does not
 * need a restart to be seen. The gate itself is cheap: two HMACs.
 *
 * An unset or blank access code produces a gate that answers `unavailable` to
 * everything. That is deliberate and is the whole point: a missing secret must close
 * the door, never open it.
 */
export function createFamilyAccessGate(): FamilyAccessGate {
  return new HmacFamilyAccessGate({
    accessCode: process.env.AVALORIA_FAMILY_ACCESS_CODE,
    sessionSecret: process.env.AVALORIA_SESSION_SECRET,
  });
}

/**
 * The admin access gate (MCL-50).
 *
 * A DIFFERENT secret from the family gate, not a different call to the same one. The
 * family access code is what the children hold in order to submit; if the protected
 * read verified against it, any child with that code could read every sibling's answers
 * - and the code would look correct, because it would be the same gate and the same
 * mechanism. The separation is the secret, and it has to live here, in the one module
 * allowed to name secrets at all.
 *
 * An unset or blank admin code produces a gate that answers `unavailable` to
 * everything, exactly as the family gate does. A missing secret closes the door.
 *
 * The session secret is shared with the family gate deliberately: it is signing
 * material, not an identity, and the identity is already separated by the access code.
 * Sharing it means one value to rotate rather than two to forget.
 *
 * This is an MVP boundary, not a role model. Jira MCL-50 puts the final production role
 * and consent policy explicitly out of scope; what is here is the narrowest reversible
 * thing that does not treat a child's write session as an adult's read authority.
 */
export function createAdminAccessGate(): FamilyAccessGate {
  const adminCode = process.env.AVALORIA_ADMIN_ACCESS_CODE?.trim() ?? "";
  const familyCode = process.env.AVALORIA_FAMILY_ACCESS_CODE?.trim() ?? "";

  // Setting both variables to the same value silently undoes the whole separation, so
  // that configuration is refused rather than served.
  //
  // WHY it undoes it: the two gates are the same HMAC construction over the same
  // SESSION_KEY_LABEL, and they share AVALORIA_SESSION_SECRET on purpose. The signing key
  // is therefore derived from (access code, session secret) - and if the access codes are
  // equal, the two keys are equal, which makes the two token families interchangeable. A
  // session minted by the family gate then verifies against the admin gate, and any child
  // holding the family code could read every sibling's answers. Measured: with identical
  // codes the admin gate answers `granted` to a family-minted token; with distinct codes
  // it answers `denied`.
  //
  // The structurally stronger fix is a per-audience domain label mixed into the
  // derivation, which would make the collision impossible instead of merely detected.
  // That changes MCL-34's token derivation and would invalidate every live family
  // session, so it is deliberately not done in this slice.
  //
  // Compared as trimmed plain strings, not as HMACs. The HMAC comparison in the gate
  // exists because the value on one side is caller-supplied; both values here are
  // server-side configuration that no request can influence, so there is no oracle to
  // protect against. Trimmed because HmacFamilyAccessGate trims what it is handed, which
  // makes two values differing only in surrounding whitespace the same secret.
  if (adminCode.length > 0 && adminCode === familyCode) {
    // A fixed string with no interpolation: neither code may reach a log.
    console.error(
      "admin access gate unavailable: the admin access code must differ from the family access code",
    );

    // Fails closed through the gate's own existing unavailable path rather than a new
    // sentinel, so this misconfiguration answers exactly as a missing admin code does:
    // 503 from /api/admin/session and from the protected inbox read. The FAMILY gate is
    // untouched - the children keep submitting.
    return new HmacFamilyAccessGate({
      accessCode: undefined,
      sessionSecret: process.env.AVALORIA_SESSION_SECRET,
    });
  }

  return new HmacFamilyAccessGate({
    accessCode: process.env.AVALORIA_ADMIN_ACCESS_CODE,
    sessionSecret: process.env.AVALORIA_SESSION_SECRET,
  });
}

/**
 * The read side of the inbox (MCL-50), chosen the same way the write side is.
 *
 * Same selection rule as createSubmissionInboxStore on purpose: whichever store the
 * writes are going to is the one the admin view must read from. Two independent rules
 * would eventually disagree, and the shape of that disagreement is an inbox that looks
 * empty while submissions are being accepted - the single most alarming and least
 * informative failure this feature could have.
 *
 * The file branch is not dead code for the same reason it is not dead on the write
 * side: it is MCL-48's rollback path.
 */
export function createSubmissionInboxReader(): SubmissionInboxReader {
  const url = databaseUrl();

  if (url !== null) {
    return new PostgresSubmissionInboxStore(url);
  }

  return new FileSubmissionInboxStore(
    process.env.AVALORIA_INBOX_DIR?.trim() || DEFAULT_INBOX_DIRECTORY,
  );
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Rate limiters are process-local state, so unlike the gate and the store they must
 * NOT be rebuilt per request - a fresh counter per call would count to one forever.
 * Created lazily so the configured limits are read at first use, which is what lets a
 * test set them before the first request.
 */
let protectedRouteLimiter: RateLimiter | null = null;
let familySessionLimiter: RateLimiter | null = null;
let globalFamilySessionLimiter: RateLimiter | null = null;
let adminRouteLimiter: RateLimiter | null = null;
let adminSessionLimiter: RateLimiter | null = null;
let globalAdminSessionLimiter: RateLimiter | null = null;

export function createProtectedRouteRateLimiter(): RateLimiter {
  protectedRouteLimiter ??= new InMemoryRateLimiter({
    limit: positiveInteger(process.env.AVALORIA_INBOX_RATE_LIMIT, 30),
    windowMs: positiveInteger(process.env.AVALORIA_INBOX_RATE_WINDOW_MS, 60_000),
  });
  return protectedRouteLimiter;
}

export function createFamilySessionRateLimiter(): RateLimiter {
  familySessionLimiter ??= new InMemoryRateLimiter({
    limit: positiveInteger(process.env.AVALORIA_SESSION_RATE_LIMIT, 20),
    windowMs: positiveInteger(process.env.AVALORIA_SESSION_RATE_WINDOW_MS, 60_000),
  });
  return familySessionLimiter;
}

/**
 * One bucket for every sign-in attempt this process sees, whatever the caller claims
 * to be.
 *
 * The per-caller limiter above is keyed by `x-forwarded-for` / `x-real-ip`, and those
 * headers are written by the caller. A limiter keyed only by them is a limiter the
 * attacker resets at will: a new value per guess is a new allowance per guess. This one
 * has a single constant key, so rotating a header buys nothing.
 *
 * Set well above what a household plausibly needs and well below what guessing a shared
 * code needs, and it is a ceiling on the whole process rather than fairness between
 * callers: a flood does slow down the family's own sign-in until the window passes.
 * That is the intended trade for a private family MVP, and it is still process-local -
 * two app instances allow this ceiling each.
 */
export function createGlobalFamilySessionRateLimiter(): RateLimiter {
  globalFamilySessionLimiter ??= new InMemoryRateLimiter({
    limit: positiveInteger(process.env.AVALORIA_SESSION_GLOBAL_RATE_LIMIT, 60),
    windowMs: positiveInteger(process.env.AVALORIA_SESSION_GLOBAL_RATE_WINDOW_MS, 60_000),
  });
  return globalFamilySessionLimiter;
}

/**
 * Drops the process-local counters. Exists for tests: they need a limiter that was
 * built from the limits the case just configured, and they must not inherit the
 * attempts of the case before them. Nothing in the running app calls this.
 */
/**
 * Its own bucket, not the family route's.
 *
 * Sharing one counter would let child submissions exhaust the admin view's allowance
 * and the other way round - and the admin read is the thing somebody reaches for when
 * they want to know what is going on, which is exactly when the write path is busiest.
 */
export function createAdminRouteRateLimiter(): RateLimiter {
  adminRouteLimiter ??= new InMemoryRateLimiter({
    limit: positiveInteger(process.env.AVALORIA_ADMIN_RATE_LIMIT, 60),
    windowMs: positiveInteger(process.env.AVALORIA_ADMIN_RATE_WINDOW_MS, 60_000),
  });
  return adminRouteLimiter;
}

/**
 * Sign-in attempts against the admin code, per caller.
 *
 * Its own bucket rather than the family route's: an admin sign-in and a child sign-in
 * are different secrets with different consequences, and a family sitting on their
 * allowance must not be able to lock an adult out of the inbox - nor the reverse.
 */
export function createAdminSessionRateLimiter(): RateLimiter {
  adminSessionLimiter ??= new InMemoryRateLimiter({
    limit: positiveInteger(process.env.AVALORIA_ADMIN_SESSION_RATE_LIMIT, 20),
    windowMs: positiveInteger(process.env.AVALORIA_ADMIN_SESSION_RATE_WINDOW_MS, 60_000),
  });
  return adminSessionLimiter;
}

/**
 * The ceiling on admin sign-in attempts for the whole process, whatever address each
 * attempt claims - the one a spoofed x-forwarded-for cannot reset. Set lower than the
 * family equivalent because far fewer people hold this code and guessing it is worth
 * more.
 */
export function createGlobalAdminSessionRateLimiter(): RateLimiter {
  globalAdminSessionLimiter ??= new InMemoryRateLimiter({
    limit: positiveInteger(process.env.AVALORIA_ADMIN_SESSION_GLOBAL_RATE_LIMIT, 30),
    windowMs: positiveInteger(process.env.AVALORIA_ADMIN_SESSION_GLOBAL_RATE_WINDOW_MS, 60_000),
  });
  return globalAdminSessionLimiter;
}

export function resetRateLimitersForTest(): void {
  protectedRouteLimiter = null;
  familySessionLimiter = null;
  globalFamilySessionLimiter = null;
  adminRouteLimiter = null;
  adminSessionLimiter = null;
  globalAdminSessionLimiter = null;
}

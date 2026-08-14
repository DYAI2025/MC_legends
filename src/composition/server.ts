import { randomUUID } from "node:crypto";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { InMemoryRateLimiter } from "@/adapters/access/in-memory-rate-limiter";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import { PostgresSubmissionInboxStore } from "@/adapters/persistence/postgres-submission-inbox-store";
import type { FamilyAccessGate } from "@/application/access/family-access";
import type { RateLimiter } from "@/application/access/rate-limiter";
import type { SubmissionInboxStore } from "@/application/submissions/submission-inbox-store";
import type { SubmissionInboxReader } from "@/application/submissions/submission-inbox-reader";

const DEFAULT_INBOX_DIRECTORY = ".data/inbox";

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

export function resetRateLimitersForTest(): void {
  protectedRouteLimiter = null;
  familySessionLimiter = null;
  globalFamilySessionLimiter = null;
  adminRouteLimiter = null;
}

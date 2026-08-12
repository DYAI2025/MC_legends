import { randomUUID } from "node:crypto";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { InMemoryRateLimiter } from "@/adapters/access/in-memory-rate-limiter";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import type { FamilyAccessGate } from "@/application/access/family-access";
import type { RateLimiter } from "@/application/access/rate-limiter";
import type { SubmissionInboxStore } from "@/application/submissions/submission-inbox-store";

const DEFAULT_INBOX_DIRECTORY = ".data/inbox";

/**
 * Server-only composition root. Never import this from browser code - it resolves a
 * filesystem location and reads the family access secrets, and must stay out of the
 * client bundle. This module is the ONLY place in src that names those variables; an
 * architecture test pins that.
 *
 * A store is built per request. That is right for an append-only file, which holds no
 * connection: a later database adapter must own its own pool internally rather than
 * being constructed per call from here.
 *
 * `||` rather than `??` on purpose: a host UI that defines AVALORIA_INBOX_DIR and
 * leaves it empty would otherwise hand `mkdir` an empty path, and every submission
 * would fail with 503 while the site and its health check still look fine.
 */
export function createSubmissionInboxStore(): SubmissionInboxStore {
  return new FileSubmissionInboxStore(
    process.env.AVALORIA_INBOX_DIR?.trim() || DEFAULT_INBOX_DIRECTORY,
  );
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
 * Drops the process-local counters. Exists for tests: they need a limiter that was
 * built from the limits the case just configured, and they must not inherit the
 * attempts of the case before them. Nothing in the running app calls this.
 */
export function resetRateLimitersForTest(): void {
  protectedRouteLimiter = null;
  familySessionLimiter = null;
}

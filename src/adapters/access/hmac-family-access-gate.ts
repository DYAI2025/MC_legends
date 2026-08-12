import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  FamilyAccessGate,
  SessionCheck,
  SessionGrant,
} from "@/application/access/family-access";

/**
 * Domain separation for the two HMAC uses below. Without distinct labels, a value
 * signed for one purpose could be presented as if it had been signed for the other.
 */
const SESSION_KEY_LABEL = "avaloria-family-session-v1";
const CODE_COMPARE_LABEL = "avaloria-access-code-compare-v1";

/** Version prefix, so a later token shape can be told apart instead of guessed at. */
const TOKEN_VERSION = "v1";

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

export type HmacFamilyAccessGateOptions = Readonly<{
  /** The server-only shared family code. Absent or blank means the gate is unusable. */
  accessCode: string | undefined;
  /** Optional signing secret. Derived from the access code when not configured. */
  sessionSecret?: string | undefined;
  ttlSeconds?: number;
  now?: () => number;
}>;

/**
 * Stateless session gate: the cookie carries an expiry and an HMAC over it, and the
 * server re-derives that HMAC to verify. No session store is involved, which is what
 * keeps this correct across restarts and across more than one process - the very
 * thing the in-memory rate limiter cannot claim.
 *
 * The signing key is derived from the configured secret rather than used directly, so
 * the raw secret is never the value being HMAC'd with, and rotating the access code
 * invalidates every session minted under the old one.
 */
export class HmacFamilyAccessGate implements FamilyAccessGate {
  private readonly configuredCode: string;
  private readonly sessionSecret: string;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(options: HmacFamilyAccessGateOptions) {
    this.configuredCode = options.accessCode?.trim() ?? "";
    this.sessionSecret = options.sessionSecret?.trim() ?? "";
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.now = options.now ?? Date.now;
  }

  openSession(submittedAccessCode: string): SessionGrant {
    if (!this.isConfigured()) {
      return { outcome: "unavailable" };
    }

    if (!this.matchesConfiguredCode(submittedAccessCode)) {
      return { outcome: "denied" };
    }

    const expiresAt = Math.floor(this.now() / 1000) + this.ttlSeconds;
    // A nonce so two sessions minted in the same second are not the same string. It
    // carries no meaning; it only keeps one family member's cookie from being byte
    // identical to another's.
    const payload = `${expiresAt}.${randomBytes(9).toString("base64url")}`;

    return {
      outcome: "granted",
      session: {
        value: `${TOKEN_VERSION}.${payload}.${this.sign(payload)}`,
        maxAgeSeconds: this.ttlSeconds,
      },
    };
  }

  verifySession(sessionValue: string | null): SessionCheck {
    if (!this.isConfigured()) {
      return { outcome: "unavailable" };
    }

    if (sessionValue === null || sessionValue.length === 0) {
      return { outcome: "denied" };
    }

    const parts = sessionValue.split(".");
    if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) {
      return { outcome: "denied" };
    }

    const [, expiresAtRaw, nonce, signature] = parts;
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isInteger(expiresAt)) {
      return { outcome: "denied" };
    }

    // Signature before expiry on purpose: the expiry is part of the signed payload, so
    // trusting it before checking the signature would be trusting a number the caller
    // could have written.
    if (!this.hasValidSignature(`${expiresAtRaw}.${nonce}`, signature)) {
      return { outcome: "denied" };
    }

    if (expiresAt * 1000 <= this.now()) {
      return { outcome: "denied" };
    }

    return { outcome: "granted" };
  }

  private isConfigured(): boolean {
    return this.configuredCode.length > 0;
  }

  private signingKey(): Buffer {
    const base = this.sessionSecret.length > 0 ? this.sessionSecret : this.configuredCode;
    return createHmac("sha256", base).update(SESSION_KEY_LABEL).digest();
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey()).update(payload, "utf8").digest("base64url");
  }

  private hasValidSignature(payload: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(payload), "utf8");
    const actual = Buffer.from(signature, "utf8");

    // timingSafeEqual throws on a length mismatch, and a tampered token is free to be
    // any length at all - so the lengths have to be compared first. Both sides are
    // fixed-length HMAC output in the honest case, so this leaks nothing about the key.
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /**
   * Compared as HMACs rather than as strings: both digests are 32 bytes whatever the
   * codes are, so neither the comparison time nor a length mismatch says anything
   * about the configured code.
   */
  private matchesConfiguredCode(submitted: string): boolean {
    const expected = createHmac("sha256", CODE_COMPARE_LABEL)
      .update(this.configuredCode, "utf8")
      .digest();
    const actual = createHmac("sha256", CODE_COMPARE_LABEL).update(submitted, "utf8").digest();

    return timingSafeEqual(expected, actual);
  }
}

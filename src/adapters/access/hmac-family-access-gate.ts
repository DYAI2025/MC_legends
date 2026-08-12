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

/**
 * Length-prefixed framing, so concatenating two configured values stays unambiguous:
 * the byte length is written before the value and the value cannot be misread as part
 * of the next field.
 */
function framed(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export type HmacFamilyAccessGateOptions = Readonly<{
  /** The server-only shared family code. Absent or blank means the gate is unusable. */
  accessCode: string | undefined;
  /**
   * Optional extra signing secret. It is mixed into the signing key alongside the
   * access code, never used instead of it: with it unset the key rests on the access
   * code alone, and with it set rotating either value still revokes every session.
   */
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
 * The signing key is derived from the whole configured secret material rather than from
 * one part of it, so rotating *either* the access code or the session secret invalidates
 * every session minted under the previous configuration. Neither value travels in the
 * token; only a domain-separated HMAC of the expiry and nonce does.
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

  /**
   * Derived from the access code AND the optional session secret together, never from
   * one instead of the other.
   *
   * Deriving from `sessionSecret || accessCode` looked equivalent and was not: with a
   * secret configured, rotating a leaked access code changed no key and revoked no
   * session. Both values now feed the key, so changing either one invalidates every
   * token minted before the change.
   *
   * Each field is length-prefixed before being concatenated, so a code/secret pair
   * cannot be shifted into another pair with the same key material - ("ab", "c") and
   * ("a", "bc") must not sign the same way.
   */
  private signingKey(): Buffer {
    const material = `${framed(this.configuredCode)}${framed(this.sessionSecret)}`;
    return createHmac("sha256", material).update(SESSION_KEY_LABEL).digest();
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

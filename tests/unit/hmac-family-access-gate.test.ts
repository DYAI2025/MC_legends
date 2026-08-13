import { describe, expect, it } from "vitest";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";

const ACCESS_CODE = "tal-der-lampen-4711";

/** A clock the test moves on purpose, so expiry is observed and never waited for. */
function gateAt(now: number, options: { accessCode?: string; sessionSecret?: string } = {}) {
  return new HmacFamilyAccessGate({
    accessCode: options.accessCode ?? ACCESS_CODE,
    sessionSecret: options.sessionSecret,
    ttlSeconds: 3600,
    now: () => now,
  });
}

function grantedSession(now: number, options: { accessCode?: string; sessionSecret?: string } = {}) {
  const grant = gateAt(now, options).openSession(options.accessCode ?? ACCESS_CODE);
  if (grant.outcome !== "granted") {
    throw new Error(`expected a granted session, got ${grant.outcome}`);
  }
  return grant.session;
}

describe("HmacFamilyAccessGate", () => {
  it("grants a session for the configured access code and accepts it back", () => {
    const now = Date.UTC(2026, 7, 12, 10, 0, 0);
    const session = grantedSession(now);

    expect(session.value.length).toBeGreaterThan(0);
    expect(session.maxAgeSeconds).toBe(3600);
    expect(gateAt(now).verifySession(session.value).outcome).toBe("granted");
  });

  it("never puts the access code or the signing secret into the session value", () => {
    const session = grantedSession(Date.UTC(2026, 7, 12), { sessionSecret: "signing-secret-xyz" });

    expect(session.value).not.toContain(ACCESS_CODE);
    expect(session.value).not.toContain("signing-secret-xyz");
  });

  it("mints a different value for every session", () => {
    const now = Date.UTC(2026, 7, 12);
    expect(grantedSession(now).value).not.toBe(grantedSession(now).value);
  });

  it("denies a wrong access code", () => {
    expect(gateAt(Date.UTC(2026, 7, 12)).openSession("tal-der-lampen-4712").outcome).toBe("denied");
  });

  it("denies an access code that is only a prefix of the configured one", () => {
    // A comparison that stopped at the shorter string would accept this.
    expect(gateAt(Date.UTC(2026, 7, 12)).openSession("tal-der-lampen").outcome).toBe("denied");
  });

  it("denies an empty access code", () => {
    expect(gateAt(Date.UTC(2026, 7, 12)).openSession("").outcome).toBe("denied");
  });

  it("reports itself unavailable when no access code is configured, and grants nothing", () => {
    for (const accessCode of [undefined, "", "   "]) {
      const gate = new HmacFamilyAccessGate({ accessCode });

      // Both directions: an unconfigured gate must not be talked into a session, and
      // must not accept one either - failing open in either direction is the bug.
      expect(gate.openSession("anything").outcome).toBe("unavailable");
      expect(gate.verifySession("v1.9999999999.nonce.signature").outcome).toBe("unavailable");
    }
  });

  it("denies a missing or empty session value", () => {
    const gate = gateAt(Date.UTC(2026, 7, 12));

    expect(gate.verifySession(null).outcome).toBe("denied");
    expect(gate.verifySession("").outcome).toBe("denied");
  });

  it("denies a session whose signature was tampered with", () => {
    const now = Date.UTC(2026, 7, 12);
    const session = grantedSession(now);
    const [version, expiresAt, nonce, signature] = session.value.split(".");

    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    expect(gateAt(now).verifySession(`${version}.${expiresAt}.${nonce}.${flipped}`).outcome).toBe(
      "denied",
    );
  });

  it("denies a session whose expiry was extended by hand", () => {
    const now = Date.UTC(2026, 7, 12);
    const session = grantedSession(now);
    const [version, expiresAt, nonce, signature] = session.value.split(".");
    const later = String(Number(expiresAt) + 100_000);

    // The expiry is inside the signed payload, so rewriting it invalidates the token.
    expect(later).not.toBe(expiresAt);
    expect(gateAt(now).verifySession(`${version}.${later}.${nonce}.${signature}`).outcome).toBe(
      "denied",
    );
  });

  it("denies a session after it expired", () => {
    const issuedAt = Date.UTC(2026, 7, 12, 10, 0, 0);
    const session = grantedSession(issuedAt);

    expect(gateAt(issuedAt + 3599_000).verifySession(session.value).outcome).toBe("granted");
    expect(gateAt(issuedAt + 3601_000).verifySession(session.value).outcome).toBe("denied");
  });

  it("denies a session that is not shaped like one at all", () => {
    const gate = gateAt(Date.UTC(2026, 7, 12));

    for (const value of ["", "abc", "v1.abc", "v2.1.2.3", "v1.notanumber.nonce.sig", "v1.1.2.3.4"]) {
      expect(gate.verifySession(value).outcome, `must deny ${JSON.stringify(value)}`).toBe("denied");
    }
  });

  it("denies a session minted under a different access code", () => {
    const now = Date.UTC(2026, 7, 12);
    const other = grantedSession(now, { accessCode: "ein-anderer-code-2200" });

    // Rotating the shared code has to invalidate what was handed out before it.
    expect(gateAt(now).verifySession(other.value).outcome).toBe("denied");
  });

  it("denies a session minted under a different signing secret", () => {
    const now = Date.UTC(2026, 7, 12);
    const other = grantedSession(now, { sessionSecret: "secret-a" });

    expect(gateAt(now, { sessionSecret: "secret-b" }).verifySession(other.value).outcome).toBe(
      "denied",
    );
  });

  it("denies a session minted under a rotated access code even when the signing secret is unchanged", () => {
    const now = Date.UTC(2026, 7, 12);
    const stale = grantedSession(now, {
      accessCode: "old-code-1234",
      sessionSecret: "stable-secret",
    });

    // The case that matters in a deployment: AVALORIA_SESSION_SECRET is set once and
    // left alone, and the shared code is rotated because it leaked. If the signing key
    // ignored the code whenever a secret was configured, rotating the code would revoke
    // nothing at all.
    const afterRotation = gateAt(now, {
      accessCode: "new-code-5678",
      sessionSecret: "stable-secret",
    });

    expect(afterRotation.verifySession(stale.value).outcome).toBe("denied");
  });

  it("keeps a session valid when neither the code nor the secret changed", () => {
    // The other side of the case above: the key derivation must be stable, not merely
    // different every time - otherwise the test above would pass for the wrong reason.
    const now = Date.UTC(2026, 7, 12);
    const session = grantedSession(now, {
      accessCode: "old-code-1234",
      sessionSecret: "stable-secret",
    });

    expect(
      gateAt(now, { accessCode: "old-code-1234", sessionSecret: "stable-secret" }).verifySession(
        session.value,
      ).outcome,
    ).toBe("granted");
  });

  it("does not let a code/secret split be shifted to produce the same signing key", () => {
    // ("ab", "c") and ("a", "bc") must not derive the same key: concatenating the two
    // configured values without unambiguous framing is how that happens.
    const now = Date.UTC(2026, 7, 12);
    const session = grantedSession(now, { accessCode: "ab", sessionSecret: "c" });

    expect(
      gateAt(now, { accessCode: "a", sessionSecret: "bc" }).verifySession(session.value).outcome,
    ).toBe("denied");
  });
});

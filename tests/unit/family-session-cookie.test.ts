import { describe, expect, it } from "vitest";
import {
  FAMILY_SESSION_COOKIE,
  familySessionSetCookie,
  isHttpsRequest,
  readFamilySessionCookie,
} from "@/adapters/http/family-session-cookie";

const session = { value: "v1.1786000000.nonce.signature", maxAgeSeconds: 2592000 };

function attributesOf(setCookie: string): string[] {
  return setCookie.split(";").map((part) => part.trim());
}

describe("readFamilySessionCookie", () => {
  it("reads the session out of a header that carries other cookies too", () => {
    expect(
      readFamilySessionCookie(`theme=dark; ${FAMILY_SESSION_COOKIE}=abc.def; locale=de`),
    ).toBe("abc.def");
  });

  it("returns null when the header is absent, unrelated or empty-valued", () => {
    expect(readFamilySessionCookie(null)).toBeNull();
    expect(readFamilySessionCookie("theme=dark")).toBeNull();
    expect(readFamilySessionCookie(`${FAMILY_SESSION_COOKIE}=`)).toBeNull();
    expect(readFamilySessionCookie("nonsense")).toBeNull();
  });

  it("does not match a cookie whose name merely ends with the session name", () => {
    expect(readFamilySessionCookie(`not_${FAMILY_SESSION_COOKIE}=abc`)).toBeNull();
  });
});

describe("familySessionSetCookie", () => {
  it("is HttpOnly, SameSite=Strict, path-wide and time-limited", () => {
    const attributes = attributesOf(familySessionSetCookie(session, false));

    expect(attributes).toContain(`${FAMILY_SESSION_COOKIE}=${session.value}`);
    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("SameSite=Strict");
    expect(attributes).toContain("Path=/");
    expect(attributes).toContain(`Max-Age=${session.maxAgeSeconds}`);
  });

  it("adds Secure for an HTTPS deployment and omits it for plain local http", () => {
    expect(attributesOf(familySessionSetCookie(session, true))).toContain("Secure");
    expect(attributesOf(familySessionSetCookie(session, false))).not.toContain("Secure");
  });
});

describe("isHttpsRequest", () => {
  function request(url: string, headers: Record<string, string> = {}): Request {
    return new Request(url, { headers });
  }

  it("trusts the forwarded protocol when a proxy terminated TLS", () => {
    expect(isHttpsRequest(request("http://app.internal/x", { "x-forwarded-proto": "https" }))).toBe(
      true,
    );
    // Several hops: the first entry is the one the browser spoke.
    expect(
      isHttpsRequest(request("http://app.internal/x", { "x-forwarded-proto": "https, http" })),
    ).toBe(true);
    expect(isHttpsRequest(request("https://app.example/x", { "x-forwarded-proto": "http" }))).toBe(
      false,
    );
  });

  it("falls back to the request URL when nothing was forwarded", () => {
    expect(isHttpsRequest(request("https://app.example/x"))).toBe(true);
    expect(isHttpsRequest(request("http://127.0.0.1:3000/x"))).toBe(false);
  });
});

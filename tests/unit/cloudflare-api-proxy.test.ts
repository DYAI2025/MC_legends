/**
 * MCL-63. Pins the Cloudflare /api/* forward.
 *
 * The Worker serves pages and assets; every /api request belongs to the VPS backend,
 * because that is the only process that can reach PostgreSQL (Unix socket, inside the
 * VPS boundary, per MCL-48). Nothing else in the suite exercises this file: it never
 * runs under `npm run build`, `npm run test:e2e` or the VPS runtime, so a regression in
 * it would otherwise be visible only in production.
 *
 * The failures pinned here are all silent ones - a request that still reaches the
 * backend but with the method, the body, the cookie or the forwarded-proto altered, or
 * a response whose Set-Cookie was rebuilt on the way back. Each of those keeps the site
 * "working" while breaking a session.
 */
import { describe, expect, it } from "vitest";
import {
  API_ORIGIN_UNCONFIGURED,
  isApiRequest,
  proxyApiRequest,
} from "../../cloudflare/api-proxy";

const ORIGIN = "https://srv1308064.hstgr.cloud:8443";

/** Captures the outgoing request instead of performing it. */
function recordingFetch(response: Response = new Response("ok")) {
  const seen: Request[] = [];
  return {
    seen,
    fetchImpl: async (request: Request) => {
      seen.push(request);
      return response;
    },
  };
}

describe("isApiRequest", () => {
  it("matches /api and everything below it", () => {
    expect(isApiRequest("/api")).toBe(true);
    expect(isApiRequest("/api/health")).toBe(true);
    expect(isApiRequest("/api/inbox/submissions")).toBe(true);
  });

  it("does not match a path that merely starts with the same letters", () => {
    // Without the trailing slash in the prefix, /apidocs would be forwarded to the VPS
    // and the page it belongs to would never render.
    expect(isApiRequest("/apidocs")).toBe(false);
    expect(isApiRequest("/")).toBe(false);
    expect(isApiRequest("/welt/some-idea")).toBe(false);
  });
});

describe("proxyApiRequest", () => {
  it("keeps the path and the query string byte-for-byte and swaps only the origin", async () => {
    const { seen, fetchImpl } = recordingFetch();

    await proxyApiRequest(
      new Request("https://legends.example/api/admin/inbox/submissions?status=RECEIVED&q=a%20b"),
      ORIGIN,
      fetchImpl,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      `${ORIGIN}/api/admin/inbox/submissions?status=RECEIVED&q=a%20b`,
    );
  });

  it("preserves the method and the exact body bytes", async () => {
    const { seen, fetchImpl } = recordingFetch();
    const body = JSON.stringify({ originalText: "Hallo  Welt\n" });

    await proxyApiRequest(
      new Request("https://legends.example/api/inbox/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      ORIGIN,
      fetchImpl,
    );

    expect(seen[0]!.method).toBe("POST");
    await expect(seen[0]!.text()).resolves.toBe(body);
  });

  it("forwards the headers the backend authenticates and parses with", async () => {
    const { seen, fetchImpl } = recordingFetch();

    await proxyApiRequest(
      new Request("https://legends.example/api/health", {
        headers: {
          cookie: "avaloria_family_session=v1.1.2.3",
          accept: "application/json",
          "content-type": "application/json",
        },
      }),
      ORIGIN,
      fetchImpl,
    );

    const forwarded = seen[0]!;
    expect(forwarded.headers.get("cookie")).toBe("avaloria_family_session=v1.1.2.3");
    expect(forwarded.headers.get("accept")).toBe("application/json");
    expect(forwarded.headers.get("content-type")).toBe("application/json");
  });

  it("states the original host and scheme, and does not forward the Cloudflare Host", async () => {
    const { seen, fetchImpl } = recordingFetch();

    await proxyApiRequest(
      new Request("https://legends.example/api/family/session", { method: "POST" }),
      ORIGIN,
      fetchImpl,
    );

    const forwarded = seen[0]!;
    // The VPS decides Secure on session cookies from this header. Dropping it would
    // silently hand a child an unprotected session cookie.
    expect(forwarded.headers.get("x-forwarded-proto")).toBe("https");
    expect(forwarded.headers.get("x-forwarded-host")).toBe("legends.example");
    // Not carried on the outgoing request, so the transport sets it from the target
    // origin. If the Cloudflare host survived here, the VPS would be asked to answer
    // for a name it does not serve.
    expect(forwarded.headers.get("host")).toBeNull();
  });

  it("passes the caller address on, so the per-address rate limiter still distinguishes callers", async () => {
    const { seen, fetchImpl } = recordingFetch();

    await proxyApiRequest(
      new Request("https://legends.example/api/family/session", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }),
      ORIGIN,
      fetchImpl,
    );

    expect(seen[0]!.headers.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("does not follow backend redirects itself", async () => {
    const { seen, fetchImpl } = recordingFetch();

    await proxyApiRequest(new Request("https://legends.example/api/health"), ORIGIN, fetchImpl);

    expect(seen[0]!.redirect).toBe("manual");
  });

  it("returns the backend response untouched, Set-Cookie included", async () => {
    const backend = new Response(JSON.stringify({ acknowledged: true }), {
      status: 201,
      headers: new Headers([
        ["content-type", "application/json"],
        ["set-cookie", "avaloria_family_session=v1.a; Path=/; HttpOnly; SameSite=Strict; Secure"],
      ]),
    });
    const { fetchImpl } = recordingFetch(backend);

    const response = await proxyApiRequest(
      new Request("https://legends.example/api/inbox/submissions", { method: "POST", body: "{}" }),
      ORIGIN,
      fetchImpl,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain("avaloria_family_session=v1.a");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    await expect(response.json()).resolves.toEqual({ acknowledged: true });
  });

  it("fails closed when no API origin is configured, rather than falling through to the local handlers", async () => {
    // Falling through would hand the request to the Next route handlers inside the
    // Worker - the one path the whole proxy exists to prevent.
    for (const origin of [undefined, "", "   "]) {
      const { seen, fetchImpl } = recordingFetch();

      const response = await proxyApiRequest(
        new Request("https://legends.example/api/inbox/submissions", { method: "POST", body: "{}" }),
        origin,
        fetchImpl,
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: API_ORIGIN_UNCONFIGURED });
      expect(seen).toHaveLength(0);
    }
  });
});

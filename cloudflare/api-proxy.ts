/**
 * MCL-63. The /api/* boundary of the Cloudflare deployment.
 *
 * The canonical architecture (MCL-48) puts PostgreSQL inside the VPS boundary, reached
 * over a Unix socket by the Node process that runs there. A Cloudflare Worker cannot
 * reach a Unix socket, and opening the database port to reach it over TCP is exactly
 * what MCL-48 forbids. So the Worker does not own the API at all: it forwards every
 * /api/* request to the VPS backend that already owns it, and serves only pages and
 * assets itself.
 *
 * Kept as a plain function taking its origin and its fetch so it can be tested without
 * a Worker runtime; cloudflare/worker.ts is the only caller and supplies both.
 */

/** Injected so tests can observe the outgoing request without a network. */
export type ProxyFetch = (request: Request) => Promise<Response>;

/**
 * Machine-readable, and the only body this function ever invents. Every other response
 * is the backend's own, returned untouched. Deliberately not German: this is an
 * operator-facing misconfiguration, and no child-facing surface renders it.
 */
export const API_ORIGIN_UNCONFIGURED = "api-origin-unconfigured";

/** Methods that must not carry a body, per fetch semantics. */
const BODILESS_METHODS = new Set(["GET", "HEAD"]);

export async function proxyApiRequest(
  request: Request,
  apiOrigin: string | undefined,
  fetchImpl: ProxyFetch = (forwarded) => fetch(forwarded),
): Promise<Response> {
  const origin = apiOrigin?.trim() ?? "";

  // Fails closed rather than falling through to the OpenNext handler. Falling through
  // would hand the request to the local Next route handlers inside the Worker, which is
  // the one path this whole file exists to prevent.
  if (origin.length === 0) {
    return Response.json({ error: API_ORIGIN_UNCONFIGURED }, { status: 503 });
  }

  const incoming = new URL(request.url);

  // pathname + search, not the whole URL: the path and query reach the backend exactly
  // as the browser wrote them, and only the origin changes.
  const target = new URL(`${incoming.pathname}${incoming.search}`, origin);

  const headers = new Headers(request.headers);

  // fetch sets Host for the target itself; forwarding the Cloudflare one would make the
  // backend answer for a name it is not serving.
  headers.delete("host");

  // The VPS decides whether to mark session cookies Secure from x-forwarded-proto, and
  // the browser's leg of this hop really is https - so this is a statement of fact, not
  // a hint. Getting it wrong would drop the Secure flag from a child's session cookie.
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-host", incoming.host);

  // The per-address rate limiters on the VPS key on x-forwarded-for / x-real-ip. Without
  // this every request would arrive with the same (or no) address and the per-address
  // bucket would stop distinguishing callers at all. cf-connecting-ip is written by
  // Cloudflare, not by the caller; the header it lands in stays as spoofable as it
  // already was, which is why the process-global limiters remain the real ceiling.
  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp !== null) {
    headers.set("x-forwarded-for", connectingIp);
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    // A backend redirect is the browser's business. Following it here would re-issue the
    // request from the Worker, losing the browser's cookie jar and turning a 302 into a
    // silently different security context.
    redirect: "manual",
  };

  if (!BODILESS_METHODS.has(request.method.toUpperCase())) {
    init.body = request.body;
    init.duplex = "half";
  }

  // Returned unmodified. Set-Cookie in particular must survive byte-for-byte: the family
  // and admin sessions are minted by the VPS, and rebuilding the response here is how a
  // multi-value Set-Cookie quietly becomes one.
  return fetchImpl(new Request(target, init));
}

/** Everything under /api, and `/api` itself - but not `/apidocs`. */
export function isApiRequest(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

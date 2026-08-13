/**
 * The body guards shared by every protected JSON endpoint.
 *
 * Extracted from the inbox route so a second endpoint cannot accidentally ship with a
 * weaker version of them: one implementation, one set of tests, both routes.
 */

/**
 * Required, so a cross-origin `text/plain` POST cannot reach a protected route as a
 * simple request without a preflight.
 */
export function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return (
    contentType !== null &&
    contentType.split(";")[0].trim().toLowerCase() === "application/json"
  );
}

/** False only when the client itself declares a body too large to accept. */
export function declaresAcceptableSize(request: Request, maxBodyBytes: number): boolean {
  const declared = request.headers.get("content-length");
  if (declared === null) {
    // No declared length means chunked framing. It is not refused here - an
    // intermediary may legitimately re-frame a request - but nothing is trusted
    // either: readBoundedBody caps what is actually read.
    return true;
  }

  const bytes = Number(declared);
  return Number.isInteger(bytes) && bytes >= 0 && bytes <= maxBodyBytes;
}

/**
 * Reads the body with a hard byte cap instead of buffering whatever arrives. Returns
 * null as soon as the cap is passed, so an oversized body is abandoned mid-stream and
 * never fully held in memory or handed to the parser.
 */
export async function readBoundedBody(
  request: Request,
  maxBodyBytes: number,
): Promise<string | null> {
  const stream = request.body;
  if (stream === null) {
    return null;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (received > maxBodyBytes) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Strict decoding: malformed UTF-8 must be refused, not silently replaced,
    // because the submitted text has to survive byte for byte.
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    return null;
  }
}

/**
 * Applies the content-type check, the declared-size check, the streaming byte cap and
 * strict UTF-8 decoding, then parses. Returns null for every kind of refusal, because
 * a caller that is being told "no" must not learn which guard said it.
 */
export async function readBoundedJson(
  request: Request,
  maxBodyBytes: number,
): Promise<unknown | null> {
  if (!hasJsonContentType(request) || !declaresAcceptableSize(request, maxBodyBytes)) {
    return null;
  }

  const text = await readBoundedBody(request, maxBodyBytes);
  if (text === null) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

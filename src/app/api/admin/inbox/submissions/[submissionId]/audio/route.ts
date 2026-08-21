import { guardAdminRequest } from "@/adapters/http/admin-request-guard";
import type { AudioInboxEntry } from "@/application/submissions/submission-inbox-reader";
import {
  createAdminAccessGate,
  createAdminRouteRateLimiter,
  createAudioBlobStore,
  createSubmissionInboxReader,
} from "@/composition/server";

/**
 * The one way to hear a recording (MCL-49).
 *
 * There is no public media URL anywhere in this application, and this route is what makes
 * that statement true rather than aspirational: the private directory is served by nothing
 * - no static route, no nginx location, no signed link - so the only path from a stored
 * file to a listener runs through the admin gate here.
 *
 * GET and nothing else. "No change to the original audio through the UI" is an acceptance
 * criterion, and the strongest form of it is for the mutation verbs not to exist rather
 * than to exist and refuse: Next.js answers 405 for a verb this module does not export, so
 * the absence is the enforcement, and a test pins it so a later edit cannot quietly
 * reintroduce a writer.
 *
 * The route takes a submission id and never an object key. The key is a filesystem path
 * fragment; a route that accepted one would be a way to ask this application for a file
 * instead of for a submission, however carefully the value were then checked.
 *
 * Both "no such submission" and "that one is a typed answer" answer 404. Telling them
 * apart would make this an existence oracle for submission ids, and the difference is of
 * no use to anybody entitled to be here - they came from the inbox listing, which already
 * told them which entries are recordings.
 */

type AdminAudioError = "unauthorized" | "too-many-requests" | "not-found" | "audio-unavailable";

/** Machine-readable codes only - never an object key, a path, a digest or a stack. */
function refuse(status: 401 | 404 | 429 | 503, error: AdminAudioError): Response {
  return Response.json({ error }, { status });
}

/**
 * The characters a filename in a Content-Disposition header may carry here.
 *
 * The name is built from the submission id and the STORED extension, so nothing a client
 * ever sent reaches it. That still leaves the id itself, which is a stored string and can
 * hold a quote or a semicolon - either of which would end the header value early and let
 * the rest of the id become a second parameter. Reduced rather than refused, because this
 * is a display detail: a browser's "save as" suggestion is not worth failing a playback
 * over, and the bytes are identified by the submission id in the listing regardless.
 *
 * The dot is NOT in the alphabet, and that is the part worth stating. Measured while
 * writing this: with `.` allowed, a submission id of `sub"; filename="evil.php` produced
 * `antwort-sub---filename--evil.php.webm` - one extension away from the multi-extension
 * shape that a host dispatching on any extension in the name will happily execute. The
 * stem has no need of a dot, the extension is appended from the store's own record, and
 * removing the character removes the whole class rather than the one example.
 */
function safeFilenameStem(submissionId: string): string {
  return submissionId.replaceAll(/[^A-Za-z0-9_-]/gu, "-");
}

/**
 * The response that carries the recording, and the four headers that make it inert.
 *
 * `content-type` is the type the database recorded at upload, when it had been checked
 * against the bytes' own container - never a type guessed here and never one a client
 * sent. `nosniff` stops the browser from going looking for a better idea than the one it
 * was given, which is the mechanism by which a stored file becomes executable content in
 * the first place. The CSP allows nothing at all and sandboxes what it allows, so even a
 * response that somehow rendered as a document could not fetch, script or navigate.
 * `private, no-store` keeps a child's recording out of every shared cache and off every
 * proxy's disk.
 */
function serve(entry: AudioInboxEntry, bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": entry.audio.mimeType,
      "content-length": String(entry.audio.sizeBytes),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="antwort-${safeFilenameStem(entry.submissionId)}.${entry.audio.extension}"`,
    },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ submissionId: string }> },
): Promise<Response> {
  // First, and from headers alone. An unauthorised caller must not be able to make this
  // server open a database connection, let alone read a file off the media volume.
  const access = guardAdminRequest(request, createAdminAccessGate(), createAdminRouteRateLimiter());

  if (access === "unavailable") {
    console.error("admin access gate unavailable: no admin access code configured");
    return refuse(503, "audio-unavailable");
  }

  if (access === "unauthorized") {
    return refuse(401, "unauthorized");
  }

  if (access === "rate-limited") {
    return refuse(429, "too-many-requests");
  }

  const { submissionId } = await context.params;

  let entry;
  try {
    entry = await createSubmissionInboxReader().find(submissionId);
  } catch (cause) {
    console.error("admin audio lookup failed", cause);
    return refuse(503, "audio-unavailable");
  }

  if (entry === null || entry.kind !== "audio") {
    return refuse(404, "not-found");
  }

  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await createAudioBlobStore().read(entry.audio.objectKey);
  } catch (cause) {
    // A throw here is not a missing file - `read` answers null for that. It is either an
    // I/O fault on the media volume or a key the blob store refuses to touch, which means
    // the row was written by something other than the upload route. Neither is a state the
    // caller can act on and neither may produce a body, so both get the same code and the
    // cause goes to the log where an operator can see which one it was.
    console.error("admin audio read failed", cause);
    return refuse(503, "audio-unavailable");
  }

  if (bytes === null) {
    // The row exists and the recording does not: a database restored without its media, or
    // a blob a future retention policy removed. A real state rather than a fault, so 404
    // rather than 503 - but logged, because a row pointing at nothing is something an
    // operator has to learn about from somewhere.
    console.error(
      `submission ${submissionId} references a recording the media store does not hold`,
    );
    return refuse(404, "not-found");
  }

  return serve(entry, bytes);
}

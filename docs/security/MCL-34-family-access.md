# MCL-34 - Family inbox access boundary

Status: implemented in this repository. Scope is the private family MVP only.
Jira: [MCL-34](https://dyai2026.atlassian.net/browse/MCL-34) - "[Security] Familien-Inbox und Backend-Zugänge absichern".
Confluence: "07 - Security, Privacy and Submission Integrity", "13 - Living World Platform Architecture and AI Governance".

This document separates what is implemented from what is not. Nothing here claims
production-grade privacy, consent, retention or account handling; those remain open
product decisions, as Confluence 07 states.

## What is protected

The text submission write path:

```
child's browser -> IndexedDB (local)
                -> POST /api/inbox/submissions   [protected]
                -> FileSubmissionInboxStore.appendIfAbsent
                -> receipt -> SERVER_ACKNOWLEDGED
```

Sign-in path:

```
family types the shared code
                -> POST /api/family/session      [rate limited]
                -> server compares against AVALORIA_FAMILY_ACCESS_CODE
                -> HttpOnly session cookie
```

## Auth and session model

- One shared **family access code**, held server-side in `AVALORIA_FAMILY_ACCESS_CODE`.
  This is not a user account system, and no per-person identity is created or stored.
- `POST /api/family/session` compares the submitted code with the configured one.
  The comparison runs over HMAC digests of both values, so it is constant-time and
  leaks neither the length nor a common prefix of the configured code.
- On success the server sets a session cookie:
  `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` 30 days, and `Secure` whenever the
  request arrived over HTTPS (`x-forwarded-proto` first, then the request URL - a proxy
  terminates TLS in the deployment, and local dev/browser tests run on plain http).
- The cookie value is `v1.<expiry>.<nonce>.<HMAC over expiry and nonce>`. It is
  **stateless**: verification re-derives the HMAC, so there is no session store to lose
  across restarts or to diverge across processes. The signing key is derived from
  `AVALORIA_SESSION_SECRET` when set, otherwise from the access code.
- Rotating the access code invalidates every session minted under the old one.

### Secret boundary

- The access code and the signing secret are named in exactly one file,
  `src/composition/server.ts`. An architecture test fails if any other file under
  `src/` mentions either variable, and a second test forbids `NEXT_PUBLIC_` anywhere
  in `src/`.
- `scripts/check-client-secrets.mjs` scans the built output (`.next/static`,
  `.next/server`) for the configured values after a build. It refuses to run when no
  secret is configured or when there is no build output, so it cannot report a vacuous
  pass.
- The browser never receives the code, the signing secret or a privileged token. It
  receives a session cookie it cannot even read, because the cookie is `HttpOnly`.
- No PostgreSQL credential exists in this codebase, and no database port is exposed to
  a browser. Persistence is still the append-only JSONL file from Sprint 2.

### Fail-closed behaviour

If `AVALORIA_FAMILY_ACCESS_CODE` is unset or blank:

- `POST /api/family/session` answers `503 gate-unavailable` - nobody can sign in;
- `POST /api/inbox/submissions` answers `503 inbox-unavailable` and writes nothing,
  **including for callers that already hold a previously valid cookie**;
- the page renders the sign-in panel rather than an answer form.

A missing secret closes the door. It never opens it.

## Where the boundary is enforced

`guardFamilyRequest` (`src/adapters/http/family-request-guard.ts`) is the single
server-side check, taking the gate and a rate limiter as arguments so the protected
read/admin flow of MCL-50 can reuse it unchanged.

It decides from request headers alone. An unauthenticated caller never causes the
server to read, decode or parse one byte of the request body - checked by a test that
asserts `request.bodyUsed === false` after a 401.

The page (`src/app/page.tsx`) is a server component that verifies the same session to
decide whether to render the answer form. That is a **rendering** decision, not the
boundary: a client that lied about it would only render a form whose every submission
is refused with 401.

## Rate limiting - and its honest limits

`InMemoryRateLimiter`, a sliding window held in the app process.

| Endpoint | Key | Default | Env override |
| --- | --- | --- | --- |
| `POST /api/family/session` | client address | 20 / 60s | `AVALORIA_SESSION_RATE_LIMIT`, `AVALORIA_SESSION_RATE_WINDOW_MS` |
| `POST /api/inbox/submissions` | client address + session fingerprint | 30 / 60s | `AVALORIA_INBOX_RATE_LIMIT`, `AVALORIA_INBOX_RATE_WINDOW_MS` |

This is an MVP abuse brake. It is **not** production-grade:

- **process-local** - two app instances each allow the full limit;
- **not distributed** - no shared store, no coordination;
- **reset by a restart** - every counter is forgotten;
- the client address comes from `x-forwarded-for` / `x-real-ip`, which a caller can
  spoof; behind an unknown proxy every caller can share one `unknown` bucket.

A refused attempt is not counted, so a blocked caller cannot push its own window
forward indefinitely.

## Idempotency - and its honest limits

`SubmissionInboxStore.append` became `appendIfAbsent`, returning either `stored: true`
or `stored: false` with the record already held.

- A repeated `submissionId` never produces a second JSONL line and never rewrites the
  stored original text, even when the retry carries different text.
- The route answers a repeat with **200** and the receipt that submission already has,
  so one `submissionId` can never carry two contradictory receipts. A first delivery
  answers 201.
- Within one process, writes to one inbox directory are serialised through a shared
  queue, so concurrent retries of the same id still produce exactly one line.

**Limit:** the file adapter's guarantee holds for a **single process**. Two processes
writing the same directory can both read "absent" before either appends. This is not
worked around here; the durable fix is a unique constraint on `submissionId` in the
PostgreSQL store of MCL-48. **PostgreSQL is not implemented in MCL-34.**

## Preserved from Sprint 2

Unchanged and still tested: JSON content-type requirement, `Content-Length` check,
streaming body cap (`MAX_BODY_BYTES` 16 KiB), per-field length limits, strict UTF-8
decoding, `createdAt` instant validation, server-side `kind`, server-minted receipt,
bare machine-readable error codes with no internal detail, `POST`-only surface.

The body guards now live in `src/adapters/http/bounded-json-body.ts` and are shared
with the sign-in route, so a second endpoint cannot ship a weaker copy of them.

## Failure paths

| Situation | Answer | Effect on the child's answer |
| --- | --- | --- |
| No session / forged session | 401 `unauthorized` | stays `LOCAL_ONLY`, retryable |
| Too many requests | 429 `too-many-requests` | stays `LOCAL_ONLY`, retryable |
| Gate not configured | 503 `inbox-unavailable` | stays `LOCAL_ONLY`, retryable |
| Store write fails | 503 `inbox-unavailable` | stays `LOCAL_ONLY`, retryable |
| Invalid payload | 400 `invalid-payload` | stays `LOCAL_ONLY` |
| Stored, first delivery | 201 + receipt | `SERVER_ACKNOWLEDGED` |
| Stored, repeat delivery | 200 + original receipt | `SERVER_ACKNOWLEDGED` |

No path produces a positive acknowledgement without a successful persistence, and no
failure discards the locally saved submission.

## Known limitations

1. A session that expires while the page is open makes the next delivery answer 401,
   which the browser adapter maps to `refused`. The child reads "das Projekt konnte sie
   diesmal nicht annehmen", the answer stays on the device, and the sign-in panel
   returns on the next page load. The wording is honest but not specific.
2. One shared code for the whole family: no per-person identity, no revocation of a
   single device, no sign-out endpoint.
3. Rate limiting and file-store idempotency are single-process, as described above.
4. No consent, retention, deletion or account policy is implemented or claimed.
5. There is still no read path for submissions - MCL-50 - so "no anonymous GET access"
   currently holds because no GET exists at all.

## Configuration

```bash
AVALORIA_FAMILY_ACCESS_CODE=<shared family code>   # required; without it nobody gets in
AVALORIA_SESSION_SECRET=<random string>            # optional; derived from the code if unset
AVALORIA_INBOX_DIR=.data/inbox                     # optional
AVALORIA_SESSION_RATE_LIMIT=20                     # optional
AVALORIA_SESSION_RATE_WINDOW_MS=60000              # optional
AVALORIA_INBOX_RATE_LIMIT=30                       # optional
AVALORIA_INBOX_RATE_WINDOW_MS=60000                # optional
```

See `.env.example`. No secret value belongs in the repository; these variables are
supplied by the run environment. Setting them on a deployment is out of scope for
MCL-34 and was not done as part of it.

# Security Policy

## Foundation rules

- Never commit credentials, API keys, service-role keys, access tokens, private certificates or real `.env` files.
- Browser code must never contain server/service credentials.
- Future server inbox reads must be authenticated; public unauthenticated listing is forbidden by the Jira architecture baseline.
- Future uploads must use an explicit MIME/extension allowlist and size limits and must reject executable HTML/script content.
- Original user submissions are source artifacts and must not be silently overwritten by transcription, normalization or AI interpretation.

## Implemented since this file was written

The two rules above about uploads and about authenticated reads are no longer future work.
Where they now live, so a reviewer can check them rather than take this file's word:

- **MIME and extension allowlist** — `AUDIO_MIME_EXTENSIONS` in
  `src/domain/media/audio-artifact.ts` (five types, one server-chosen extension each),
  mirrored by `submission_inbox_media_mime_known` and
  `submission_inbox_media_extension_known` in `db/migrations/0002_submission_audio.sql`.
  The declared `Content-Type` must equal what the bytes' own container says they are — an
  allowlist checked only against a header is an allowlist the client opts into.
- **Size limit** — 8 MiB, enforced in three places that must agree:
  `AVALORIA_AUDIO_MAX_BYTES`, the upload route's streaming cap, and
  `submission_inbox_media_size_bounded`. Documented in
  `docs/ops/MCL-49-audio-storage.md` §9, which also records that the reverse proxy's
  `client_max_body_size` is part of the same agreement.
- **No executable web content** — the stored extension comes from the domain table and
  never from a client filename; nothing serves the media directory over HTTP; playback
  goes through an admin-gated route that answers with `nosniff`, a `default-src 'none';
  sandbox` CSP and `private, no-store`.
- **Authenticated reads** — `guardAdminRequest` on `/api/admin/inbox/submissions` and on
  the playback route, behind `AVALORIA_ADMIN_ACCESS_CODE`, which must differ from the
  family code or the whole admin surface fails closed.

Still open, deliberately: **retention and deletion of stored recordings** is an
undecided product and privacy policy (`docs/ops/MCL-49-audio-storage.md` §6). No period
is defined and none is implemented.

## Reporting

Do not paste secrets into a public issue. Use the repository's private GitHub security reporting channel when configured, or contact the repository owner through an established private project channel.

## Scope note

This file's original scope note said the bootstrap did not yet implement authentication,
production storage or media upload. Authentication (MCL-34, MCL-50), production storage
(MCL-48) and the server side of media upload (MCL-49) have since landed; see the section
above. Supabase and a product-format loader remain unimplemented, and their threat models
are separate delivery decisions.

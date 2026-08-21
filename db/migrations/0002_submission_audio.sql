-- 0002_submission_audio.sql
-- Lets the inbox hold a spoken answer as well as a typed one (MCL-49).
--
-- The bytes are NOT here and must never be. The recording lives in the private file
-- store on the VPS; this table holds the reference and the metadata, which is the
-- separation MCL-49 asks for: PostgreSQL keeps structured operational data, the private
-- filesystem keeps unchanged original artefacts.

-- Migration 0001 pinned kind to 'text' so that the text lines already on disk could
-- never be confused with anything written later. This is the widening that field was
-- reserved for.
ALTER TABLE submission_inbox DROP CONSTRAINT submission_inbox_kind_known;
ALTER TABLE submission_inbox ADD CONSTRAINT submission_inbox_kind_known
  CHECK (kind IN ('text', 'audio'));

-- An audio answer has no text. Not "an empty text" - a spoken answer's original IS the
-- recording, and a zero-length string in this column would be indistinguishable from a
-- child who submitted nothing.
--
-- This does not weaken the text side: submission_inbox_kind_shape below makes
-- original_text mandatory again for exactly the rows that are text.
ALTER TABLE submission_inbox ALTER COLUMN original_text DROP NOT NULL;

ALTER TABLE submission_inbox
  ADD COLUMN media_object_key  text,
  ADD COLUMN media_mime_type   text,
  ADD COLUMN media_extension   text,
  ADD COLUMN media_size_bytes  bigint,
  ADD COLUMN media_sha256      text;

-- The invariant that makes the two kinds real rather than a label on a flat row.
--
-- Without it, "kind='audio' with a NULL media_object_key" is a storable value, and the
-- shape of that bug is a database row promising a recording that was never written -
-- a child told their answer arrived, pointing at nothing. The nullable columns above are
-- only nullable because this constraint decides per row which of them must be filled.
ALTER TABLE submission_inbox ADD CONSTRAINT submission_inbox_kind_shape CHECK (
  (
    kind = 'text'
    AND original_text IS NOT NULL
    AND media_object_key IS NULL
    AND media_mime_type IS NULL
    AND media_extension IS NULL
    AND media_size_bytes IS NULL
    AND media_sha256 IS NULL
  )
  OR (
    kind = 'audio'
    AND original_text IS NULL
    AND media_object_key IS NOT NULL
    AND media_mime_type IS NOT NULL
    AND media_extension IS NOT NULL
    AND media_size_bytes IS NOT NULL
    AND media_sha256 IS NOT NULL
  )
);

-- The allowlist, mirrored from AUDIO_MIME_EXTENSIONS in src/domain/media/audio-artifact.ts.
--
-- Duplicated here on purpose, for the same reason 0001 duplicated the length caps: the
-- upload route is not the only writer this table will ever have - an import, a manual
-- psql fix, a future admin tool - and the limits belong where durability does, so a
-- second writer cannot quietly widen them. Adding a format is a change in both places.
ALTER TABLE submission_inbox ADD CONSTRAINT submission_inbox_media_mime_known
  CHECK (media_mime_type IS NULL OR media_mime_type IN (
    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'
  ));

ALTER TABLE submission_inbox ADD CONSTRAINT submission_inbox_media_extension_known
  CHECK (media_extension IS NULL OR media_extension IN ('webm', 'ogg', 'm4a', 'mp3', 'wav'));

-- 64 lowercase hex characters and nothing else. The object key is derived from this
-- value, so a row that holds something else describes a file at a path the application
-- would refuse to build - and the mismatch would only be discovered when somebody tried
-- to play the recording back.
ALTER TABLE submission_inbox ADD CONSTRAINT submission_inbox_media_sha256_shape
  CHECK (media_sha256 IS NULL OR media_sha256 ~ '^[0-9a-f]{64}$');

-- The documented upload ceiling, decided 2026-08-21: 8 MiB.
--
-- Enforced in three places that must agree - the reverse proxy, the route, and here -
-- and this is the one that survives a redeploy with a stale proxy config. The upper
-- bound is a product decision and changing it is deliberately a migration, exactly as
-- the 4000-character text cap in 0001 is.
ALTER TABLE submission_inbox ADD CONSTRAINT submission_inbox_media_size_bounded
  CHECK (media_size_bytes IS NULL OR (media_size_bytes > 0 AND media_size_bytes <= 8388608));

-- Same identifier ceiling the other reference columns get in 0001. The keys this
-- application builds are 72 characters; the cap is loose so a longer shard or a longer
-- extension later is a code change and not a migration.
ALTER TABLE submission_inbox ADD CONSTRAINT submission_inbox_media_object_key_length
  CHECK (media_object_key IS NULL OR char_length(media_object_key) <= 200);

-- Deliberately NOT unique.
--
-- The object key is content-addressed: it is derived from the SHA-256 of the bytes, so
-- two children who submit the identical recording - one child sending the same voice memo
-- twice under two submissions, two siblings forwarding the same file - produce the same
-- key. That is the point of content addressing, and it is what makes a retry a
-- byte-identical rewrite instead of a second copy.
--
-- A UNIQUE constraint here would turn that into a refusal of the second child's answer,
-- and the refusal would look like a storage fault rather than like the deliberate
-- decision it was not. Idempotency is already owned by the submission_id PRIMARY KEY,
-- which is the identity that actually needs to be unique.
--
-- The consequence, recorded because it matters for deletion: object keys are shared, so
-- removing a submission row must NOT unconditionally delete its blob. Retention and
-- deletion remain an open product/privacy policy (MCL-49), and whatever it decides has to
-- account for this. No retention behaviour is implemented here.

-- 0001_submission_inbox.sql
-- Durable store for confirmed family submissions (MCL-48).
-- submission_id is the PRIMARY KEY, not a surrogate: idempotent re-delivery is a
-- property the port promises, and the database is the only place that can hold it
-- across concurrent requests and process crashes alike.

CREATE TABLE submission_inbox (
  submission_id text        PRIMARY KEY,
  kind          text        NOT NULL,
  question_id   text        NOT NULL,
  created_at    timestamptz NOT NULL,
  received_at   timestamptz NOT NULL,
  receipt_id    text        NOT NULL,
  -- Unchanged original text exactly as submitted. Never trimmed, never normalised.
  original_text text        NOT NULL,
  status        text        NOT NULL DEFAULT 'RECEIVED',
  inserted_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT submission_inbox_kind_known CHECK (kind IN ('text')),
  CONSTRAINT submission_inbox_status_known CHECK (status IN ('RECEIVED')),

  -- The other half of the promise the primary key makes. A receipt is what a child is
  -- told their answer arrived under; two submissions sharing one would make that
  -- reference ambiguous at exactly the moment somebody needs it to be exact.
  CONSTRAINT submission_inbox_receipt_id_unique UNIQUE (receipt_id),

  -- The POST route caps these lengths, but the route is not the only writer this table
  -- will ever have - the MCL-50 admin view, an import, a manual psql fix. The limits
  -- belong where durability does, so a second writer cannot quietly widen them. The
  -- numbers mirror src/app/api/inbox/submissions/route.ts; receipt_id is server-minted
  -- (a UUID today) and gets the same identifier ceiling rather than a tight one, so a
  -- longer receipt format later is a code change and not a migration.
  CONSTRAINT submission_inbox_submission_id_length CHECK (char_length(submission_id) <= 200),
  CONSTRAINT submission_inbox_question_id_length CHECK (char_length(question_id) <= 200),
  CONSTRAINT submission_inbox_receipt_id_length CHECK (char_length(receipt_id) <= 200),
  CONSTRAINT submission_inbox_original_text_length CHECK (char_length(original_text) <= 4000)
);

-- MCL-50 lists the whole inbox newest-first.
CREATE INDEX submission_inbox_received_at_idx ON submission_inbox (received_at DESC);
-- And filters by question, still newest-first. Composite rather than question_id alone:
-- one index then answers that query outright instead of handing back every submission
-- for a question to be sorted afterwards.
CREATE INDEX submission_inbox_question_recent_idx ON submission_inbox (question_id, received_at DESC);

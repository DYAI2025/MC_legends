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
  CONSTRAINT submission_inbox_status_known CHECK (status IN ('RECEIVED'))
);

-- MCL-50 lists the inbox newest-first and filters by question.
CREATE INDEX submission_inbox_received_at_idx ON submission_inbox (received_at DESC);
CREATE INDEX submission_inbox_question_id_idx ON submission_inbox (question_id);

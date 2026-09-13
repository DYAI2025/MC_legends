-- 0004_submission_reply.sql
-- What an adult wrote back to a child about one submission (MCL-74).
--
-- A SEPARATE append-only table, never a column on submission_inbox. AGENTS.md requires
-- the submitted original to stay an immutable source artifact, and a reply is a derived
-- one: written later, by somebody else, about the original. Putting it beside the
-- original would make "answering" a write to the row that holds a child's own words.
--
-- Append-only by construction, like question_lifecycle_event: there is no UPDATE path in
-- the adapter and no DELETE outside scripts/delete-submission.mjs. A correction is a new
-- reply, and the one the child already heard read aloud stays readable afterwards.
--
-- The author column is the seam MCL-76 needs and the reason this table is shaped for two
-- writers from the start. An LLM echo changes `author` to 'llm' and may use the
-- 'fallback' status; it does not change this schema, and nothing downstream has to learn
-- a second table.
--
-- Additive only: nothing in submission_inbox is altered, so a container that has never
-- heard of this table keeps accepting submissions, and rolling the application back
-- leaves these rows in place and unread.

CREATE TABLE submission_reply (
  reply_id       text        PRIMARY KEY,

  -- The foreign key is deliberate, and it is what makes a reply unable to outlive or
  -- precede the thing it answers. It also decides restore order: the inbox must be
  -- imported before the replies (see docs/ops/MCL-74-family-reply.md).
  submission_id  text        NOT NULL REFERENCES submission_inbox (submission_id),

  understood     text        NOT NULL,
  question       text        NOT NULL,

  -- Stored, not derived. A row that carries its own questionId can be read on its own -
  -- by an import, or by a person in psql - instead of only making sense to code that
  -- remembers the prefix convention. The CHECK below is what keeps the two in step.
  question_id    text        NOT NULL,

  author         text        NOT NULL,
  status         text        NOT NULL,

  -- When the application says the reply was written.
  created_at     timestamptz NOT NULL,
  -- When the database recorded it. Both, for the reason migration 0003 gives: the gap
  -- between them is the only way to notice an application clock that is wrong.
  recorded_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT submission_reply_author_known    CHECK (author IN ('human', 'llm')),
  CONSTRAINT submission_reply_status_known    CHECK (status IN ('ready', 'fallback')),

  -- The shape limits live here as well as in the domain, for the reason migration 0003
  -- states: the limits belong where durability does, so a second writer - an import, a
  -- manual psql fix - cannot quietly widen them past what a child's card can hold.
  CONSTRAINT submission_reply_understood_len  CHECK (char_length(understood) BETWEEN 1 AND 400),
  CONSTRAINT submission_reply_question_len    CHECK (char_length(question) BETWEEN 2 AND 200),

  -- Exactly one question, and it ends the sentence. The domain counts the question marks
  -- and this cannot; what it can do is refuse a "question" that never asks anything,
  -- which is the failure that would reach a child as a reply with nothing to answer.
  CONSTRAINT submission_reply_question_shape  CHECK (question LIKE '%?'),

  CONSTRAINT submission_reply_question_id     CHECK (question_id = 'reply:' || submission_id),
  CONSTRAINT submission_reply_id_length       CHECK (char_length(reply_id) <= 200)
);

-- The two hot reads. The first is the admin card asking for one submission's history;
-- the second is the child surface asking for the household's newest replies, which is a
-- DISTINCT ON over this order.
CREATE INDEX submission_reply_submission_recent_idx ON submission_reply (submission_id, created_at DESC);
CREATE INDEX submission_reply_recent_idx ON submission_reply (created_at DESC);

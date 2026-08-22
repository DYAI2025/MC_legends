-- 0003_question_lifecycle.sql
-- Durable record of questions being closed and reopened (MCL-35).
--
-- An event table, not a state table. "A closed question stays traceably archived" and
-- "reopening does not erase the close" are the same requirement read from two ends, and
-- an append-only log satisfies both by construction: there is no row to overwrite.
--
-- The question WORDING is not here and must not come here. It is content, it lives in
-- src/content/open-questions.ts, and it is reviewed and deployed like the rest of what
-- children read. This table holds only which of those questions is still being asked.
--
-- Additive only: nothing in submission_inbox is altered, so an older container that has
-- never heard of this table keeps working, and rolling the application back leaves the
-- rows in place and unread.

CREATE TABLE question_lifecycle_event (
  -- The store-wide total order, and the primary key. Rotation uses it to put a reopened
  -- question behind the ones that never left, so it has to be a value the database
  -- assigns rather than a timestamp the application supplies: two events can share a
  -- millisecond, and an application clock that steps backwards would reorder history.
  sequence       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  question_id    text        NOT NULL,

  -- This question's own change counter, starting at 0.
  --
  -- The UNIQUE constraint below is the whole concurrency mechanism, and the reason there
  -- is no advisory lock and no explicit transaction in the adapter: two callers who both
  -- read "revision 0 is the latest" and both try to write revision 1 collide on this
  -- index, one commits and the other gets a 23505 that the adapter reports as a stale
  -- caller. A lock would serialise the same outcome at a higher cost, and would also have
  -- to be remembered by every future writer.
  revision       integer     NOT NULL,

  action         text        NOT NULL,
  previous_state text        NOT NULL,
  next_state     text        NOT NULL,

  -- When the application says it happened.
  occurred_at    timestamptz NOT NULL,
  -- When the database recorded it. Both, because they answer different questions: the
  -- first is what the application believed, the second is what actually happened here -
  -- and the gap between them is the only way to notice an application clock that is
  -- wrong.
  recorded_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT question_lifecycle_revision_unique UNIQUE (question_id, revision),
  CONSTRAINT question_lifecycle_revision_nonnegative CHECK (revision >= 0),

  CONSTRAINT question_lifecycle_action_known CHECK (action IN ('closed', 'reopened')),
  CONSTRAINT question_lifecycle_previous_known CHECK (previous_state IN ('open', 'closed')),
  CONSTRAINT question_lifecycle_next_known CHECK (next_state IN ('open', 'closed')),

  -- An event that changed nothing is not an event. Without this, a caller confused about
  -- what it was looking at could write "closed a closed question", and the archive would
  -- record a decision nobody made.
  CONSTRAINT question_lifecycle_transition_real CHECK (previous_state <> next_state),

  -- The action and the state it produced have to agree, or history reads one way and
  -- derives another.
  CONSTRAINT question_lifecycle_action_matches CHECK (
    (action = 'closed' AND next_state = 'closed')
    OR (action = 'reopened' AND next_state = 'open')
  ),

  -- The same identifier ceiling submission_inbox.question_id gets in migration 0001. The
  -- limits belong where durability does, so a second writer - an import, a manual psql
  -- fix - cannot quietly widen them.
  CONSTRAINT question_lifecycle_question_id_length CHECK (char_length(question_id) <= 200)
);

-- No separate index on (question_id, revision): the UNIQUE constraint above already
-- creates one, and it is the index both hot queries use - the latest revision for one
-- question, and the newest state per question.

-- 074: saved playground sandbox conversations
--
-- ============================================================================
-- WHAT THIS IS FOR
-- ============================================================================
--
-- The v2 playground's sandbox chat is a scratch conversation against a
-- dry-run engine, and its client state was deliberately ephemeral - nothing
-- in the URL, nothing persisted, reload-to-reset as a feature. That holds
-- right up until a conversation is worth coming back to: getting a guest ten
-- turns deep costs ten runs at 15-45s each, and the only way to inspect the
-- eleventh turn the next morning was to type all ten again.
--
-- A row here is one saved sandbox conversation: the ordered turns, each with
-- the guest's message, the reply that came back, and - the part that makes
-- this worth storing at all - the PlaygroundSession snapshot that turn RAN
-- WITH. The playground's rewind already depends on that snapshot living on
-- the request ("every request carries the session snapshot it ran with, so no
-- replay of the prefix is needed", playground-client.tsx), so persisting it
-- is what makes "rerun from turn 6" cost one run instead of six.
--
-- ============================================================================
-- WHAT IS NOT IN HERE, AND WHY
-- ============================================================================
--
-- NO TurnTrace. The trace carries the whole composed prompt, the voice pack,
-- the rendered knowledge and the full graph render data - 50-100 KB a turn,
-- most of it reproducible by rerunning. Ruled 2026-10-06: store the replies
-- so the conversation reads back instantly, and let the inspector say "trace
-- not saved - rerun this turn to inspect" rather than carry a snapshot that
-- goes stale the moment the template or the graph moves. A restored turn
-- therefore has a reply and no trace, and the UI must show it as exactly
-- that; the one thing it may never do is synthesize a trace to fill the
-- panel.
--
-- NO sessionHistory. It is derivable from the turns themselves (the client
-- already computes it with sessionHistoryFromTurns), and a stored copy is a
-- second transcript that can disagree with the first. Rebuilt on load.
--
-- NO replay-mode turns. A replay is already reproducible from the guest's
-- real timeline, so saving one would persist a thing that is not lost.
--
-- ============================================================================
-- SHAPE AND ORDER
-- ============================================================================
--
-- `turns` is validated through lib/schemas/playground.ts, never raw SQL
-- paths. Admin writes validate strictly; the read degrades per-row to a
-- banner so one unparseable save cannot take out the picker (the admin
-- loader posture - degrade, do not 500).
--
-- `turn_count` is denormalized so the picker can show "7 turns" without
-- pulling every turns blob into the list query. Written by the same insert,
-- never maintained separately.
--
-- ADDITIVE, BUT THE DEPLOYED CODE READS IT - apply in Studio BEFORE merging.
-- The save button writes it and the picker selects it on first paint, so the
-- first request after merge fails without it.

begin;

create table playground_conversations (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  -- Operator-written label. Defaults in the UI to the first guest message,
  -- truncated; the cap is a display constraint, not a storage one.
  name text not null
    check (char_length(name) >= 1 and char_length(name) <= 120),
  -- Ordered oldest-first. Shape: PlaygroundConversationTurnSchema.
  turns jsonb not null,
  turn_count integer not null check (turn_count >= 0),
  -- The session the NEXT send would run with: what the last turn's assessor
  -- handed back. Each entry in `turns` carries the session that turn ran
  -- WITH, so the final output session has nowhere to live among them - and
  -- without it, typing a new message into a restored conversation would
  -- resume from the second-to-last state, losing the last turn's profile and
  -- memory updates silently. NULL when no turn produced one (every run
  -- failed, or the assessor errored on all of them), which restores as "no
  -- session" - the same thing a fresh chat starts with.
  next_session jsonb,
  -- set null, not cascade: an operator leaving must not delete the saved
  -- conversations the rest of the team is working from.
  created_by_operator_id uuid references operators(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The picker's only query: this venue's saves, newest first.
create index playground_conversations_venue_recency
  on playground_conversations (venue_id, created_at desc);

commit;

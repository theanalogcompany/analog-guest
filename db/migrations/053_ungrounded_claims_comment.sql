-- TAC-424: correct the comment on `messages.ungrounded_claims`, which now
-- describes a behaviour the code no longer has.
--
-- ----------------------------------------------------------------------------
-- WHY THIS IS ITS OWN MIGRATION
-- ----------------------------------------------------------------------------
-- Migration 039 applied a comment ending: "Caveat inherited from TAC-367: a
-- TRANSIENT verifier fault fails open and records as empty, not NULL." That
-- was true when it was written and is false as of TAC-424, which gave the
-- transient case its own `degraded` state, mapped it to NULL with the other
-- no-verdict outcomes, and held the draft instead of sending it.
--
-- The comment matters more than most: this column exists so a question can be
-- asked in SQL, and the comment is what someone reads first when they open the
-- column in Studio to ask it. Leaving it would have the artefact people check
-- against assert the exact belief the ticket was filed to remove. CLAUDE.md
-- records the same lesson under migration 046 — "the damage is not a runtime
-- bug, it is a false statement in the artefact people check against".
--
-- TAC-424's ruling 1 C said "no migration on `messages`", which is why the
-- code change shipped without one. This file is the operator's own call
-- (2026-09-21) that a catalogue-only statement is outside what that ruling
-- meant: `comment on` writes to pg_description, takes no lock worth naming,
-- rewrites no rows, and changes nothing any query plan or deployed code path
-- can observe.
--
-- ----------------------------------------------------------------------------
-- ORDERING: DOES NOT MATTER
-- ----------------------------------------------------------------------------
-- Nothing in this repo reads a column comment. `grep -rn "ungrounded_claims"`
-- finds app code reading the COLUMN, never its description, and `db:types`
-- does not surface comments. So this can be applied before or after the PR
-- merges, and it needs no `db/types.ts` regeneration.
--
-- Not on the high-stakes path in any meaningful sense despite naming
-- `messages`: there is no window in which a reader sees a different schema,
-- because the schema does not change.

comment on column messages.ungrounded_claims is
  'TAC-364, amended by TAC-424: verbatim claims flagged by the grounding '
  'verifier (lib/ai/verify-grounding.ts). Five outcomes, three stored values. '
  'A non-empty array is what the check flagged. EMPTY means the check RAN and '
  'found nothing, i.e. a genuine clean pass, and it is the only value that '
  'means that. NULL covers the three no-verdict cases, told apart by '
  'messages.review_triggers rather than by this column: the check DID NOT RUN '
  '(demo guest, or the model self-reported a knowledge gap, so neither '
  'grounding trigger is present); it ran and the output cap cut the verdict '
  'off unread (grounding_check_failed alone); or two immediate attempts both '
  'faulted (grounding_check_failed AND grounding_check_degraded). NULL also '
  'means the row predates TAC-364. The empty-vs-NULL distinction is deliberate '
  '- TAC-367 was filed because a silently-skipped grounding check was '
  'invisible everywhere, and this column is where that is now answerable. '
  'HISTORY, because it changes how old rows read: until TAC-424 a transient '
  'fault failed OPEN, sent the reply, and recorded EMPTY here - '
  'indistinguishable from a clean pass. Rows written before that ticket '
  'therefore cannot be trusted to mean "checked and clean" (ruling 3 A left '
  'them as they are). Since TAC-424 a transient fault is retried once and then '
  'holds the draft, so from that point EMPTY means what it says.';

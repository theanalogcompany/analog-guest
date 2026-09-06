-- 035_guest_intention_prompts.sql
-- TAC-324: first-touch intentions. Sana carries a small set of conversational
-- goals into a first-touch conversation with a guest she doesn't control
-- (e.g. "learn what they ordered," "invite them to save the number"). Whether
-- an intention is SATISFIED is always derived live from existing tables
-- (transactions, etc.) — never stored here, to avoid a second number that can
-- disagree with the source of truth. What can't be derived is whether Sana
-- already ASKED and the guest changed the subject, since that leaves no trace
-- anywhere else. This table is that one piece of stored state.
--
-- The unique constraint on (guest_id, intention_key) is the cap, enforced at
-- the database rather than in application logic: one prompt per intention per
-- guest, ever. A person does not re-ask what you ordered after you've moved
-- on. Recording is upsert-with-ignore (`on conflict do nothing` semantics at
-- the call site) rather than a plain insert, since concurrent near-simultaneous
-- sends raising the same intention should silently no-op on the second write,
-- not surface a 23505 the caller has to branch on.
--
-- Deliberately NOT engagement_events. That table is for guest actions that
-- affect relationship score (ENGAGEMENT_EVENT_WEIGHTS); Sana raising a topic
-- is not a guest action and must not silently move the recognition formula.
--
-- message_id is nullable + ON DELETE SET NULL: it's provenance (which send
-- raised this), not a foreign-key-required fact — the row's existence is what
-- matters for the cap, independent of whether the message row survives.
--
-- Additive, new table, not on the standing high-stakes list (messages /
-- engagement_events / voice_corpus). But per the guest_commitments (026) /
-- followup_log (029) precedent, deployed code both SELECTs and INSERTs into
-- this table immediately on the next inbound after deploy, so apply in Studio
-- BEFORE merging the PR, same reasoning as those two.
--
-- db/types.ts hand-patched in the same commit until `npm run db:types` runs
-- post-apply.

create table guest_intention_prompts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,
  intention_key text not null,
  message_id uuid references messages(id) on delete set null,
  prompted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (guest_id, intention_key)
);

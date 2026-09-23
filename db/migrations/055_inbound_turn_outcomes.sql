-- 055_inbound_turn_outcomes.sql
-- TAC-523: one row per inbound turn, saying what came of it.
--
-- WHY THIS EXISTS. Both webhooks hand an inbound to the agent with
-- `waitUntil(runInboundAgent(id))` and DISCARD the returned AgentResult.
-- Eighteen distinct paths can end a turn with no outbound row, and before
-- this table none of them wrote anything queryable: every record was a
-- console line, a PostHog event or a Slack post. From the database a
-- swallowed reply was indistinguishable from a message nobody answered.
-- The 2026-09-20 incident that opened the ticket was diagnosable only
-- because Vercel still held the runtime logs; a day later it would not
-- have been.
--
-- COMPLETE LEDGER, not a failure log (ruled 2026-09-23). Successes are
-- recorded too. A failure count without a denominator answers "what went
-- wrong" but not "how often does anything go wrong", and reconstructing the
-- denominator by joining back to `messages` is exactly the reconstruction
-- this table exists to stop.
--
-- WHAT COUNTS AS A TURN. A guest action that could have warranted a reply.
-- Deliberately NOT recorded, because they are not inbound turns and would
-- inflate the denominator: an Instagram echo (the venue's own message coming
-- back), a read receipt, a redelivery of an event already saved, and the
-- `unhandled` reasons that are not guest messages at all (reactions, message
-- edits, handover, comments, standalone referrals, a message the guest
-- unsent). Each is a DECISION in code rather than an omission — the total map
-- in lib/messaging/instagram/agent-gate.ts returns 'not_a_turn' for them and
-- `tsc` refuses to compile until a new outcome shape picks one.
--
-- The two `unhandled` reasons that ARE guest turns are recorded, under
-- 'message_unrenderable': `message_unsupported` (Meta could not render it — a
-- voice note, a sticker) and `message_no_content`. Both are guest messages
-- that reach us, are saved nowhere, and get no reply.
--
-- `skipped_duplicate` IS recorded (the agent ran twice for one inbound), so a
-- strict turn count excludes it:
--   select count(*) from inbound_turn_outcomes where outcome <> 'skipped_duplicate'
--
-- THIS IS NOT A FAILURE LOG. 'sent', 'queued' and 'silenced' are all normal
-- outcomes; 'silenced' in particular is a deliberate decision not to answer.
-- Reading a raw row count as "things that went wrong" is the misreading this
-- header exists to prevent.
--
-- VOLUME, measured 2026-09-23 so a future reader can re-judge it rather than
-- re-derive it: Le Mil's took 79 inbound messages in 7 days and 138 in 30
-- (~11/day, mostly test traffic); Mock Sextant 25 in 30 days; Central Perk
-- none. At ten venues with real traffic, an order of magnitude more per venue
-- puts the whole fleet at roughly 100-1,000 rows/day. No pruning strategy is
-- designed here and none is needed at that rate; revisit if the fleet grows
-- past it.
--
-- WHY A NEW TABLE rather than somewhere that exists:
--   - `audit_log` (migration 001, zero readers and zero writers to this day)
--     has no guest or message column and a free-text `action`, so the reason
--     vocabulary would live unenforced in `metadata` jsonb. AC 3 asks for a
--     STABLE query; an unenforced vocabulary cannot give one.
--   - a column on `messages` structurally cannot record the Sendblue bails,
--     which happen BEFORE the message row exists.
--   - `engagement_events` feeds ENGAGEMENT_EVENT_WEIGHTS, and a reply that
--     did not happen is not a guest action (the TAC-324 precedent).
--
-- The three identity columns are all NULLABLE and that is the design: a
-- Sendblue bail at "venue not found" has no venue, no guest and no message.
-- A record that required them could not describe the case it exists for.
--
-- But NULL means "not knowable here", never "not bothered". Code review caught
-- the webhook layer writing venue_id null for every `skipped` and `failed`
-- Instagram outcome, when only `venue_not_found` and a throw that escaped the
-- handler genuinely lack one — so a message_insert storm at a venue, the most
-- important population this table holds, was invisible to
-- `where venue_id = ...`, the headline read. InstagramEventOutcome now carries
-- the venue on both members and record-turn.ts passes it through.
--
-- `outbound_message_id` is `on delete set null`, NOT cascade: the Instagram
-- echo-fold path in lib/operator/dispatch-instagram-outbound.ts is the one
-- place in this repo that DELETEs a `messages` row, and cascading would take
-- the ledger entry with it.
--
-- No unique constraint, deliberately. Meta redelivers; a redelivery is a real
-- second event and the ledger should say so. Deduping would hide the retry
-- storms this exists to make visible.
--
-- The `reason` CHECK already carries the nine Sendblue bail reasons, which
-- nothing writes yet (TAC-523 PR 2 does, in a Sendblue webhook handler, which
-- is hard-stop work). Listing them now keeps PR 2 code-only.
--
-- ORDERING: additive, a new table only, but deployed code INSERTs into it on
-- the very next inbound after deploy, so apply in Studio BEFORE merging — the
-- call 026 / 029 / 035 all made on their own new tables.

begin;

-- Creating the FKs briefly takes a SHARE ROW EXCLUSIVE lock on each
-- referenced table. Instant at this size, but `messages` is on the live
-- webhook path, so fail fast rather than queue behind a long transaction.
set local lock_timeout = '5s';

create table inbound_turn_outcomes (
  id uuid primary key default gen_random_uuid(),

  -- all three nullable: see header
  venue_id uuid references venues(id) on delete cascade,
  guest_id uuid references guests(id) on delete cascade,
  inbound_message_id uuid references messages(id) on delete cascade,

  -- the row this turn produced, for outcome in ('sent','queued'). set null
  -- rather than cascade: the echo-fold path deletes messages rows.
  outbound_message_id uuid references messages(id) on delete set null,

  -- null for layer 'webhook': no agent run exists to correlate with.
  agent_run_id uuid,

  -- nullable: a run that fails at context_build may never resolve a channel.
  -- mirrors messages_channel_check (048); bound to MESSAGE_CHANNELS by
  -- lib/schemas/inbound-turn-outcome.test.ts.
  channel text check (channel in ('text', 'instagram')),

  -- which layer decided. 'webhook' = the agent was never invoked.
  layer text not null check (layer in ('webhook', 'agent')),

  outcome text not null check (outcome in (
    'sent',
    'queued',
    'not_run',
    'skipped_duplicate',
    'refused',
    'dropped',
    'superseded',
    -- TAC-397: the guest said "haha" and already holds a pending card, so
    -- nothing was generated and nothing sent. A DECISION, NOT A FAILURE.
    -- Recorded because a deliberate silence and a swallowed reply look
    -- identical from the database otherwise, which is what this table exists
    -- to fix -- but anyone counting failures must exclude it, the way
    -- 'sent' and 'queued' are excluded:
    --   select count(*) from inbound_turn_outcomes
    --   where outcome not in ('sent','queued','silenced','skipped_duplicate')
    'silenced',
    'failed'
  )),

  -- the sub-reason. null for outcomes that have none ('sent', 'queued',
  -- 'skipped_duplicate', 'superseded'). bound to INBOUND_TURN_REASONS.
  reason text check (reason in (
    -- layer 'webhook', Instagram (TAC-523 PR 1)
    'gate_shut',
    'titleless_postback',
    'event_not_persisted',
    -- a guest message Meta could not render, or with no text and no
    -- attachment. Saved nowhere, so invisible before this.
    'message_unrenderable',
    -- layer 'webhook', Sendblue (TAC-523 PR 2; nothing writes these yet)
    'venue_number_missing',
    'venue_lookup_failed',
    'venue_not_found',
    'guest_lookup_failed',
    'guest_insert_failed',
    'idempotency_lookup_failed',
    'duplicate_provider_message',
    'empty_inbound_content',
    'message_insert_failed',
    -- outcome 'refused'
    'low_fidelity',
    -- outcome 'dropped' (SlotDropReason, lib/agent/pending-slots.ts)
    'knowledge_gap_card_protected',
    'obligation_slot_taken',
    'slot_occupied',
    -- outcome 'failed' (AlertContext['stage'], lib/agent/alerts.ts)
    'context_build',
    'classification',
    'corpus',
    'generation',
    'persist',
    'send',
    'unexpected'
  )),

  -- non-PII specifics: triggers, error codes, a phone's last four. never a
  -- full phone number, never guest body text.
  detail jsonb not null default '{}',

  -- append-only; no updated_at, following followup_log (029).
  created_at timestamptz not null default now()
);

-- "what happened at this venue lately"
create index idx_inbound_turn_outcomes_venue on inbound_turn_outcomes (venue_id, created_at desc);
-- "how often does each outcome happen" — the AC 3 query
create index idx_inbound_turn_outcomes_outcome on inbound_turn_outcomes (outcome, created_at desc);
-- "what came of this specific inbound"
create index idx_inbound_turn_outcomes_inbound on inbound_turn_outcomes (inbound_message_id)
  where inbound_message_id is not null;

comment on table inbound_turn_outcomes is
  'TAC-523: one row per inbound turn, complete ledger including successes. A turn with no row here never reached a recorder; see the migration header for what is deliberately not a turn.';

commit;

-- rollback:
--   drop table if exists inbound_turn_outcomes;
-- Safe at any time. Nothing reads this table outside the recorder, and the
-- recorder never throws, so dropping it degrades to the pre-TAC-523 silence
-- rather than breaking a reply.

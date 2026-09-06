-- ============================================================================
-- migration 033: operator conversations list RPC
-- ============================================================================
-- Powers GET /api/operator/conversations (cross-repo sibling: analog-operator
-- Conversations tab). Returns one row per guest with any non-empty-body
-- message at one of the operator's allowed venues, most-recently-active
-- first, capped at 200 rows — same soft cap as list_operator_queue
-- (migration 018).
--
-- conversation_count / first_conversation_at are NOT stored facts — they're
-- computed here as "distinct venue-local calendar days with activity" per
-- the design spec (analog-operator's
-- docs/superpowers/specs/2026-09-05-conversations-tab-design.md). Recomputing
-- per request is fine at pilot scale; if this ever needs to be fast at
-- volume, materializing it is a follow-up.
--
-- agent_name: venue_configs.brand_persona->>'voiceName' if set, else the
-- venue's display name — same fallback documented on BrandPersonaSchema
-- (lib/schemas/brand-persona.ts).
--
-- recognition_state: guest_states row where exited_at IS NULL, scoped to
-- BOTH guest_id and venue_id (a guest can in principle appear at more than
-- one venue). Same source as list_operator_queue. Uses LATERAL to pick the
-- most recent open state as a defensive tiebreaker against non-transactional
-- write gaps (matching list_operator_queue's own guard in migration 018).
--
-- Column citations (same sources list_operator_queue's own comment cites):
--   guests         — first_name, last_name, phone_number. db/types.ts.
--   guest_states   — guest_id, venue_id, state, entered_at, exited_at. db/types.ts.
--   venues         — slug, name, timezone. db/types.ts.
--   venue_configs  — venue_id, brand_persona (jsonb). db/types.ts:1254.
--   messages       — venue_id, guest_id, direction, body, created_at.

create or replace function public.list_operator_conversations(
  venue_ids uuid[]
)
returns table(
  guest_id uuid,
  venue_id uuid,
  venue_slug text,
  venue_timezone text,
  agent_name text,
  guest_first_name text,
  guest_last_name text,
  guest_phone text,
  recognition_state text,
  last_message_at timestamptz,
  last_message_direction text,
  last_message_body text,
  conversation_count bigint,
  first_conversation_at timestamptz
)
language sql
stable
as $function$
  with scoped_messages as (
    select m.venue_id, m.guest_id, m.direction, m.body, m.created_at
    from messages m
    where m.venue_id = any(venue_ids)
      and m.body <> ''
  ),
  last_message as (
    select distinct on (guest_id, venue_id)
      guest_id, venue_id, direction, body, created_at
    from scoped_messages
    order by guest_id, venue_id, created_at desc
  ),
  conversation_days as (
    select
      sm.guest_id,
      sm.venue_id,
      count(distinct date_trunc('day', sm.created_at at time zone coalesce(v.timezone, 'UTC'))) as day_count,
      min(sm.created_at) as first_at
    from scoped_messages sm
    join venues v on v.id = sm.venue_id
    group by sm.guest_id, sm.venue_id
  )
  select
    lm.guest_id,
    lm.venue_id,
    v.slug as venue_slug,
    v.timezone as venue_timezone,
    coalesce(vc.brand_persona ->> 'voiceName', v.name) as agent_name,
    g.first_name as guest_first_name,
    g.last_name as guest_last_name,
    g.phone_number as guest_phone,
    gs.state as recognition_state,
    lm.created_at as last_message_at,
    lm.direction as last_message_direction,
    lm.body as last_message_body,
    cd.day_count as conversation_count,
    cd.first_at as first_conversation_at
  from last_message lm
  join venues v on v.id = lm.venue_id
  join guests g on g.id = lm.guest_id
  join conversation_days cd
    on cd.guest_id = lm.guest_id and cd.venue_id = lm.venue_id
  left join venue_configs vc on vc.venue_id = lm.venue_id
  left join lateral (
    -- guest_states is a transition log. Pick the open segment (exited_at
    -- IS NULL); order by entered_at desc as a defensive tiebreaker for
    -- the one-open-row-per-(guest,venue) invariant. If a guest has no open
    -- state, the LATERAL returns 0 rows → gs.state = NULL.
    select state
    from guest_states gs2
    where gs2.guest_id = lm.guest_id
      and gs2.venue_id = lm.venue_id
      and gs2.exited_at is null
    order by gs2.entered_at desc
    limit 1
  ) gs on true
  order by lm.created_at desc
  limit 200;
$function$;

-- ============================================================================
-- end of migration
-- ============================================================================

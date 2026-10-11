-- 080: guest attachments get their own rows, a private bucket, and a way
-- onto the conversations list (TAC-582).
--
-- WHAT WAS WRONG. `messages.media_urls` kept an attachment's link and threw
-- its type away, and Instagram's links expire. So nothing could say whether a
-- guest sent a photo or a voice note, the operator thread hid every message
-- with no text, and the "Sent an attachment with no text" card pointed at
-- nothing anyone could open.
--
-- WHAT THIS ADDS.
--   A. `messages.unsupported_content`: a message Meta flags `is_unsupported`
--      now gets a row, and this is the only thing that row carries.
--   B. One more arm on `messages_has_content`. Changes nothing; see block B.
--   C. `message_attachments`: one row per attachment, with its kind, where it
--      came from, and where the re-hosted copy lives.
--   D. A backfill of the media rows that existed on the day (11).
--   E. `list_operator_conversations` learns to include media-only rows when
--      asked, and returns which message its preview came from.
--   F. `messages` in the realtime publication with full replica identity.
--      Live for months, in no migration until now.
--   G. The private `guest-media` bucket.
--
-- HARD STOP: this file names `messages`, so `db:apply` refuses it. Applied in
-- Supabase Studio on 2026-10-11, BEFORE the code that reads it merged. Every
-- statement is additive or a loosening and the deployed code kept working
-- against it.
--
-- LIVE CHECKS, 2026-10-11, before writing this:
--   pg_get_constraintdef(messages_has_content) =
--     CHECK (((body <> ''::text) OR (array_length(media_urls, 1) > 0)
--             OR (reaction_type IS NOT NULL)))
--   pg_publication_tables: supabase_realtime already held public.messages and
--     public.guest_commitments. relreplident on messages was 'f'.
--   storage.buckets: public-assets (public), scenario-runs (private).
--   pg_get_functiondef(list_operator_conversations(uuid[])) matched migration
--     056's body, not 043's. No explicit grants on it, so none to re-issue.
--   14 rows had no body, no media and no reaction. See block B.
--
-- NO DEFAULT ON `kind` OR `status`. Postgres does not validate a column
-- default against that column's own CHECK (migration 046 is where that cost
-- us), so every writer names both.
--
-- RLS IS ON WITH NO POLICY. `messages` is readable with the publishable key
-- today (THE-110). This table holds provider links and storage paths and does
-- not inherit that. Every reader is the service role, which bypasses RLS.
--
-- `expired` IS IN THE STATUS CHECK AND NOTHING WRITES IT. A story link's
-- expiry is derived at read time (lib/messaging/attachments/serve.ts). The
-- value is permitted so a later sweep needs no migration.
--
-- THE BUCKET IS NOT REMOVED BY SQL. Deleting from storage.buckets or
-- storage.objects leaves the files behind; use the Storage API or the UI.
--
-- ROLLBACK. Runnable as-is once uncommented. Only before code that reads the
-- new objects is deployed. The publication and replica identity are left
-- alone: both were live before this file. The function body is migration
-- 056's, lines 431-580, verbatim (diffed: zero lines differ).
--
--   begin;
--
--   set local lock_timeout = '5s';
--
--   lock table messages in access exclusive mode;
--
--   drop function if exists public.list_operator_conversations(uuid[], boolean);
--
--   create function public.list_operator_conversations(venue_ids uuid[])
--   returns table(
--     guest_id uuid,
--     venue_id uuid,
--     venue_slug text,
--     venue_timezone text,
--     agent_name text,
--     guest_first_name text,
--     guest_last_name text,
--     guest_phone text,
--     recognition_state text,
--     last_message_at timestamptz,
--     last_message_direction text,
--     last_message_body text,
--     conversation_count bigint,
--     first_conversation_at timestamptz,
--     guest_has_instagram_id boolean,
--     instagram_username text,
--     last_inbound_channel text,
--     last_guest_action_at timestamptz
--   )
--   language sql
--   stable
--   as $function$
--     with scoped_messages as (
--       select
--         m.venue_id,
--         m.guest_id,
--         m.direction,
--         m.body,
--         m.created_at,
--         (
--           m.direction = 'inbound'
--           or (m.review_state is distinct from 'pending'
--               and m.status in ('sending', 'sent', 'delivered'))
--         ) as reached_guest
--       from messages m
--       where m.venue_id = any(venue_ids)
--         and m.body <> ''
--     ),
--     guest_reach as (
--       -- Whether each guest has ANY message that reached them. It decides which
--       -- rows that guest's fields are computed from.
--       select sm.guest_id, sm.venue_id, bool_or(sm.reached_guest) as any_reached
--       from scoped_messages sm
--       group by sm.guest_id, sm.venue_id
--     ),
--     counted_messages as (
--       select sm.*
--       from scoped_messages sm
--       join guest_reach gr
--         on gr.guest_id = sm.guest_id and gr.venue_id = sm.venue_id
--       where sm.reached_guest or not gr.any_reached
--     ),
--     last_message as (
--       select distinct on (guest_id, venue_id)
--         guest_id, venue_id, direction, body, created_at, reached_guest
--       from counted_messages
--       order by guest_id, venue_id, created_at desc
--     ),
--     conversation_days as (
--       select
--         cm.guest_id,
--         cm.venue_id,
--         count(distinct date_trunc('day', cm.created_at at time zone coalesce(v.timezone, 'UTC'))) as day_count,
--         min(cm.created_at) as first_at
--       from counted_messages cm
--       join venues v on v.id = cm.venue_id
--       group by cm.guest_id, cm.venue_id
--     )
--     select
--       lm.guest_id,
--       lm.venue_id,
--       v.slug as venue_slug,
--       v.timezone as venue_timezone,
--       coalesce(vc.brand_persona ->> 'voiceName', v.name) as agent_name,
--       g.first_name as guest_first_name,
--       g.last_name as guest_last_name,
--       g.phone_number as guest_phone,
--       gs.state as recognition_state,
--       lm.created_at as last_message_at,
--       lm.direction as last_message_direction,
--       -- TAC-395: a guest no message has reached keeps their row, with no preview.
--       case when lm.reached_guest then lm.body else '' end as last_message_body,
--       cd.day_count as conversation_count,
--       cd.first_at as first_conversation_at,
--       -- TAC-473: the three inputs resolveConversationChannel needs, plus the
--       -- handle and the window anchor. `guest_phone` above is the fourth input.
--       (g.instagram_scoped_id is not null) as guest_has_instagram_id,
--       g.instagram_username,
--       inbound_channel.last_inbound_channel,
--       window_anchor.last_guest_action_at
--     from last_message lm
--     join venues v on v.id = lm.venue_id
--     join guests g on g.id = lm.guest_id
--     join conversation_days cd
--       on cd.guest_id = lm.guest_id and cd.venue_id = lm.venue_id
--     left join venue_configs vc on vc.venue_id = lm.venue_id
--     left join lateral (
--       -- guest_states is a transition log. Pick the open segment (exited_at
--       -- IS NULL); order by entered_at desc as a defensive tiebreaker for
--       -- the one-open-row-per-(guest,venue) invariant. If a guest has no open
--       -- state, the LATERAL returns 0 rows → gs.state = NULL.
--       select state
--       from guest_states gs2
--       where gs2.guest_id = lm.guest_id
--         and gs2.venue_id = lm.venue_id
--         and gs2.exited_at is null
--       order by gs2.entered_at desc
--       limit 1
--     ) gs on true
--     left join lateral (
--       -- TAC-473: the channel of this guest's newest inbound, whatever it is.
--       --
--       -- MIRRORS loadLastInboundChannel (lib/agent/last-inbound-channel.ts):
--       -- direction='inbound', newest by created_at, no channel filter. It is read
--       -- only for a guest who has BOTH identifiers, which is how
--       -- resolveConversationChannel decides which conversation they are actually
--       -- in. NULL when the guest has never sent anything, which falls back to the
--       -- phone number exactly as it did before TAC-469.
--       --
--       -- created_at, not provider_sent_at: this asks WHICH channel was most
--       -- recent, across both, and a Sendblue row has no provider_sent_at at all,
--       -- so ordering on it would make every text inbound invisible here.
--       select ic.channel as last_inbound_channel
--       from messages ic
--       where ic.venue_id = lm.venue_id
--         and ic.guest_id = lm.guest_id
--         and ic.direction = 'inbound'
--       order by ic.created_at desc
--       limit 1
--     ) inbound_channel on true
--     left join lateral (
--       -- TAC-473: the newest Instagram inbound carrying Meta's own timestamp.
--       -- Identical to list_operator_queue's lateral above and to
--       -- loadLastGuestActionAt, for the same reason: one deadline, computed the
--       -- same way wherever it is shown.
--       select max(w.provider_sent_at) as last_guest_action_at
--       from messages w
--       where w.venue_id = lm.venue_id
--         and w.guest_id = lm.guest_id
--         and w.direction = 'inbound'
--         and w.channel = 'instagram'
--         and w.provider_sent_at is not null
--     ) window_anchor on true
--     order by lm.created_at desc
--     limit 200;
--   $function$;
--
--   drop table message_attachments;
--
--   alter table messages drop constraint messages_has_content;
--   alter table messages add constraint messages_has_content check (
--     body <> '' or array_length(media_urls, 1) > 0 or reaction_type is not null
--   );
--
--   alter table messages drop column unsupported_content;
--
--   notify pgrst, 'reload schema';
--
--   commit;
--
--   Then delete the `guest-media` bucket in the Storage UI.

begin;

set local lock_timeout = '5s';

-- messages first, before anything that touches guests or venues.
lock table messages in access exclusive mode;

-- A. Unsupported marker. Nullable, no default: a metadata-only change.
alter table messages add column unsupported_content boolean;

-- B. Applied as written in the plan, before the ruling that dropped it, so it
--    is recorded here: this file must describe the live schema. It is
--    BEHAVIOURALLY INERT. The array_length() arm is NULL for an empty array,
--    so the check evaluates to NULL (which passes) for a row with no body and
--    no media, exactly as it did before, and an unsupported row needed no new
--    arm to be legal. Blank cards and scan rows depend on that.
alter table messages drop constraint messages_has_content;
alter table messages add constraint messages_has_content check (
  body <> ''
  or array_length(media_urls, 1) > 0
  or reaction_type is not null
  or unsupported_content is true
);

-- C. One row per attachment.
create table message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,
  position integer not null,
  kind text not null
    constraint message_attachments_kind_check check (kind in (
      'image', 'gif', 'video', 'audio', 'file', 'share',
      'story_mention', 'story_reply', 'unknown'
    )),
  status text not null
    constraint message_attachments_status_check check (status in (
      'pending', 'ready', 'link_only', 'expired', 'failed'
    )),
  provider_type text,
  provider_url text,
  storage_path text,
  mime_type text,
  byte_size bigint,
  title text,
  link_url text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_attachments_message_position_unique
    unique (message_id, position),
  constraint message_attachments_ready_has_source
    check (status <> 'ready' or storage_path is not null or provider_url is not null)
);

create index idx_message_attachments_venue_guest
  on message_attachments (venue_id, guest_id);
create index idx_message_attachments_pending
  on message_attachments (created_at) where status = 'pending';

create trigger trg_message_attachments_updated_at
  before update on message_attachments
  for each row execute function set_updated_at();

-- Deny-all to the publishable key. Every reader is the service role, which
-- bypasses this. No policy is created.
alter table message_attachments enable row level security;

-- D. Backfill the existing media rows (11 on 2026-10-11) so no reader needs
--    a fallback. Lookaside links go in as 'pending' with kind 'unknown'; the
--    re-host script settles both from the download.
insert into message_attachments
  (message_id, venue_id, guest_id, position, kind, status,
   provider_url, mime_type, link_url)
select
  m.id, m.venue_id, m.guest_id, (u.ord - 1)::integer,
  case
    when u.url ~* '^https?://[^/]*giphy\.com/' then 'gif'
    when u.url ~* '^https?://(www\.)?instagram\.com/' then 'share'
    else 'unknown'
  end,
  case
    when u.url ~* '^https?://[^/]*giphy\.com/' then 'ready'
    when u.url ~* '^https?://(www\.)?instagram\.com/' then 'link_only'
    else 'pending'
  end,
  u.url,
  case when u.url ~* '^https?://[^/]*giphy\.com/' then 'image/gif' end,
  case when u.url ~* '^https?://(www\.)?instagram\.com/' then u.url end
from messages m
cross join lateral unnest(m.media_urls) with ordinality as u(url, ord)
where cardinality(m.media_urls) > 0
on conflict (message_id, position) do nothing;

-- E. Conversations RPC. DROP + CREATE because the return table changes. Body
--    restated from migration 056 with five changes: the include_media
--    parameter and its filter in scoped_messages, id and unsupported carried
--    through scoped_messages and last_message, and two new return columns.
--    Two long TAC-473 comments inside the laterals are shortened; that is the
--    text that was applied, and prosrc on production hashes to this body.
--
--    include_media DEFAULTS TO FALSE, so the old call shape
--    rpc('list_operator_conversations', { venue_ids }) resolves to this
--    function and returns what it always did. That is what makes this file
--    apply-before-merge safe.
drop function if exists public.list_operator_conversations(uuid[]);

create function public.list_operator_conversations(
  venue_ids uuid[],
  include_media boolean default false
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
  first_conversation_at timestamptz,
  guest_has_instagram_id boolean,
  instagram_username text,
  last_inbound_channel text,
  last_guest_action_at timestamptz,
  last_message_id uuid,
  last_message_unsupported boolean
)
language sql
stable
as $function$
  with scoped_messages as (
    select
      m.id,
      m.venue_id,
      m.guest_id,
      m.direction,
      m.body,
      m.created_at,
      (m.unsupported_content is true) as unsupported,
      (
        m.direction = 'inbound'
        or (m.review_state is distinct from 'pending'
            and m.status in ('sending', 'sent', 'delivered'))
      ) as reached_guest
    from messages m
    where m.venue_id = any(venue_ids)
      and (
        m.body <> ''
        or (include_media
            and (cardinality(m.media_urls) > 0
                 or m.unsupported_content is true))
      )
  ),
  guest_reach as (
    -- Whether each guest has ANY message that reached them. It decides which
    -- rows that guest's fields are computed from.
    select sm.guest_id, sm.venue_id, bool_or(sm.reached_guest) as any_reached
    from scoped_messages sm
    group by sm.guest_id, sm.venue_id
  ),
  counted_messages as (
    select sm.*
    from scoped_messages sm
    join guest_reach gr
      on gr.guest_id = sm.guest_id and gr.venue_id = sm.venue_id
    where sm.reached_guest or not gr.any_reached
  ),
  last_message as (
    select distinct on (guest_id, venue_id)
      id, guest_id, venue_id, direction, body, created_at, unsupported,
      reached_guest
    from counted_messages
    order by guest_id, venue_id, created_at desc
  ),
  conversation_days as (
    select
      cm.guest_id,
      cm.venue_id,
      count(distinct date_trunc('day', cm.created_at at time zone coalesce(v.timezone, 'UTC'))) as day_count,
      min(cm.created_at) as first_at
    from counted_messages cm
    join venues v on v.id = cm.venue_id
    group by cm.guest_id, cm.venue_id
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
    -- TAC-395: a guest no message has reached keeps their row, with no preview.
    case when lm.reached_guest then lm.body else '' end as last_message_body,
    cd.day_count as conversation_count,
    cd.first_at as first_conversation_at,
    -- TAC-473: the three inputs resolveConversationChannel needs, plus the
    -- handle and the window anchor. `guest_phone` above is the fourth input.
    (g.instagram_scoped_id is not null) as guest_has_instagram_id,
    g.instagram_username,
    inbound_channel.last_inbound_channel,
    window_anchor.last_guest_action_at,
    -- TAC-582: NULL for a guest no message has reached, for the same reason
    -- the body is blanked above: an unreached row has no preview to label.
    case when lm.reached_guest then lm.id end as last_message_id,
    (lm.reached_guest and lm.unsupported) as last_message_unsupported
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
  left join lateral (
    -- TAC-473: the channel of this guest's newest inbound, whatever it is.
    -- MIRRORS loadLastInboundChannel (lib/agent/last-inbound-channel.ts).
    select ic.channel as last_inbound_channel
    from messages ic
    where ic.venue_id = lm.venue_id
      and ic.guest_id = lm.guest_id
      and ic.direction = 'inbound'
    order by ic.created_at desc
    limit 1
  ) inbound_channel on true
  left join lateral (
    -- TAC-473: the newest Instagram inbound carrying Meta's own timestamp.
    select max(w.provider_sent_at) as last_guest_action_at
    from messages w
    where w.venue_id = lm.venue_id
      and w.guest_id = lm.guest_id
      and w.direction = 'inbound'
      and w.channel = 'instagram'
      and w.provider_sent_at is not null
  ) window_anchor on true
  order by lm.created_at desc
  limit 200;
$function$;

-- F. Realtime. Both are live already and absent from migrations, so both are
--    guarded: a bare ADD TABLE errors on a table that is already a member.
--    The replica identity guard was added to this file AFTER the Studio
--    apply (owner ruling, 2026-10-11). It is a no-op on production, where
--    relreplident was already 'f'; it exists so a database built from these
--    files ends up where production is.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if (select c.relreplident from pg_class c
      where c.oid = 'public.messages'::regclass) <> 'f' then
    alter table public.messages replica identity full;
  end if;
end
$$;

-- G. Private bucket. 26214400 bytes = 25 MB, the same cap the code applies.
insert into storage.buckets (id, name, public, file_size_limit)
values ('guest-media', 'guest-media', false, 26214400)
on conflict (id) do nothing;

notify pgrst, 'reload schema';

commit;

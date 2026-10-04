-- 067: relationship engine v2 - graphs, templates, profiles, states, judgments
--
-- The storage layer for the v2 relationship engine
-- (docs/decisions/0009-relationship-engine-v2.md, lib/relationship/CLAUDE.md).
-- Five new tables, nothing else touched:
--
--   relationship_graphs       versioned per-venue state/move graphs (JSONB
--                             validated by lib/relationship/schema.ts)
--   prompt_templates          versioned prompt templates; venue_id NULL is the
--                             global default a venue inherits until it diverges
--   guest_profiles            one row per guest per venue: typed-ish `profile`
--                             JSONB (name, home base, usual order + open facts
--                             list) and `memory` JSONB (the interaction ledger:
--                             what was asked/suggested and what came of it).
--                             Maintained by the post-turn assessor.
--   guest_relationship_states v2 successor of guest_states: which graph state
--                             the guest is in, who decided (deterministic
--                             predicate, assessor, or operator) and on what
--                             evidence. One OPEN row per guest per venue.
--   eval_judgments            one row per judged response: the maitre d'
--                             judge's axes with explanations, plus the graph/
--                             prompt/judge versions that produced it, so
--                             variant comparison is a query.
--
-- PURELY ADDITIVE WITH NO READER YET - apply order against the deploy does
-- not matter. The v1 tables (guest_states, guest_intention_prompts,
-- venue_configs.intention_rules / state_thresholds) are NOT dropped here:
-- v1 code still reads them until the v2 flag flips per venue; the drop is the
-- phase 6 cleanup migration, deployed-code-first.
--
-- eval_judgments.message_id deliberately carries NO foreign key: an FK to
-- `messages` would take a lock on a high-stakes table for zero integrity
-- benefit (judgments are observational; a dangling id is harmless and the
-- playground judges drafts that never become message rows at all).
--
-- The single-active-version indexes use the coalesce-sentinel pattern from
-- migrations 041/054: prompt_templates.venue_id is nullable (NULL = global
-- default) and NULLs are distinct in a unique index, so a bare column would
-- let two global defaults go active at once.

begin;

create table relationship_graphs (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  version integer not null,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'retired')),
  graph jsonb not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (venue_id, version)
);

create unique index relationship_graphs_one_active_per_venue
  on relationship_graphs (venue_id)
  where status = 'active';

create table prompt_templates (
  id uuid primary key default gen_random_uuid(),
  -- NULL venue_id = the global default template.
  venue_id uuid references venues(id) on delete cascade,
  version integer not null,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'retired')),
  template text not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

create unique index prompt_templates_version_per_scope
  on prompt_templates (
    coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid),
    version
  );

create unique index prompt_templates_one_active_per_scope
  on prompt_templates (
    coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'active';

create table guest_profiles (
  guest_id uuid not null references guests(id) on delete cascade,
  venue_id uuid not null references venues(id) on delete cascade,
  profile jsonb not null default '{}'::jsonb,
  memory jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (guest_id, venue_id)
);

create table guest_relationship_states (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references guests(id) on delete cascade,
  venue_id uuid not null references venues(id) on delete cascade,
  graph_version integer not null,
  state_key text not null,
  entered_at timestamptz not null default now(),
  exited_at timestamptz,
  decided_by text not null
    check (decided_by in ('deterministic', 'assessor', 'operator')),
  evidence jsonb not null default '[]'::jsonb
);

create unique index guest_relationship_states_one_open
  on guest_relationship_states (guest_id, venue_id)
  where exited_at is null;

create index guest_relationship_states_history
  on guest_relationship_states (guest_id, venue_id, entered_at desc);

create table eval_judgments (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  guest_id uuid references guests(id) on delete set null,
  -- No FK: see header.
  message_id uuid,
  source text not null
    check (source in ('production', 'playground', 'harness')),
  judge_version text not null,
  prompt_version text,
  graph_version integer,
  -- Per-axis {score, explanation, evidence[], ...}. The axis SET is owned
  -- by lib/eval/judge.ts and versioned by judge_version - deliberately not
  -- enumerated here, because the contract moved once before this migration
  -- was even applied. Read only through lib/eval's schema.
  axes jsonb not null,
  created_at timestamptz not null default now()
);

create index eval_judgments_by_venue_time
  on eval_judgments (venue_id, created_at desc);

create index eval_judgments_by_message
  on eval_judgments (message_id)
  where message_id is not null;

commit;

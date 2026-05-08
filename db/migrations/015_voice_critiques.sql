-- ============================================================================
-- migration 015: voice_critiques + find_similar_critiques RPC
-- ============================================================================
-- Persistence layer for the Voices command-center critique → regen → commit
-- loop. Every committed critique lands here regardless of `kind`; the
-- pattern-detection cluster query filters to `kind = 'edit_only'` at read
-- time so converting an edit_only critique into a rule (kind change) doesn't
-- require row re-shaping.
--
-- Embedding stored on the row directly (vector(1024), voyage-3-large).
-- Critiques are short and not chunked, so no separate _embeddings table —
-- distinct from voice_corpus / voice_embeddings which split because corpus
-- entries chunk for retrieval.
--
-- Resolution lifecycle: promoted_at OR dismissed_at marks the critique as
-- resolved. The cluster query excludes resolved rows so a promoted cluster
-- doesn't keep firing the banner. The partial index makes the
-- "unresolved at this venue" query a fast single-index scan.
-- ============================================================================

create extension if not exists vector;

create table voice_critiques (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  critique_text text not null,
  kind text not null check (kind in ('edit_only', 'edit_and_rule')),
  embedding vector(1024) not null,
  promoted_at timestamptz,
  dismissed_at timestamptz,
  created_by_operator_id uuid references operators(id),
  created_at timestamptz not null default now()
);

-- "Unresolved edit_only at this venue" is the hot query. Partial index
-- keeps it tight — promoted/dismissed rows fall out of the index.
create index idx_voice_critiques_venue_unresolved
  on voice_critiques (venue_id)
  where promoted_at is null and dismissed_at is null;

-- HNSW + cosine for the same access pattern voice_embeddings + match_voice_corpus
-- already use.
create index idx_voice_critiques_embedding
  on voice_critiques
  using hnsw (embedding vector_cosine_ops);

-- ============================================================================
-- rpc: find_similar_critiques
-- ============================================================================
-- Cosine search restricted to UNRESOLVED edit_only critiques in a single
-- venue. The caller passes the just-committed critique's id in `exclude_id`
-- so the result set never contains the row itself — keeps the off-by-one
-- bookkeeping out of the route handler.
--
-- similarity_threshold is enforced inside the function (1 - cosine_distance
-- >= threshold). match_count is a safety cap; the threshold does the real
-- filtering at venue scale.
-- ============================================================================

create or replace function find_similar_critiques(
  query_venue_id uuid,
  query_embedding vector(1024),
  exclude_id uuid default null,
  similarity_threshold float default 0.85,
  match_count int default 20
)
returns table (
  id uuid,
  message_id uuid,
  critique_text text,
  similarity float
)
language sql stable as $$
  select
    vc.id,
    vc.message_id,
    vc.critique_text,
    1 - (vc.embedding <=> query_embedding) as similarity
  from voice_critiques vc
  where vc.venue_id = query_venue_id
    and vc.kind = 'edit_only'
    and vc.promoted_at is null
    and vc.dismissed_at is null
    and (exclude_id is null or vc.id <> exclude_id)
    and 1 - (vc.embedding <=> query_embedding) >= similarity_threshold
  order by vc.embedding <=> query_embedding
  limit match_count;
$$;

-- ============================================================================
-- end of migration
-- ============================================================================

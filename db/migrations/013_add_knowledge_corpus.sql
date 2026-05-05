-- ============================================================================
-- migration 013: knowledge_corpus + knowledge_embeddings + match_knowledge_corpus
-- ============================================================================
-- Captures schema already applied to the live Supabase DB via Studio. This
-- file is for version control + fresh-environment replay.
--
-- Separates topical "what is true about this venue" content (origin story,
-- sourcing detail, staff personalities, mechanic explanations) from voice
-- exemplars (style examples for how the host texts). voice_corpus stays as-is
-- and continues to drive style retrieval; knowledge_corpus stores narrative
-- content that grounds agent responses to substantive guest questions.
--
-- Both tables mirror voice_corpus / voice_embeddings: same column shapes,
-- vector(1024) dim (voyage-3-large), HNSW + cosine index. The new RPC mirrors
-- match_voice_corpus with two additions:
--   1. tag_filter param — knowledge entries are topic-tagged (sourcing,
--      staff_rayan, ceremony, etc.) in a way voice exemplars aren't.
--   2. tags returned in the result row so the agent knows which topic was
--      matched.
-- ============================================================================

-- ============================================================================
-- table: knowledge_corpus
-- canonical narrative knowledge entries (origin story, sourcing detail,
-- staff personalities, mechanic explanations) for retrieval when grounding
-- agent responses to guest questions. sibling to voice_corpus, which stores
-- style exemplars rather than topical content.
-- ============================================================================

create table knowledge_corpus (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  source_type text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  language text not null default 'en',
  confidence_score numeric not null default 0.85,
  tags text[] not null default '{}',
  is_processed boolean not null default false,
  processed_at timestamptz,
  schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  added_by_operator_id uuid references operators(id),
  source_ref text
);

-- ============================================================================
-- table: knowledge_embeddings
-- vector chunks per knowledge_corpus row. mirrors voice_embeddings exactly:
-- dimension 1024 (voyage-3-large), nullable to support insert-then-async-embed
-- pattern, retrieval_count + last_retrieved_at for analytics.
-- ============================================================================

create table knowledge_embeddings (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  corpus_id uuid not null references knowledge_corpus(id) on delete cascade,
  chunk_text text not null,
  chunk_index integer not null default 0,
  embedding vector(1024),
  embedding_model text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  retrieval_count integer not null default 0,
  last_retrieved_at timestamptz
);

-- ============================================================================
-- indexes
-- ============================================================================

create index idx_knowledge_corpus_venue
  on knowledge_corpus (venue_id);

create index idx_knowledge_corpus_tags
  on knowledge_corpus
  using gin (tags);

create index idx_knowledge_embeddings_corpus
  on knowledge_embeddings (corpus_id);

create index idx_knowledge_embeddings_venue
  on knowledge_embeddings (venue_id);

create index idx_knowledge_embeddings_vector
  on knowledge_embeddings
  using hnsw (embedding vector_cosine_ops);

-- ============================================================================
-- triggers
-- ----------------------------------------------------------------------------
-- knowledge_embeddings has no updated_at — embeddings are immutable;
-- reprocessing creates new rows. matches voice_embeddings.
-- ============================================================================

create trigger trg_knowledge_corpus_updated_at
  before update on knowledge_corpus
  for each row execute function set_updated_at();

-- ============================================================================
-- rpc: match_knowledge_corpus
-- cosine-similarity retrieval over knowledge_embeddings. mirrors
-- match_voice_corpus signature with two additions:
--   1. optional tag_filter param (knowledge_corpus is topic-tagged in a way
--      voice_corpus isn't — sourcing, staff_rayan, ceremony, etc.)
--   2. tags returned in result row so the agent knows which topic was matched
-- ============================================================================

create or replace function public.match_knowledge_corpus(
  query_venue_id uuid,
  query_embedding vector,
  match_count integer default 5,
  source_type_filter text[] default null::text[],
  min_confidence numeric default null::numeric,
  tag_filter text[] default null::text[]
)
returns table(
  id uuid,
  corpus_id uuid,
  chunk_text text,
  source_type text,
  confidence_score numeric,
  tags text[],
  similarity double precision
)
language sql
stable
as $function$
  select
    ke.id,
    ke.corpus_id,
    ke.chunk_text,
    kc.source_type,
    kc.confidence_score,
    kc.tags,
    1 - (ke.embedding <=> query_embedding) as similarity
  from knowledge_embeddings ke
  join knowledge_corpus kc on kc.id = ke.corpus_id
  where ke.venue_id = query_venue_id
    and (source_type_filter is null or kc.source_type = any(source_type_filter))
    and (min_confidence is null or kc.confidence_score >= min_confidence)
    and (tag_filter is null or kc.tags && tag_filter)
  order by ke.embedding <=> query_embedding
  limit match_count;
$function$;

-- ============================================================================
-- end of migration
-- ============================================================================

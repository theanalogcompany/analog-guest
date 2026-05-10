-- ============================================================================
-- migration 017: knowledge_corpus tag split + tag-aware match_knowledge_corpus
-- ============================================================================
-- Splits knowledge_corpus.tags (single bag) into primary_tags (closed enum,
-- routing) + secondary_tags (free-form, descriptive). Updates
-- match_knowledge_corpus to filter on primary_tag_filter (replacing the
-- unused tag_filter param) using array-overlap (&&) — OR semantics, so a
-- chunk qualifies if it has ANY of the preferred primary tags.
--
-- BACKFILL RULE: each existing tag goes to primary_tags if it matches a
-- canonical tag exactly OR if its first underscore-prefix matches a
-- canonical tag (e.g. 'staff_phoebe' goes whole into primary_tags).
-- Otherwise to secondary_tags. Mirrors lib/schemas/knowledge-tags.ts's
-- isCanonicalPrimaryTag.
--
-- ROLLOUT: the old `tags` column is NOT dropped here. Left for one cycle
-- as a safety belt; a follow-up migration drops it after the new columns
-- are confirmed live in production and any extraction artifacts are
-- caught up. The old idx_knowledge_corpus_tags GIN index stays paired
-- with the column.
--
-- TAC-242.
-- ============================================================================

-- ── columns ─────────────────────────────────────────────────────────────────

alter table knowledge_corpus
  add column primary_tags text[] not null default '{}',
  add column secondary_tags text[] not null default '{}';

-- ── backfill ────────────────────────────────────────────────────────────────
-- Single update per row; partition tags via the canonical-prefix rule.

-- `distinct` guards against legacy duplicate-tag rows surfacing as
-- `[primary: sourcing, sourcing]` in the prompt. Cheap, idempotent.
update knowledge_corpus kc
set
  primary_tags = coalesce((
    select array_agg(distinct t)
    from unnest(kc.tags) t
    where t = any(array[
            'sourcing','staff','mechanic','menu','philosophy','recommendations',
            'events','history','space','policies','logistics','other'
          ]::text[])
       or split_part(t, '_', 1) = any(array[
            'sourcing','staff','mechanic','menu','philosophy','recommendations',
            'events','history','space','policies','logistics','other'
          ]::text[])
  ), '{}'),
  secondary_tags = coalesce((
    select array_agg(distinct t)
    from unnest(kc.tags) t
    where not (
      t = any(array[
        'sourcing','staff','mechanic','menu','philosophy','recommendations',
        'events','history','space','policies','logistics','other'
      ]::text[])
      or split_part(t, '_', 1) = any(array[
        'sourcing','staff','mechanic','menu','philosophy','recommendations',
        'events','history','space','policies','logistics','other'
      ]::text[])
    )
  ), '{}');

-- ── indexes ────────────────────────────────────────────────────────────────
-- New GIN indexes on the split arrays. The legacy idx_knowledge_corpus_tags
-- on the deprecated `tags` column stays for one cycle.

create index idx_knowledge_corpus_primary_tags
  on knowledge_corpus
  using gin (primary_tags);

create index idx_knowledge_corpus_secondary_tags
  on knowledge_corpus
  using gin (secondary_tags);

-- ── rpc: replace match_knowledge_corpus ────────────────────────────────────
-- Drops the unused `tag_filter` parameter (no caller passed it) and adds
-- `primary_tag_filter` with array-overlap (&&) semantics. Returns both tag
-- arrays so the prompt serializer can render them separately.

-- DROP first because Postgres won't allow CREATE OR REPLACE to change a
-- function's return type. Old signature returned `tags text[]`; new
-- signature returns `primary_tags text[], secondary_tags text[]`. The
-- argument list in the DROP must match the OLD signature exactly,
-- including the unused `tag_filter text[]` slot.
drop function if exists public.match_knowledge_corpus(
  uuid, vector, integer, text[], numeric, text[]
);

create or replace function public.match_knowledge_corpus(
  query_venue_id uuid,
  query_embedding vector,
  match_count integer default 5,
  source_type_filter text[] default null::text[],
  min_confidence numeric default null::numeric,
  primary_tag_filter text[] default null::text[]
)
returns table(
  id uuid,
  corpus_id uuid,
  chunk_text text,
  source_type text,
  confidence_score numeric,
  primary_tags text[],
  secondary_tags text[],
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
    kc.primary_tags,
    kc.secondary_tags,
    1 - (ke.embedding <=> query_embedding) as similarity
  from knowledge_embeddings ke
  join knowledge_corpus kc on kc.id = ke.corpus_id
  where ke.venue_id = query_venue_id
    and (source_type_filter is null or kc.source_type = any(source_type_filter))
    and (min_confidence is null or kc.confidence_score >= min_confidence)
    and (primary_tag_filter is null or kc.primary_tags && primary_tag_filter)
  order by ke.embedding <=> query_embedding
  limit match_count;
$function$;

-- ============================================================================
-- end of migration
-- ============================================================================

-- 004_match_voice_corpus_function.sql
-- pgvector cosine similarity search over a venue's voice corpus.
-- Returns top-K most similar chunks within a single venue, with optional
-- filters by corpus source_type and minimum confidence_score.
--
-- Called from lib/rag/retrieve.ts via supabase.rpc('match_voice_corpus', ...).
-- Filters on voice_embeddings.venue_id (denormalized; indexed) for venue
-- isolation, then joins voice_corpus for source_type and confidence_score
-- surface fields and optional filtering.

create or replace function match_voice_corpus(
  query_venue_id uuid,
  query_embedding vector(1024),
  match_count int default 5,
  source_type_filter text[] default null,
  min_confidence numeric default null
)
returns table (
  id uuid,
  corpus_id uuid,
  chunk_text text,
  source_type text,
  confidence_score numeric,
  similarity float
)
language sql
stable
as $$
  select
    ve.id,
    ve.corpus_id,
    ve.chunk_text,
    vc.source_type,
    vc.confidence_score,
    1 - (ve.embedding <=> query_embedding) as similarity
  from voice_embeddings ve
  join voice_corpus vc on vc.id = ve.corpus_id
  where ve.venue_id = query_venue_id
    and (source_type_filter is null or vc.source_type = any(source_type_filter))
    and (min_confidence is null or vc.confidence_score >= min_confidence)
  order by ve.embedding <=> query_embedding
  limit match_count;
$$;
-- 008_voice_corpus_source_ref.sql
-- adds source_ref column + extends source_type check + unique partial index.
-- enables upsert-by-source-ref idempotency for ingest-response-review (the-178).
--
-- contract: a row in voice_corpus that originated from a specific external
-- artifact (e.g. an 08-response-review gsheet, a future training UI, a future
-- api ingestion) carries source_ref pointing back to that artifact. ingestion
-- scripts upsert on (venue_id, source_ref) so re-running is a no-op.
--
-- existing rows pre-migration have source_ref = null. the partial unique
-- index tolerates this (postgres treats null as not-equal-to-anything in
-- unique indexes); only non-null source_ref values are uniqueness-checked.

-- ============================================================================
-- 1. source_ref column
-- ============================================================================

alter table voice_corpus
  add column source_ref text;

-- ============================================================================
-- 2. extend source_type check constraint to include 'operator_edit'
-- ============================================================================
-- the existing constraint name is auto-generated as voice_corpus_source_type_check
-- by postgres. drop and recreate with the extended set of allowed values.
-- 'operator_edit' is the source_type for rows ingested from the 08- review
-- gsheet — a verdict=edit row's edited_message becomes a corpus entry.

alter table voice_corpus drop constraint voice_corpus_source_type_check;

alter table voice_corpus add constraint voice_corpus_source_type_check
  check (source_type in (
    'sample_text',
    'voicenote_transcript',
    'brand_doc',
    'email_archive',
    'text_archive',
    'chat_transcript',
    'social_post',
    'manual_entry',
    'training_response',
    'past_message',
    'operator_edit'
  ));

-- ============================================================================
-- 3. partial unique index on (venue_id, source_ref) where source_ref is not null
-- ============================================================================
-- supports ON CONFLICT (venue_id, source_ref) for upserts. partial index
-- excludes existing pre-migration rows whose source_ref is null, so they
-- don't all collide on a single null-vs-null comparison.

create unique index uniq_voice_corpus_venue_source_ref
  on voice_corpus(venue_id, source_ref)
  where source_ref is not null;

-- ============================================================================
-- end of migration
-- ============================================================================
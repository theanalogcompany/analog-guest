-- 082: venue_configs.knowledge_brief
--
-- The authored, consolidated replacement for v2's knowledge retrieval lane.
-- One prose artifact per venue, rendered verbatim into system block 2, in
-- place of the four `knowledge_corpus` chunks `retrieveKnowledgeContext`
-- returned per turn.
--
-- WHY A COLUMN AND NOT `venue_info`. Two reasons, both load-bearing.
-- `buildRuntimeContext` parses `venue_info` through Zod on every v1 turn, so
-- a ~23k-char key in there taxes the live engine for text it never reads. And
-- this is a single large prose artifact that wants to be diffed and edited on
-- its own, not a typed section of a JSONB document.
--
-- WHY NOT READ `knowledge_corpus` LIVE. The rows are raw, duplicated and in
-- places contradictory - 365 rows and 62,365 chars collapse to 22,900 once the
-- duplication is removed and the disagreements are resolved. The brief is an
-- editorial artifact, so it is stored as one.
--
-- NULL means "this venue has no brief", which is the state every venue but
-- Le Mil's is in. `run-turn.ts` renders the empty-section fallback for it, so
-- a venue without a brief is not a venue claiming to know nothing.
--
-- THE TABLE AND THE ROWS STAY. v1 still retrieves (`lib/agent/stages.ts`),
-- and `/admin` still edits the corpus. This column does not replace
-- `knowledge_corpus`, it replaces v2's use of it.

begin;

set local lock_timeout = '5s';

alter table venue_configs
  add column knowledge_brief text;

comment on column venue_configs.knowledge_brief is
  'Authored consolidated venue knowledge, rendered verbatim into v2 system block 2 in place of knowledge_corpus retrieval. Per-venue STATIC - anything per-turn here breaks the block 2 cache prefix (see lib/ai/v2/template.ts, the 2026-10-08 split). NULL means no brief; v1 is unaffected and still retrieves.';

commit;

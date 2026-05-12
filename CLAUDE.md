# analog-guest

This is the messaging engine for Analog — a guest recognition platform for independent cafes, bakeries, and restaurants. This repo handles inbound and outbound messages between venues and their guests, plus the AI generation, classification, and routing logic. It also hosts the internal Command Center (`app/admin/*`) — the Analog-staff debugging surface served on `admin.theanalog.company`. A separate venue-operator dashboard (`analog-operator`) is planned but not yet built; bearer-token auth scaffolding for that future repo lives in `lib/auth/` (see "Auth boundary" below).

---

## Keeping this file current

This file is the source of truth for how the codebase works. When shipping a new script, migration, schema convention, file-naming convention, library pattern, or workflow rule, update this file in the same commit. If a future-you (or a future Claude Code session) would have to rediscover the convention, document it here.

---

## Product principles (do not violate)

- **Recognition, not loyalty.** Guests do not "earn" things — they get recognized. Avoid loyalty-program language ("points," "rewards," "tier," "earn") in any guest-facing output, system prompts, or operator-facing UI copy.
- **Speaker framing is per-venue.** Messages to guests can come from a few different framings depending on what the venue approves: from the venue itself (default), from a named person at the venue ("[Name] from [Venue]"), or from the owner directly when the owner approves that framing. The default is venue-level until told otherwise per venue.
- **Every venue is its own isolated block.** Own messaging number, own voice corpus, own config, own data. Cross-venue queries are Analog-internal only and never exposed to operators.
- **The product is messaging-only.** There is no guest app. Do not assume a frontend for guests. The guest's only surface is the iMessage/SMS conversation with the venue.
- **Voice is the product.** The agent's response style, register, and judgment are what we sell. Treat voice quality as a first-class concern, not a polish-later detail.

---

## Tech stack

- **Language:** TypeScript, strict mode
- **App framework:** Next.js (App Router) deployed on Vercel
- **Database:** Postgres with pgvector, plus Auth and Storage (Supabase as the current provider)
- **Messaging:** iMessage + SMS fallback (Sendblue as the current provider). One dedicated number per venue. Inbound webhook: `webhooks.theanalog.company/api/webhooks/sendblue` (configured Sendblue-side; route handler at `app/api/webhooks/sendblue/route.ts`). Future webhook integrations (Square, Stripe, Toast) inherit this subdomain convention.
- **LLM:** Anthropic API via the Vercel AI SDK abstraction layer (model-agnostic from day one)
- **Embeddings:** Voyage
- **Drive integration:** Google Drive + Sheets API for the venue onboarding artifact pipeline (06-09 files described below)
- **Analytics:** PostHog for product/event analytics, Slack for operational alerts

Treat the database, messaging, and LLM providers as swappable. Code should depend on internal interfaces (e.g., `lib/messaging/send.ts`), not on vendor names.

---

## Brand & design

The Analog visual language is documented in `docs/brand/style-guide-v01.html`. Open in a browser to view rendered. It defines:

- Color tokens (clay, paper, parchment, ink variants, stone variants) with hex values in the `:root` CSS block
- Typography stack: **Fraunces** (variable serif — display + italic-display, with brand-default `opsz/SOFT/WONK` variation settings in `--fraunces` and `--fraunces-text`) and **Inter Tight** (variable sans — body, UI, eyebrows with `letter-spacing: 0.22em`, captions). No script face — every italic-display moment resolves through Fraunces.
- Voice register guidance ("Tone continuum" section — Composed / Direct / Quiet, with surface-by-surface mapping)
- Layout primitives (eyebrows, section headers, hairline borders, tabular nums for receipt-shaped data)

The file is reference material, not code. Do not modify it. Brand updates land as a new versioned file (v02, v03, etc.) so the canonical reference for any given moment is pinned.

Token extraction into runtime code happens in `app/globals.css` under `@theme inline` (Tailwind v4 — no separate config file) — set up during THE-198 (Command Center scaffold).

---

## Folder layout

### App and library code

- `app/api/` — route handlers (webhooks, internal API for operator)
- `lib/db/` — database clients and queries (currently backed by Supabase). `lib/db/admin.ts` exports `createAdminClient` for service-role access in scripts and crons.
- `lib/messaging/` — message send + receive + webhook verification (currently backed by Sendblue)
- `lib/ai/` — AI SDK setup, prompts, classification, generation. Contains `classify-message.ts`, `generate-message.ts`, the `SYSTEM_TEMPLATE`, and the universal voice rules R1-R7.
- `lib/rag/` — embedding (`ingestCorpusEntry`), retrieval, the `match_voice_corpus` RPC wrapper
- `lib/recognition/` — relationship strength scoring, state machine logic (`computeGuestState`, `computeRelationshipStrength`, `loadSignals`, `normalize-signals`), threshold evaluation. `state-bands.ts` exposes `isStateAtLeast(current, min)` for ordered comparisons across the four bands. `eligibility.ts` exposes `isRedemptionActive` + `filterEligibleMechanics` for runtime mechanic eligibility filtering, plus `MechanicRedeemedDataSchema` documenting the `engagement_events.data` shape for `event_type='mechanic_redeemed'` rows.
- `lib/agent/` — orchestration layer. `build-runtime-context.ts` (assembles RuntimeContext for a single agent run), `stages.ts` (classify → retrieve → generate stage functions), `handle-inbound.ts`, `handle-followup.ts`. The agent module owns the per-request lifecycle.
- `lib/auth/` — auth helpers. `verifyAnalogAdminAccess(authUserId)` gates `/admin/*` access via cookie-session (THE-198) — admin layout (`app/admin/(authed)/layout.tsx`) is the primary caller. The bearer-token path — `verifyOperatorRequest(request)` (returns `{ operatorId, allowedVenueIds }` or throws `AuthError`), `getCurrentOperator(request)` (Response-returning wrapper), `verifyAnalogAdminRequest(request)` (bearer + `is_analog_admin = true`), and `withOperatorAuth(handler)` (HOF for `app/api/operator/*` route handlers, TAC-258) — went live with the operator API endpoints. `verifyAnalogAdminRequest` remains forward-scaffolding for the future `analog-operator` repo; the others are active. Server-only; uses the admin DB client.
- `lib/operator/` — Operator API building blocks (TAC-258). `dispatchOperatorOutbound({messageId, operatorId, allowedVenueIds, action, editedBody?})` is the shared "send the pending draft via Sendblue and update the existing row" helper for approve + edit; optimistic UPDATE flips `review_state` pending→target, then Sendblue, then second UPDATE for `status='sent'` / `sent_at` / `provider_message_id`. Returns `originalBody` (pre-UPDATE) so the edit route can stamp `response_review.originalAiBody`. `listPendingQueue(allowedVenueIds)` wraps the `list_operator_queue` RPC and normalizes the jsonb recent_context into `QueueDraft.recentContext[]`. Both helpers are RAGResult-shaped (`{ok: true, ...} | {ok: false, error}`) and consumed by the five routes under `app/api/operator/*`.
- `lib/ui/` — Brand primitives consumed by `app/admin/*`: `<Eyebrow>`, `<SectionHeader>`, `<HairlineRow>`, `<Card>`, `<StatusDot>`. RSC-compatible. Sourced from the brand language at `docs/brand/style-guide-v01.html` — do not introduce decorative variants without updating the style guide first.
- `app/admin/` — Command Center routes. Auth-gated by `verifyAnalogAdminAccess` in `app/admin/(authed)/layout.tsx`. Served on `admin.theanalog.company` in production via root `middleware.ts` host gating. **Direct** register per the style guide tone continuum.
- `lib/schemas/` — Zod schemas for venue-shaped JSONB fields. `BrandPersonaSchema` (handles dual-shape `voiceAntiPatterns`, see gotchas), `MessageReviewSchema` (the `response_review` shape from migration 014), `VenueInfoSchema` (with `filterActiveContext` per THE-150). Read JSONB fields through these — never directly via SQL paths.
- `lib/analytics/` — PostHog event emission helpers (events fire and forget; failures must not crash the agent path)
- `lib/observability/` — Langfuse SDK wrapper (THE-200). `startAgentTrace(opts)` returns an `AgentTrace` with `span() / update() / flushAsync()`; spans expose `span()`, `generation()`, `update()`, `end()`. No-op when env vars missing or `NODE_ENV=test`. Wrapper never throws — SDK errors are swallowed with `console.warn`. Use this from `lib/agent/` only; never import `langfuse` directly from app code.
- `lib/voice-training/` — Shared voice-data write helpers used by the 08-flow onboarding script (`scripts/ingest-response-review.ts`), the cc-review live-edit API route, and the Voices command-center rail (THE-237). Channels: `upsertCorpusEdit({...}, 'skip-existing' \| 'replace')` for source-ref-keyed cc-review/08-review/voices-commit writes (anti-corpus-poisoning rule applies — only the operator-edited message text is embedded). `addCorpusEntry({venueId, content, sourceType, tags, addedByOperatorId?})` for ad-hoc rail additions (`source_type` ∈ `manual_entry` \| `sample_text` \| `past_message`). `editCorpusEntry({corpusId, content?, tags?})` re-embeds only on content change. `removeCorpusEntry(corpusId)` straight delete + FK cascade on voice_embeddings. `dedupeAndAppendAntiPatterns(venueId, rules, { source, authorOperatorId? })` does read-modify-write on `venue_configs.brand_persona.voiceAntiPatterns` with case + whitespace normalization. `removeAntiPattern(venueId, ruleText)` removes by exact text match (operators delete what they see). THE-236 reshaped the persisted anti-pattern entries from `string[]` to `Array<{ text, source: 'auto' \| 'manual', authorOperatorId?, addedAt? }>`; `BrandPersonaSchema` accepts both legacy strings and the struct shape and normalizes string entries to `{text, source: 'manual'}` on parse. **Asymmetry to know about (TODO):** the cc-review path doesn't currently populate `voice_corpus.added_by_operator_id`; only `addCorpusEntry` does. Track for backfill in a future ticket.
- `lib/voices/` — Critique → regen → commit loop helpers that drive the live half of the Voices command-center playground (THE-238). Distinct from `lib/voice-training/` which owns CRUD: this folder owns inference + persistence around critiques. `regenerateWithCritique({venueId, originalMessageId, critique})` rebuilds runtime context with history pinned to the moment of the original outbound's triggering inbound, classifies + retrieves + generates a fresh response with the operator's critique injected, and returns a single attempt (multi-attempt state lives client-side). **Coupling: this helper deliberately mirrors the wiring in `lib/agent/stages.ts` — if retrieval thresholds, knowledge gating, or post-generation logic change there, mirror them here.** `classifyCritique({critique, badResponse, goodResponse})` is the commit-modal Sonnet call deciding edit_only vs edit_and_rule + synthesizing a candidate ruleText (operator overrides both before commit fires). `persistCritique({...})` embeds + inserts a `voice_critiques` row. `findPatternClusterForCritique({...})` and `findActiveClusters(venueId)` run cosine-search → verification per the cluster-detection pipeline. Pure helpers (`-pure.ts`) split the prompt builders + threshold logic out so module-load SDK init doesn't trip vitest.
- `lib/tunables/` — Hand-maintained manifest of operational tunables (TAC-183). `manifest.ts` re-exports agent / recognition / retrieval / timing constants from their source files with display metadata, consumed by the read-only Command Center viewer at `/admin/tunables`. No registration primitive, no module-load side effects — purely a data file. Read-only by design; editable overrides are Phase 2. Vitest module-load: the manifest test mocks `voyageai` (the only SDK module that trips vitest's ESM directory-import resolver) — adding a tunable that pulls in another heavy SDK at module load may require extending that mock.

### Scripts

- `scripts/` — top-level CLI entry points. Each is a thin orchestrator that reads args, sets up clients, calls helpers, logs progress.
- `scripts/onboarding/` — helpers used by the onboarding pipeline scripts. One helper module per pipeline step. Helpers may be split into `<name>-pure.ts` (no `@/*` imports, vitest-loadable) and `<name>.ts` (DB-touching wrapper) when tests need to load the pure logic — see "Module split for testability" below. Modules: `airtable.ts` (transcript fetch), `menu-csv.ts` (CSV parser), `parse-venue-spec.ts` (Zod-strict venue-spec parser; the offline boundary referenced in the permissive-schema gotcha), `seed-supabase.ts` (helper imported by `scripts/seed-venue.ts`), `extract.ts` (LLM-extraction orchestrator), plus `extract-test-scenarios.ts`, `run-test-scenarios.ts`, and `ingest-response-review-pure.ts`.
- `scripts/onboarding/fixtures/` — repo-resident input fixtures consumed by extraction scripts (e.g., `venue-spec-example.md`, `test-scenarios-example.md`)
- `scripts/onboarding/drive.ts` — shared Drive integration. Exports `getDrive`, `findVenueFolder`, `listVenueFiles`, `findByPrefix`, `readDriveFileAsText`, `writeMarkdownFile`, `writeJsonFile`, `writeSheetFile`. Use these instead of inlining Drive calls.

### Database

- `db/migrations/` — SQL migrations (single source of DB truth). Hand-written. See "Migrations" section.
- `db/types.ts` — auto-generated by `npm run db:types` against the live Supabase schema. May be hand-patched temporarily after a migration lands but before `db:types` runs; the next `db:types` run overwrites the patch with canonical output.

### Tests

- `*.test.ts` colocated next to source files. Vitest is the runner. Run all: `npx vitest run`. Run single file: `npx vitest run path/to/file.test.ts`.

---

## Code conventions

- Industry-standard TypeScript and Next.js naming. PascalCase for components and types, camelCase for functions and variables, kebab-case for filenames, SCREAMING_SNAKE for env vars.
- Prefer functions over classes
- Async/await over `.then()`
- Zod for runtime validation at all API boundaries
- No `any` types. Use `unknown` and narrow.
- Errors are values for internal functions: return `{ ok: true, data }` or `{ ok: false, error }`. Throw only at outer boundaries (route handlers, scripts). Domain-specific aliases formalize the contract: `RAGResult<T>` (`lib/rag/types.ts`), `AIResult<T>` (`lib/ai/types.ts`), `RequireAdminResult<T>` (`lib/auth/`). New helpers should reuse one of these or define a parallel alias rather than inlining the discriminated union.
- Imports use the `@/*` alias for repo-relative paths in app/lib code. Scripts may use either `@/*` or relative imports; see "Module split for testability" for when relative imports are required.

### Module split for testability

Vitest resolves `@/*` aliases via `vitest.config.ts` (THE-231). The remaining failure mode is **module-load-time SDK init** — importing a module that constructs a Voyage / Supabase admin client at the top level will run that init in the test process, even with `vi.mock` (mocks intercept resolution, not transitive eager init). When this happens, split the helper module:

- `scripts/onboarding/<name>-pure.ts` — pure helpers, no `@/*` imports. Tests import from here.
- `scripts/onboarding/<name>.ts` — DB-touching code. Re-exports everything from `-pure` so the CLI can keep a single import.

Example: `ingest-response-review-pure.ts` (parsing, classification, dedupe) + `ingest-response-review.ts` (Supabase upserts, Voyage embed). The CLI imports from the latter; tests import from the former.

### LLM call patterns

- Use Vercel AI SDK's `generateObject` for structured outputs with a Zod schema.
- **THE-157 gotcha: never use `.min()` or `.max()` on number fields in LLM-output Zod schemas.** Anthropic's structured output rejects these. Use `.refine()` or post-LLM validation instead.
- Default model for production agent work: `claude-sonnet-4-6`. Default temperature for generation: 0.7 (variation in phrasing) or 0.3 (idempotent extraction).
- All LLM-output schemas should have a `prompt_version` string field on the wrapper object so we can distinguish output from different prompt iterations.

---

## Workflow rules for Claude Code

These are not aspirations. They are hard rules. Following them produces good work; skipping them produces drift.

### Linear-first

All work starts from a Linear ticket. If a request arrives without a ticket ID, ask for one before planning. Drive-by changes without an audit trail are not allowed.

### Audit-first

Before writing any code for a new ticket, read:
1. This file (CLAUDE.md)
2. The relevant existing files the new code will sit next to (e.g., for a new script in `scripts/`, read at least one existing script in the same directory)
3. The migrations that touch the relevant tables
4. Any existing tests for the modules being modified

Cite specific file paths and existing patterns in your plan. Don't infer architecture from filenames; read the actual code.

**High-stakes changes require explicit human review.** Any change touching auth (`lib/auth/`, `verifyAnalogAdminAccess`, RLS policies), payment/Stripe code, Sendblue webhook handlers, the agent runtime contract (voice fidelity floor, retrieval floors, universal voice rules R1–R7), or migrations against `messages` / `engagement_events` / `voice_corpus` cannot proceed via `[NEEDS-INPUT]` clarifying questions. Post a `[HUMAN-REVIEW-REQUIRED]` comment on the Linear ticket and stop. Do not propose alternatives, do not partial-implement. Wait.

### Plan → review → build → review → commit

1. **Plan only on the first request.** Output a written plan covering scope, file paths, function decomposition, sequence of operations, existing patterns to reuse, edge cases, what you intentionally chose NOT to do, and open questions. Stop and wait for review.
2. **Build only after the plan is approved.** A second prompt will explicitly authorize the build per the approved plan.
3. **Verify and report.** After building, run `npx tsc --noEmit` and `npx vitest run`. Report file changes, test count, deviations from the plan, and anything you'd push back on.
4. **Commit only after review.** Don't commit until the human says go.

### Comment protocol

**Authorship prefix.** Every Linear comment posted via the MCP starts with `**[FROM CLAUDE CODE]**` on its own line at the top. Linear shows Jaipal as the author of all MCP-posted comments, so this prefix is the only way to distinguish CC comments from chat comments (which use `**[FROM CLAUDE CHAT]**`). Applies to every comment — audits, plans, self-reviews, NEEDS-INPUT flags. Going forward; not retroactive.

**Purpose tag.** When a clarifying question surfaces during work, follow the authorship prefix with `[NEEDS-INPUT]` and each question numbered. Set ticket status to "Awaiting Input" and stop. When resuming, look for the most recent `[DESIGN-ANSWERS]` comment for the user's response. For high-stakes changes (per "Audit-first" above), use `[HUMAN-REVIEW-REQUIRED]` instead — never `[NEEDS-INPUT]`.

**`/work-ticket` auto-polling.** Inside the `/work-ticket` flow, posting a comment that needs a response (plan post, `[NEEDS-INPUT]`) does not exit the session. The command is idempotent and uses `ScheduleWakeup` to auto-resume on a 60s → 300s exponential backoff with a 2-hour cumulative timeout (26 iterations). When the operator replies in Linear, the next wakeup detects the reply and applies a 3-way classification: **Proceed** (advance to next phase), **Modify** (integrate revisions and re-post plan, keep polling), or **Wind-down** (post `[POLLING-CLOSED]` and exit cleanly). Chit-chat / holding-pattern replies post `[POLLING-ACK]` and re-schedule. Terminal states that exit immediately with no wakeup: `[HUMAN-REVIEW-REQUIRED]`, `[POLLING-TIMEOUT]`, `[POLLING-CLOSED]`, and PR-link comments at Phase 5. The operator types `/work-ticket TAC-XXX` exactly once; subsequent harness re-fires of the same prompt are transparent. The agent never auto-closes the ticket — operators close manually (the permission hook enforces this). **Stale-session safety:** each session writes a `[POLLING-STATE]` comment to the ticket and updates it on every wakeup. If a manual re-invocation finds a fresher `[POLLING-STATE]` than the one it would write, it exits immediately to avoid two wakeup chains for the same ticket. This means manually re-running `/work-ticket TAC-XXX` while a session is already polling will appear to "skip" iterations — that's intentional. Outside `/work-ticket`, the default "stop after `[NEEDS-INPUT]`" behavior above still applies.

### Never just acknowledge

If asked to remember, forget, or update something about the user's context, use the `memory_user_edits` tool. Don't reply conversationally with "I'll remember that" — that's a lie if you don't actually update memory.

### File path conventions

- For any new file, propose the path first.
- Match the directory's existing pattern. Don't invent new top-level directories without asking.

### Commit messages

- Lowercase, imperative ("add inbound webhook handler"), no emoji.
- Body explains WHY when the change isn't obvious from the title.
- Reference the ticket: `THE-XXX: <title>` on the subject line.

### When unsure

Ask. Do not guess product behavior. The plan-first rule exists so questions surface before code does.

---

## Git workflow

- Branch protection on `main` is active. Direct pushes to `main` are rejected.
- All changes go through a pull request.
- Branch naming: `jaipal/the-XXX-short-description` (keep it short — Linear's auto-generated branch names are often too long).
- Open PR with `gh pr create`. Title format: `THE-XXX: <imperative subject>`.
- Merge style: `gh pr merge <num> --squash --delete-branch`. Squash matches the linear single-commit-per-change history of `main`.
- CI must be green before merge — `tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build` all enforced via `.github/workflows/ci.yml`.
- Pre-commit hook (husky + lint-staged, configured via `prepare` in `package.json`): runs `eslint --fix` on staged `.ts/.tsx`, then `tsc --noEmit` against the full project, then `vitest related --run` on staged files. Failure rejects the commit. Don't `--no-verify` without a reason.

---

## Database migrations

Migrations live in `db/migrations/` numbered sequentially. Each is hand-written SQL. Workflow:

1. Write the migration file.
2. Operator applies it via Supabase Studio's SQL editor.
3. Operator runs `npm run db:types` to regenerate `db/types.ts`.
4. If the migration adds a column the script needs to typecheck against immediately, hand-patch `db/types.ts` in the same commit as the script. The next `db:types` run will overwrite the patch with canonical output. Document the patch in the commit message so it's not lost.

### Migration log

- `001_initial_schema.sql` — 13 tables: venues, operators, operator_venues, venue_configs, guests, mechanics, transactions, messages, engagement_events, guest_states, voice_corpus, voice_embeddings, audit_log. Includes the shared `updated_at` trigger function.
- `002_add_message_reactions.sql` — adds `reaction_type` column to `messages`, extends the category check to include `'reaction'`, updates the content constraint to allow rows with only a reaction_type, and adds a consistency check between `category` and `reaction_type`.
- `003_ai_module_refinements.sql` — batches schema changes from AI module design: renames `messages.confidence_score` to `voice_fidelity` for terminology consistency; adds `review_reason` and `pending_until` columns to support routing audit trail and the hold-and-fallback workflow; extends `messages.category` check to include `'acknowledgment'` for fallback messages.
- `004_match_voice_corpus_function.sql` — adds Postgres function `match_voice_corpus(venue_id, query_embedding, match_count, source_type_filter, min_confidence)` for pgvector cosine similarity search over a venue's voice corpus. Used by the RAG module's `retrieveContext` via Supabase RPC.
- `005_post_recognition_refinements.sql` — batches schema changes from RAG/recognition module work: adds retrieval analytics columns to voice_embeddings, authorship column to voice_corpus, extends operator_venues permission_level to include 'analog_admin', adds home_postal_code and distance_to_venue_miles to guests for the recognition distance multiplier, extends engagement_events.event_type to include 'referral_converted'.
- `006_idempotency_and_inbound_message_origin.sql` — adds unique constraint on `messages.provider_message_id` as last-line defense against duplicate orchestrator runs (replaces the prior regular index), and extends `guests.created_via` to include `'inbound_message'` for guests auto-created from unrecognized phone numbers texting in. Inbound→outbound message linking already exists via `messages.reply_to_message_id` from migration 001 — no schema change needed for that. Visit dedupe timezone fix and `venue_info.currentContext` are app-side changes, not migrations. THE-150 later added an optional `expiresAt` field to each `currentContext` entry — runtime filters expired entries via `filterActiveContext` in `lib/schemas/venue-info.ts` before they reach the prompt.
- `007_test_synthetic_guests.sql` — adds `is_test_synthetic` boolean to `guests` (default false, not null) plus a partial index on `(venue_id, is_test_synthetic) WHERE is_test_synthetic = true`. Used by `run-test-scenarios` (THE-181) to mark synthetic guests seeded for Phase 5 testing so analytics can filter them out. Synthetic guests are still per-venue (schema-required); the deterministic phone numbers `+15550001000/100/200/300` are reused across venues but each venue gets its own four guest rows.
- `008_voice_corpus_source_ref.sql` — adds `source_ref text` column to `voice_corpus`, extends the `source_type` check constraint to include `'operator_edit'`, and adds a partial unique index on `(venue_id, source_ref) WHERE source_ref IS NOT NULL`. Enables idempotent upsert-by-source-ref for `ingest-response-review` (THE-178), which keys voice corpus rows on `'08-review:{sample_id}'` so re-runs don't duplicate.
- `009_mechanic_min_state_and_redemption.sql` — adds three columns to `mechanics`: `min_state` (NOT NULL DEFAULT 'new', check-constrained to the four guest states; gates eligibility by relationship band), `redemption_policy` (NOT NULL DEFAULT 'one_time', `'one_time' | 'renewable'`; named "policy" rather than "type" to avoid colliding with the existing `mechanics.redemption.type` jsonb field describing the redemption mechanism), and `redemption_window_days` (nullable integer; required when policy='renewable'). Adds composite CHECK constraint `mechanics_redemption_window_consistency` enforcing `(one_time + null) OR (renewable + non-null)`. Adds index `idx_mechanics_min_state` on `(venue_id, min_state)` for the runtime mechanics-load query. Extends `engagement_events.event_type` to include `'mechanic_redeemed'`. Legacy `'perk_redeemed'` and `'merch_redeemed'` event types stay in the constraint for back-compat but new code emits `'mechanic_redeemed'` only. THE-170.
- `010_command_center_columns.sql` — adds two unrelated columns bundled atomically. `messages.langfuse_trace_id text` (nullable) links each agent-generated outbound message to its Langfuse trace, with partial index `idx_messages_langfuse_trace_id` for trace-ID lookup; populated by THE-200 instrumentation, existing rows stay null. `operators.is_analog_admin boolean NOT NULL DEFAULT false` gates access to `admin.theanalog.company` (admin routes colocated in this repo, served via a separate Vercel project). Default false so existing operators are unaffected; admin grants are explicit one-off SQL updates per the template under "Common gotchas". THE-199.
- `011_add_inbound_classifier_categories.sql` — drops + recreates `messages_category_check` to include four new classifier categories: `comp_complaint`, `mechanic_request`, `recommendation_request`, `casual_chatter`. Existing values (`welcome`, `follow_up`, `reply`, `new_question`, `opt_out`, `media`, `perk_unlock`, `event_invite`, `manual`, `reaction`, `acknowledgment`) are preserved. CHECK constraint values don't surface in supabase's generated types, so `db/types.ts` doesn't change — runtime category narrowing lives in `lib/ai/types.ts`'s `MessageCategory` union, with `lib/agent/types.ts` aliasing it to prevent drift. Note: `acknowledgment` was added to `messages.category` back in migration 003 but only got its `CLASSIFY_SYSTEM_PROMPT` definition in this PR — the schema enum had it, the model just was never told about it. THE-228.
- `012_add_personal_history_question_category.sql` — drops + recreates `messages_category_check` to include `personal_history_question` (e.g. "what did I get last time", "do you remember me"). All values from migration 011 preserved. Same supabase-doesn't-surface-CHECK-values caveat applies; runtime narrowing lives in `MessageCategory`. THE-233.
- `013_add_knowledge_corpus.sql` — adds `knowledge_corpus` and `knowledge_embeddings` tables (mirror of `voice_corpus` / `voice_embeddings`: same `vector(1024)` dim for voyage-3-large, same HNSW + cosine index, same `set_updated_at` trigger on the corpus table only since embeddings are immutable) plus `match_knowledge_corpus` RPC. RPC mirrors `match_voice_corpus` with two additions: optional `tag_filter text[]` param and `tags` in the result row, since knowledge entries are topic-tagged (sourcing, staff_rayan, ceremony, etc.) in a way voice exemplars aren't. Splits topical content (origin story, sourcing detail, staff personalities, mechanic explanations) into the new tables; `voice_corpus` continues to store style exemplars only. No ticket — schema was applied to the live DB via Studio prior to this file landing.
- `014_message_response_review.sql` — adds `messages.response_review jsonb` (nullable) to capture per-message reviews from the Command Center conversation viewer (THE-235). JSONB shape validated by `MessageReviewSchema` in `lib/schemas/message-review.ts`: `{schemaVersion, reviewedBy, reviewedAt, category?, editedMessage?, comment?, rule?, expectedFailure?}`. No `verdict` field — presence/absence of `editedMessage` IS the edit signal, presence of `rule` IS the rule signal. Mirrors the 08-flow's destinations: `editedMessage` → `voice_corpus` row keyed on `source_ref='cc-review:{message_id}'` (replace-in-place via the partial unique index from migration 008), `rule` → `brand_persona.voiceAntiPatterns` dedupe-append. Forward-only; existing rows stay null. Inbound message reviews are rejected at the API layer (no CHECK constraint).
- `015_voice_critiques.sql` — adds `voice_critiques` table (id, venue_id, message_id, critique_text, kind ∈ `edit_only` \| `edit_and_rule`, embedding vector(1024), promoted_at, dismissed_at, created_by_operator_id, created_at) plus partial index `idx_voice_critiques_venue_unresolved` filtered to `promoted_at IS NULL AND dismissed_at IS NULL` and HNSW + cosine index on embedding. Adds `find_similar_critiques(query_venue_id, query_embedding, exclude_id?, similarity_threshold default 0.85, match_count default 20)` SQL function — cosine search restricted to UNRESOLVED edit_only critiques in a single venue, with `exclude_id` so the just-committed row never surfaces in its own neighborhood query. Embedding stored on the row directly (no separate _embeddings table) since critiques are short and not chunked. Persistence rule: every committed critique inserts here regardless of `kind`; the cluster query filters at read time. THE-238.
- `016_add_inbound_outbound_split_categories.sql` — drops + recreates `messages_category_check` to include three new values: `perk_inquiry`, `event_question`, `unknown`. `perk_inquiry` / `event_question` are inbound counterparts to the outbound `perk_unlock` / `event_invite` triggers (guests asking ABOUT perks/events vs the venue offering them). `unknown` is the inbound catch-all when the classifier can't categorize confidently — replaces the old practice of routing ambiguous inbounds to `manual`. All values from migration 012 preserved. Same supabase-doesn't-surface-CHECK-values caveat applies; runtime narrowing lives in `MessageCategory`. Lib changes that ship in the same PR: classifier Zod enum subsetted to inbound-only (drops `welcome`/`follow_up`/`perk_unlock`/`event_invite`), `CLASSIFY_SYSTEM_PROMPT` rewritten to match, `getCategoryInstructions` switch + `runtimeToProse` switch widened, `acknowledgment` instructions semantically rewritten (guest sign-off, not venue holding-message), em-dash hygiene swept across 7 instruction files. PROMPT_VERSION bumped to v1.10.0. TAC-238.
- `017_knowledge_corpus_tag_split.sql` — adds `knowledge_corpus.primary_tags text[]` (closed-enum routing signal — see `lib/schemas/knowledge-tags.ts`) and `secondary_tags text[]` (free-form descriptive context). Backfills both from the existing `tags` array using the canonical-prefix rule: a tag goes to `primary_tags` if it matches a canonical value exactly OR if its first underscore-prefix matches a canonical value (so `staff_phoebe` stays whole in `primary_tags`); everything else lands in `secondary_tags`. Adds GIN indexes on both new columns. Replaces `match_knowledge_corpus`: drops the unused `tag_filter` parameter, adds `primary_tag_filter text[]` with array-overlap (`&&`, OR) semantics, returns both tag arrays. The legacy `tags` column is **not** dropped this cycle — left as a safety belt; a follow-up migration drops it. db/types.ts hand-patched in the same commit until `npm run db:types` is re-run post-apply. TAC-242.
- `018_operator_review_state.sql` — adds four columns to `messages` for the mobile operator approval queue (TAC-258): `review_state text` (nullable, CHECK-constrained to `pending | approved | edited | skipped | auto_sent`), `previous_review_state text` (same enum, used by the 3-second undo), `last_operator_action_at timestamptz`, `last_operator_id uuid REFERENCES operators(id)`. `review_state` is a **separate axis from `messages.status`** — status carries delivery lifecycle (received / draft / sent / delivered / ...), review_state carries the human-review verdict applied to outbound drafts. Backfills every existing direction='outbound' row to `'auto_sent'` so the partial queue index isn't polluted. Adds two partial indexes: `idx_messages_review_state_pending` on `(venue_id, created_at) WHERE review_state='pending'` (queue lookup) and `idx_messages_operator_action_recent` on `(last_operator_action_at desc) WHERE last_operator_action_at IS NOT NULL` (undo window). Adds `list_operator_queue(venue_ids uuid[])` RPC with two LATERAL subqueries (latest `guest_states` per draft + jsonb_agg of last-3 recent context excluding the draft row itself, limit 200) — single-round-trip queue read, no N+1. TAC-212 (runtime flag policy) will later override the `auto_sent` default to `'pending'` at the same insert site for drafts that need human review. db/types.ts hand-patched in the same commit until `npm run db:types` is re-run post-apply. TAC-258.

RLS policies will be added in a future migration before any external user gets DB access (THE-110).

---

## Scripts

One-off scripts live in `scripts/` and run via `tsx` with env loading from `.env.local`. To add a new script: drop the file in `scripts/` (CLI orchestrator) and `scripts/onboarding/<name>.ts` (helpers, if it's part of the onboarding pipeline), add a `package.json` entry of the form `"<name>": "tsx --env-file=.env.local scripts/<file>.ts"`, run with `npm run <name> -- <args>`.

### Available scripts

- `npm run send-test -- <phone> [body]` — sends a test message via the messaging module to the given E.164 phone number. Requires `TEST_VENUE_ID` in `.env.local` pointing to a venue row that has `messaging_phone_number` set.
- `npm run extract-venue-spec -- <slug>` — reads the venue's onboarding transcript + Airtable record + menu CSV from Drive, calls Sonnet to extract a structured venue spec, writes `06-{slug}-venue-spec-draft.md` to the venue's Drive folder.
- `npm run extract-test-scenarios -- <slug> [--force]` — reads the venue spec + the categories fixture, calls Sonnet to generate venue-tailored test scenarios (THE-180), writes `07-{slug}-test-scenarios.json` to Drive. `--force` overwrites an existing 07-file.
- `npm run seed-venue -- <slug> [--messaging-phone <e164>]` — reads the 06-spec markdown from Drive, parses it via Zod schemas, ingests into the database (venue, venue_configs, mechanics, voice_corpus + embeddings via Voyage). Optional `--messaging-phone` sets `venues.messaging_phone_number` at seed time. Idempotent guards against accidental re-seed. CLI entry point is `scripts/seed-venue.ts`; the heavy lifting lives in `scripts/onboarding/seed-supabase.ts`.
- `npm run run-test-scenarios -- <slug> [--force]` — seeds the four synthetic guests for the venue (deterministic phones per state), runs each scenario from the 07-file through the agent runtime synchronously (no Sendblue, no human-feel delay, no fidelity gate), writes `08-{slug}-response-review` as a native Google Sheet to Drive (THE-181). Throws after logging all four synthetic-guest tuning outcomes if any state landed in the wrong band.
- `npm run ingest-response-review -- <slug>` — reads the 08-Sheet, ingests `verdict=edit` rows into `voice_corpus` (Voyage embedding on `edited_message` text only, source_ref upsert key for idempotency), appends `rule:`-prefixed comments to `brand_persona.voiceAntiPatterns`, appends a dated `## Phase 5 review additions` subsection to the 06-spec markdown in Drive (THE-178). Skips rows with `expected_failure:` markers entirely. Skips the markdown append if zero net new ingestions.
- `npm run db:types` — regenerates `db/types.ts` from the live Supabase schema. Run after applying any migration.

---

## Phase 5 onboarding pipeline

Phase 5 is the voice-quality cycle that completes venue onboarding. Five files in the venue's Drive folder, numbered 04-08:

- `04-{slug}-menu` (gsheet) — menu CSV, owner-editable
- `05-{slug}-transcript` — onboarding interview transcript
- `06-{slug}-venue-spec-draft.md` — structured venue spec extracted from transcript + airtable + menu. **Central voice brain for the venue.** Original extraction at top; Phase 5 review additions appended in dated subsections at the bottom (always append, never replace). Regenerating only happens if the spec genuinely needs to change — Phase 5 voice training does NOT trigger a re-seed.
- `07-{slug}-test-scenarios.json` — venue-tailored test scenarios (44+ rows for mock-central-perk). Generated by `extract-test-scenarios` from the 06-spec + the categories fixture.
- `08-{slug}-response-review` (gsheet) — populated by `run-test-scenarios`. Owner reviews collaboratively during the Phase 5 meeting, marks `verdict` (approve/edit), provides `edited_message` for rejections, adds `rule:`-prefixed comments for anti-patterns. Then `ingest-response-review` reads it back and updates the corpus + persona surgically.

The pipeline is idempotent at every step. Re-running any script is safe.

### File-naming convention

The 04-09 numbering is meaningful and reserved. Don't introduce other 04-09 files in venue folders. Each script reads its expected files by prefix (`04-`, `06-`, `07-`, `08-`) — adding ambiguous matches will trip the existence guard.

The `-draft` suffix on the 06-file is misleading post-Phase-5 (the file is canonical at that point, not a draft). Slated for rename in THE-185 — bundle with the next touch of any of the three pipeline scripts that reference the filename.

---

## Drive integration

Google Drive auth uses Application Default Credentials (ADC) via `gcloud auth application-default login`. The OAuth client lives in the analog Google Cloud project; client JSON is at `~/.config/analog/oauth-client.json` (or wherever the operator's local setup put it). Scopes: `openid`, `userinfo.email`, `cloud-platform`, `drive`.

Workspace org policy blocks the stock gcloud OAuth client. Use the project-owned OAuth client (Desktop app type) instead — Workspace's third-party policy doesn't apply to your own org's apps. Pass the client JSON via `--client-id-file` to `gcloud auth application-default login`.

Drive helpers are in `scripts/onboarding/drive.ts`:

- `getDrive()` — auth + Drive client
- `findVenueFolder(drive, parentFolderId, slug)` — locates the venue's folder by slug
- `listVenueFiles(drive, folderId)` — lists files in a venue folder
- `findByPrefix(files, prefix)` — finds the unique file with a given prefix; throws on ambiguity
- `readDriveFileAsText(drive, fileId)` — reads a Drive file as text. For gsheets, exports as CSV.
- `writeMarkdownFile(drive, folderId, name, body)` — writes/upserts a markdown file by name
- `writeJsonFile(drive, folderId, name, obj)` — writes/upserts a JSON file by name (pretty-printed)
- `writeSheetFile(drive, folderId, name, csvBody)` — writes/upserts a native Google Sheet from CSV body. Uses `mimeType: 'application/vnd.google-apps.spreadsheet'` + `media.mimeType: 'text/csv'` so Drive auto-converts on upload. The update path explicitly pins both mimetypes to preserve sharing.

### ADC token refresh (when Drive scripts fail)

When `run-test-scenarios`, `extract-venue-spec`, `seed-supabase`, `extract-test-scenarios`, or `ingest-response-review` fails with `Request had insufficient authentication scopes`, ADC needs reauth with explicit Drive scope:

```bash
gcloud auth application-default login \
  --client-id-file='/path/to/client_secret_*.apps.googleusercontent.com.json' \
  --scopes='openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive'
```

**Why this is needed:** the default scopes for `gcloud auth application-default login` (with no `--scopes` flag) do NOT include `drive`. The bare command authenticates successfully but every Drive API call returns `Request had insufficient authentication scopes`. The `--scopes` flag is mandatory for any script that touches Drive.

**Why the `--client-id-file`:** Workspace org policy blocks the stock gcloud OAuth client. The project-owned OAuth client (Desktop app type, `client_secret_*.apps.googleusercontent.com.json`) bypasses that policy because Workspace's third-party policy doesn't apply to your own org's apps.

---

## Testing

Vitest is the test runner. Tests are colocated with source files (`module.test.ts` next to `module.ts`). Pure functions get unit tests; DB-touching code generally doesn't (live-DB tests aren't worth the harness yet).

- Run all: `npx vitest run`
- Run single file: `npx vitest run path/to/file.test.ts`
- Watch mode for development: `npx vitest`

Test count baseline: 721 tests across 61 files as of 2026-05-11. Don't let regressions land — every PR should keep tests green.

THE-164 covers expanding test coverage.

---

## CI

GitHub Actions runs on every PR and push to `main` (workflow at `.github/workflows/ci.yml`):

1. `tsc --noEmit` — typecheck
2. `npm run lint` — eslint
3. `npx vitest run` — unit tests
4. `npm run build` — Next.js build verification

Steps run sequentially with fail-fast (a tsc failure skips the rest). All steps run with mock env vars set in the workflow YAML — no GitHub Secrets configured. If a future test or module-load path requires real credentials, prefer adding a placeholder to the env-mock block first; reach for GitHub Secrets only if the value can't be public.

When CI fails, the GitHub PR check shows which step failed. Reproduce locally with the same command. Most common failures are tsc (run `npx tsc --noEmit`) and lint (run `npm run lint -- --fix` for auto-fixable issues).

CI does NOT make external service calls. If you add a test that hits Voyage/Anthropic/Supabase/Sendblue, CI will either fail (no real API key) or slow down significantly. Mock at the test boundary instead.

Branch protection requires the `CI / ci` status check to pass before merging to `main` (configured in repo settings; see README for the operator checklist).

---

## Observability and alerting

Three layers, each filling a different gap. Don't conflate them.

- **PostHog events.** Product/event analytics. Captures inbound/outbound events, fidelity scores, classification outputs, etc. Configured to fire to Slack on certain event filters. Today only fires on errors; THE-187 expands coverage to silent failures (low fidelity, empty corpus, classification confidence drops, latency spikes, regeneration cycles, webhook silence). PostHog event emission is wrapped in try/catch — failures must not crash the agent path.
- **Slack alerts** (THE-159). Diagnostic-rich alert content for fired alerts. Narrow scope: improves what existing alerts say, doesn't change what fires.
- **Trace-level observability.** Per-run visibility into the agent's reasoning (corpus retrieval scores, prompt content, fidelity self-rating, etc.). Wired up via Langfuse Cloud (THE-200). `lib/observability/langfuse.ts` is a thin wrapper exposing `startAgentTrace` returning an `AgentTrace` (`span()`, `update()`, `flushAsync()`); spans expose `span()` / `generation()` / `update()` / `end()`. Wrapper invariants:
  - Never throws. SDK errors are caught at the wrapper boundary and logged via `console.warn` — observability is diagnostic, not load-bearing.
  - No-op fallback when `NODE_ENV=test`, `LANGFUSE_ENABLED=false`, any of the three env vars (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, host) are missing, or SDK init throws. The host can come from `LANGFUSE_BASE_URL` (preferred — matches the SDK's `baseUrl` constructor field) or `LANGFUSE_HOST` (legacy alias accepted for compatibility with Langfuse's own docs / Vercel integration; slated for removal post-pilot). `BASE_URL` wins when both are set. In no-op mode `trace.id === ''`, all methods are silent no-ops, and agent code runs unchanged.
  - Trace ID is available synchronously the moment `startAgentTrace` returns. `schedule-and-send.ts` writes `trace.id || null` to `messages.langfuse_trace_id` at insert time so traces are queryable from the row.
  - Span tree per agent run: `agent.inbound` (or `agent.followup`) → `context_build` → `classify` (inbound only) → `retrieve` → `retrieve_knowledge` (conditional, gated by `shouldRetrieveKnowledge` in `lib/agent/stages.ts`: always for inbound, only for followup `event` / `manual` triggers) → `generate` → `send`. The `generate` span has post-hoc `generate.attempt_N` sub-spans synthesized from `attemptScores` — these have no real per-attempt timing; threading the trace into `lib/ai`'s regen loop for true timing is tracked in THE-215. Knowledge retrieval degrades gracefully on Voyage / DB error (logs + returns `[]`, span closes normally with `matchCount=0`); voice retrieval continues to fail closed because voice failure breaks voice fidelity itself.
  - Spans carry **metadata always** (counts, scores, IDs in `output` / span input) and **content gated** by `LANGFUSE_CAPTURE_CONTENT` (full inbound body, full retrieved corpus chunks, full system + user prompts, per-attempt generations, full sent body — folded into `output.content` when on, dropped entirely when off; THE-216). Default-on; set `LANGFUSE_CAPTURE_CONTENT=false` to revert to THE-200's metadata-only shape (e.g. for a venue with strict data-handling requirements). The flag is read once at module init — flipping it requires a redeploy. `lib/agent/trace-content.ts` centralizes the per-stage content shape (`buildRecognitionContent`, `buildCorpusContent`, `buildGenerateContent`, `buildGenerateAttemptContent`); `trace.captureContent` is exposed so handlers can skip building heavy payloads when no one will look at them. Coverage gap doc lives in the THE-216 PR description.
  - `flushAsync` is awaited in the `finally` block of each handler. Both handlers run inside a `waitUntil` keep-alive window from their callers (webhook route, cron) so the flush completes before the function returns.
  - `/admin/health` reports four states via `app/admin/(authed)/health/check-langfuse.ts`: **Active** (all keys + known host, green), **Disabled** (`LANGFUSE_ENABLED=false` set explicitly, neutral), **Misconfigured** (some keys present but not all, or unrecognized host — red, with the specific reason in the detail line), **Not configured** (no `LANGFUSE_*` vars set, neutral — local-dev / no-op is appropriate). The check does not actively probe Langfuse — the SDK has no synchronous ping, and probing on every health-page load would pollute the trace stream.

---

## AI agent runtime contract

These constraints are real and have caused bugs:

- **Voice fidelity floor:** the agent self-rates voice fidelity. Below `SEND_FIDELITY_FLOOR` (0.4) → regenerate. Above 0.4 → send. (THE-187 will alert on the 0.4-0.5 band as "low but sent.") Defined in `lib/agent/stages.ts`.
- **Corpus retrieval floor:** retrieval is fail-closed *on the inbound path*. Need at least `MIN_STRONG_MATCHES` (1) chunk scoring at or above `STRONG_MATCH_SIMILARITY` (0.3); below that, the agent bails to a fallback acknowledgment. Followup path skips the gate entirely (THE-231) — operator-initiated sends shouldn't be blocked by sparse corpus retrieval. Defined in `lib/agent/stages.ts`.
- **Classifier confidence routing (TAC-240, v1.11.0):** 3-tier handling in `classifyStage`. Above `CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD` (0.7) → keep the classifier's pick, no event. Between `CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD` (0.3) and 0.7 → keep the pick + fire `classification_low_confidence` (operator should check). Below 0.3 → rewrite the returned `Classification.category` to `'unknown'` so the agent ships a holding response; original category and confidence are preserved on the PostHog event payload (`autoRoutedToUnknown=true`) and on the returned `Classification` for observability. Regen path (`lib/voices/regenerate-with-critique.ts`) does not apply the reroute — operator iterates on the output. Classifier inputs were also widened to receive `recentMessages` + `guestState` so one-word inbounds ("yes", "iced") can be classified in conversational + relationship context; classifier `temperature` dropped from the SDK default 1.0 to 0.2 (analytical task); inbound is truncated to `MAX_CLASSIFIER_INPUT_CHARS` (1000) before classification while generation still gets the full body.
- **Em-dash hard-block (THE-225):** R3 in `SYSTEM_TEMPLATE` says no em dashes, but Sonnet still emits them occasionally even at high voice fidelity. After regen attempts exhaust, a regex hard-blocks remaining `—` and rewrites the offending text; voice fidelity is recomputed on the final shipped body, not the original LLM output. Lives in `lib/ai/generate-message.ts`.
- **Visit history block (TAC-234, v1.13.0):** `RuntimeContext.recentVisits` carries up to `MAX_VISIT_HISTORY_TRANSACTIONS` (20) transactions within the past `MAX_VISIT_HISTORY_DAYS` (90) for the guest, most-recent-first. Rendered as `## Visit history` in the user prompt with bracketed time-delta bullets matching the `## Recent conversation` style. Replaces the v1.12 single-transaction `## Last visit` block. The intro line tells Sonnet to use this for pattern recognition (recommendations, "what haven't I tried") — not to recite history back at the guest. Skipped at the block level for `welcome` and `opt_out`. Empty `recentVisits` omits the block entirely (parallels `## Recent conversation`'s skip-on-empty; distinct from `## Venue knowledge`'s render-explicit-no-match — that pattern exists because the model might invent venue facts, R9 is the safety net there). Projection lives in `lib/agent/extract-recent-visits.ts`.
- **Guest relationship surfacing (TAC-234, v1.13.0):** `recognition.state` is now rendered as `Guest relationship: <state>` directly after the inbound framing line, symmetric with the classifier's TAC-240 surfacing. Closes the tone-calibration gap between regulars and new guests. Single source of truth: the recognition snapshot — surfacing only, no recomputation.
- **runtimeToProse field-presence rendering (TAC-234, v1.13.0):** the per-category switch in `lib/ai/prompts/serializers.ts` was replaced with three independent conditional blocks: inbound framing (one consistent `The guest just sent: "..."` line for any inbound), `perk_unlock` data, `event_invite` data. Carve-outs ("just asked", "(opt-out request)") collapsed into the unified inbound line — the category-specific instructions in the system prompt already convey question vs statement intent. The mutual exclusion between inbound and outbound runtime contexts is enforced by the orchestrator entry points (`handleInbound` populates `inboundMessage`; `handleFollowup` populates `perkBeingUnlocked` or `eventBeingInvited`); type-system enforcement is tracked separately as TAC-243 (backlog).
- **Recent conversation block:** the last 14 days of messages between this guest and this venue are loaded into RuntimeContext. THE-173 added this; future changes to the window should consider impact on synthetic-guest seeding (`run-test-scenarios` seeds messages >30 days old to keep this block empty during testing).
- **Today's date in context:** `RuntimeContext.todayInVenueTimezone` is set from `new Date()` at runtime, formatted in the venue's timezone. THE-174 added this so the agent answers "are you open today?" correctly.
- **Universal voice rules R1-R7:** live in `SYSTEM_TEMPLATE`. Apply to every agent on every venue. Don't reference actions the guest didn't take, give today's specific answer, no em dashes, don't reference physical artifacts the agent doesn't have, don't redirect to alt channels for things the venue can answer, yes/no questions get yes/no answers, don't restate context already in the conversation.
- **Mechanic eligibility (THE-170):** mechanics with `min_state` set are filtered out of `RuntimeContext.mechanics` when the guest's recognition state is below the gate. Mechanics with active redemptions are also filtered (`one_time` policy blocks forever after any `mechanic_redeemed` event; `renewable` blocks within `redemption_window_days`). Helpers: `isStateAtLeast` and `filterEligibleMechanics` in `lib/recognition/`. The filter runs at load time in `build-runtime-context.ts` after `recognition.state` is computed, sharing `computedAt` so the filter timestamp matches the recognition snapshot. Empty list is meaningful — the serializer renders an explicit "do not offer perks of any kind" instruction when `mechanics: []`. Empty-list framing is load-bearing for closing the eligibility-leak failure case where Sonnet would otherwise improvise mechanic offers from voice corpus matches.
- **Voice vs knowledge retrieval:** the agent retrieves from two corpora. `voice_corpus` (always-on, fail-closed) supplies HOW the venue speaks — style exemplars rendered as `## Examples of how the venue actually communicates`. `knowledge_corpus` (gated by `shouldRetrieveKnowledge`, fail-graceful) supplies WHAT IS TRUE about the venue — narrative content (sourcing stories, staff personalities, mechanic explanations, philosophy) rendered as `## Venue knowledge` with `[primary: ...]` and `[secondary: ...]` lines per chunk. Knowledge fires for every inbound and for followup triggers `event` / `manual`; skips `day_*` cron triggers. Failure asymmetry is intentional — voice failure breaks voice fidelity (the whole point of the message), knowledge failure just means a less specific reply, still in the venue's voice. Knowledge retrieval uses `match_knowledge_corpus` (migrations 013 + 017), top-K=4, with a `KNOWLEDGE_CONFIDENCE_FLOOR_DEFAULT` of 0.7 (matches the classifier low-confidence threshold for symmetry).
- **Knowledge corpus confidence floor (TAC-242):** `KNOWLEDGE_CONFIDENCE_FLOOR_DEFAULT = 0.7` is applied as the default `min_confidence` on every `match_knowledge_corpus` call. Pre-TAC-242 retrieval passed no floor (admitted all chunks); the new floor retroactively excludes any `confidence_score < 0.7` row from the prompt. Production seed defaults are `0.85` (direct quotes) and `0.85` (synthesized) so this is a no-op for normally-seeded venues, but hand-loaded low-confidence rows will silently disappear from retrieval. Operators can override per-call via `RetrieveKnowledgeContextInput.minConfidence` (passing `0` is honored).
- **Knowledge corpus tag-aware retrieval (TAC-242, v1.12.0):** knowledge_corpus rows carry a two-bucket tag model. `primary_tags` is a closed enum (`sourcing`, `staff`, `mechanic`, `menu`, `philosophy`, `recommendations`, `events`, `history`, `space`, `policies`, `logistics`, `other` — namespacing allowed: `staff_phoebe`, `mechanic_<slug>`) used for retrieval routing; `secondary_tags` is free-form descriptive context that surfaces in the prompt but doesn't affect routing. Validated at the parse boundary via `isCanonicalPrimaryTag` in `lib/schemas/knowledge-tags.ts` — fail-loud on non-canonical primary tags so extraction drift surfaces immediately. The category → primary tag preference map (`lib/agent/knowledge-tag-mapping.ts`) sets routing for four categories: `mechanic_request` and `perk_inquiry` → `mechanic`; `recommendation_request` → `recommendations` / `menu` / `sourcing`; `event_question` → `events`. Other categories use cosine-only retrieval. When a category's preference yields zero matches (sparse corpus for that topic), `retrieveKnowledgeStage` falls back to a no-filter query so recall doesn't collapse. The same pattern is mirrored in `lib/voices/regenerate-with-critique.ts` for the regen path. The `## Venue knowledge` block now ALWAYS renders when retrieval ran (even on empty results — explicit "no specific venue knowledge matched" framing makes R9 fire reliably); the block is omitted only when `knowledgeChunks` is `undefined` (retrieval was gated off). The legacy `tags` column on `knowledge_corpus` stays for one cycle and is dropped in a follow-up migration. Adding a category to the routing map requires an explicit code change to `CATEGORY_TO_PRIMARY_TAG_PREFERENCE`.

---

## Auth boundary (bearer-token path for analog-operator)

The venue-operator path is bearer-token authenticated via `verifyOperatorRequest` (or its `getCurrentOperator` wrapper, or the `withOperatorAuth(handler)` HOF for route handlers). The helper resolves the Supabase auth JWT to our internal `operatorId` plus an `allowedVenueIds` array. Route handlers do venue-mismatch checks themselves (`allowedVenueIds.includes(targetVenueId)`) and choose their response code — by convention `app/api/operator/*` returns 404 (not 403) for out-of-allowlist messages so existence isn't leaked; the helper itself only ever produces 401. RLS is the longer-term defense; the helpers are the v1 enforcement point.

**Status today:** the bearer path is live as of TAC-258 — five route handlers under `app/api/operator/*` (queue / approve / edit / skip / undo) consume `withOperatorAuth`. The `verifyAnalogAdminRequest` variant (bearer + `is_analog_admin = true`) remains forward-scaffolding for the future `analog-operator` admin-only surface. Active admin auth for `app/admin/(authed)/*` uses the cookie-session path via `verifyAnalogAdminAccess(authUserId)`, documented in "Admin scaffold" below. Don't conflate the two — the cookie path is for Analog staff in the Command Center; the bearer path is for venue operators in the mobile app + future dashboard.

---

## Admin scaffold

The Command Center lives at `app/admin/*` inside this repo and is served via a separate Vercel project (`analog-admin`) on `admin.theanalog.company`. Production middleware at `middleware.ts` (root) host-gates: admin host serves only `/admin/*`; guest host 404s `/admin/*`. Local dev (`localhost`/`127.0.0.1`) and `*.vercel.app` previews allow everything for QA.

**Admin API routes live under `/admin/{surface}/api/{thing}`, not `/api/admin/...`.** The host gate above 404s anything not starting with `/admin` on the admin apex. Routes placed at `/api/admin/...` work locally and on `*.vercel.app` previews (which bypass the gate for QA) but 404 in production. Existing pattern to match: `/admin/conversations/api/trace/[traceId]`. Failure signature: route works locally, deploys cleanly, prod fetches return 404 with the correct request URL — first thing to check is whether the path starts with `/admin/`. (THE-203 hotfix #29.)

Auth is magic-link via Supabase (`signInWithOtp`). The protected tree lives under `app/admin/(authed)/` — its layout reads the cookie session via `createServerClient` and calls `verifyAnalogAdminAccess(session.user.id)`. Sign-in (`/admin/sign-in`) and the OAuth callback (`/admin/auth/callback`) are siblings outside the route group so they bypass the gate without redirect loops.

Three states at the gate:
- No session → redirect to `/admin/sign-in`.
- Session, not analog admin → render `<NotAuthorized>` in place (don't redirect; the user has identity, just not authorization).
- Session + analog admin → render `<AdminShell>` (sidebar + topbar + content).

To grant admin access: SQL template under "Common gotchas" (the THE-199 entry).

Brand language is canonical at `docs/brand/style-guide-v01.html`. Fonts load via `next/font/google` in `app/layout.tsx` (Fraunces with `opsz/SOFT/WONK` axes + Inter Tight). Tokens live in `app/globals.css` under `@theme inline` — Tailwind v4, no separate config file. Copy register: **Direct** per the style guide. No emoji, no checkmarks; status indicators use `<StatusDot>`.

**Per-surface palette overrides (TAC-237).** Admin renders on white, not the canonical cream — implemented as a `[data-surface="admin"]` block in `app/globals.css` that re-binds `--paper`, `--parchment`, `--highlight`, and `--stone-light` to a neutral grayscale, scoped via `app/admin/layout.tsx` setting `data-surface="admin"` on its root div. The cascade lets every admin component keep its existing `bg-paper` / `bg-parchment` / `bg-highlight` Tailwind classes unchanged. **Don't mutate `:root` tokens for surface-specific tweaks** — scope them via `[data-surface="..."]` so canonical brand stays canonical and other surfaces (operator dashboard, future repos) can opt into their own palette without drift.

Magic-link callback URL is constructed from `NEXT_PUBLIC_ADMIN_URL` (per environment) plus a fallback to `NEXT_PUBLIC_VERCEL_URL` so preview deploys self-resolve. Supabase project's "Site URL" + "Redirect URLs" allowlist must include all three: localhost, `*.vercel.app`, and `admin.theanalog.company`. Configure in Supabase Studio.

### Conversations viewer (THE-201)

`/admin/conversations` is the headline debugging surface — single-conversation focus, iMessage-style bubble thread, inline Langfuse trace render. Filters live in the URL (`?venue=&guest=`); reload preserves view, links are shareable.

- **Routing:** server-component page (`page.tsx`) does all initial fetches in one render path. Client component (`conversations-client.tsx`) owns selection, trace cache, Realtime. Pre-filter / venue-only paths render `<EmptyState>` with a 5-row recent-activity list scoped to the operator's `allowedVenueIds`.
- **Bubble palette:** real iMessage colors (#007AFF outbound / #E5E5EA inbound) on a paper-toned background. Inter Tight inside bubbles. Brand discipline yields to fitness-for-purpose on internal surfaces — same logic as health-page status colors.
- **Trace fetch:** server prefetches the last 5 outbound messages' traces in parallel via `lib/observability/fetchTrace`; on-demand fetch for older messages via `app/admin/(authed)/conversations/api/trace/[traceId]/route.ts` (cookie-session auth, never exposes the Langfuse secret key client-side). `Promise.allSettled` so a Langfuse outage doesn't 500 the page.
- **Trace panel shape:** linear stage stack matching the agent pipeline order (`context_build` → `classify` → `retrieve` → `generate` → `send`, with `generate.attempt_N` nested). `lib/select-trace-stages.ts` is the pure projection; unknown observations bucket into "Other" so future stages don't silently disappear before this code is updated.
- **Realtime:** subscribes to `messages` filtered by `venue_id` (single-column server filter), refines by `guest_id` client-side. Uses `lib/db/browser.ts` (browser-side anon Supabase client). Subscribe on mount; tear down on unmount or filter change (filter changes navigate via `router.replace`, which remounts the client component cleanly).
- **Recognition state:** read latest `guest_states` row directly. **Don't** call `computeGuestState` from the page — it's expensive and writes audit rows on transitions.
- **StatusDot mapping for guest state:** `neutral` for `new`, `good` for `returning|regular|raving_fan`. `bad` is reserved for actually-wrong states (failed sends, errors), not "this guest is new."
- **Message limit:** 200 rows per conversation load. Older history reachable via THE-202 (guest detail page) once that ships.
- **Routes:**
  - `GET /admin/conversations/api/trace/[traceId]` — on-demand Langfuse trace fetch (cookie-session auth, server-side secret).
  - `POST /admin/conversations/api/follow-up` — operator-initiated manual outbound. Calls `handleFollowup` with `reason='manual'`; the operator's note becomes a top-level block in the system prompt (THE-232).
  - `PUT /admin/conversations/api/review/[messageId]` — captures per-message review (THE-235); writes `messages.response_review` and mirrors the 08-flow destinations (`voice_corpus` row keyed on `cc-review:{message_id}`, anti-pattern dedupe-append).

---

### Voices command center (THE-237 + THE-238)

`/admin/voices` (list) and `/admin/voices/[slug]` (per-voice workbench) are the surface for refining a venue's agent voice — direct edits to rules, corpus, and persona; threads list + bubble thread + live regen playground; pattern-detection banner in the Rules tab. The flow is: click flagged outbound → type why it's bad → regen → pick the best attempt → commit. Pattern detection surfaces a banner when ≥3 similar edit_only critiques accumulate without promotion.

**Routes** (under `/admin/voices/api/...` per the host-gating convention):
- `PATCH /admin/voices/api/persona/[venueId]` — single writer for all `BrandPersona` fields (voiceName, tone, formality, lengthGuide, emojiPolicy, signaturePhrases, bannedTopics, voiceTouchstones, speakerFraming, speakerName). Anti-patterns are excluded; they have their own endpoints.
- `POST /admin/voices/api/venues/[venueId]/corpus` — ad-hoc corpus add (uses `addCorpusEntry`).
- `PATCH /admin/voices/api/corpus/[entryId]` — content/tags update; re-embeds only on content change.
- `DELETE /admin/voices/api/corpus/[entryId]` — delete + FK-cascade voice_embeddings.
- `POST /admin/voices/api/venues/[venueId]/rules` — anti-pattern add via `dedupeAndAppendAntiPatterns({source:'manual', authorOperatorId})`. Outer whitespace trimmed at the boundary.
- `DELETE /admin/voices/api/venues/[venueId]/rules` — exact-text remove via `removeAntiPattern`.
- `POST /admin/voices/api/regenerate` — runs `regenerateWithCritique` and returns one new attempt. Multi-attempt state lives client-side; this endpoint is stateless. No PostHog, no Langfuse, no alerts.
- `POST /admin/voices/api/classify-critique` — fires when the commit modal opens; advisory only, operator overrides before commit.
- `POST /admin/voices/api/commit` — orchestrates corpus row (replace-mode upsert keyed on `voices-commit:{messageId}`) + anti-pattern (when `kind=edit_and_rule`, `source='manual'`) + critique row + cluster check (when `kind=edit_only`). Fires `voice_critique_committed` PostHog event with `clusterFormed` boolean for empirical cosine-threshold tuning.
- `GET /admin/voices/api/patterns/[venueId]` — re-derives confirmed clusters across the venue's unresolved edit_only pool. Runs cosine search per row + verification per candidate cluster. **TODO** to persist `cluster_signature + proposed_rule + last_verified_at` if verification frequency becomes annoying — until then, every rail load pays for one Sonnet call per cluster.
- `POST /admin/voices/api/patterns/[venueId]/promote` — appends the synthesized rule with `source='auto'` (the pill that distinguishes promoted-cluster rules from manually-typed ones) and marks member critiques `promoted_at = now()`.
- `POST /admin/voices/api/patterns/[venueId]/dismiss` — marks member critiques `dismissed_at = now()` so the cluster stops surfacing. No rule write.

**Why two parameter shapes:** `/corpus/[entryId]` and `/venues/[venueId]/corpus` live at different path depths because Next.js's dynamic-route disambiguator can't distinguish two `[param]` siblings at the same depth. Venue-scoped collection routes nest under `venues/[venueId]/...` to keep entry-scoped routes clean. Same pattern applied to rules. Persona stays at `/persona/[venueId]` since there's no entry-scoped sibling.

**`router.refresh()` propagation pattern.** All mutation handlers in the rail components do `await fetch(...)` → on success call `router.refresh()`. The refresh re-runs the `(authed)` layout (which re-fetches the sidebar's voice list) and the per-voice page (which re-fetches persona, corpus, threads, tab counts, and last-refined). Optimistic local form state can ride on top — server is source of truth, refresh is what reconciles. Specifically: voiceName changes are visible in the topbar + sidebar + voice list page after a single refresh. No client-side store, no duplicated fetch, no stale-while-revalidate concerns.

**Universal rules display vs SYSTEM_TEMPLATE.** The locked R1–R10 panel in the Rules tab reads from `app/admin/(authed)/voices/[slug]/_lib/universal-rules.ts` — a hardcoded `UNIVERSAL_RULES_DISPLAY` constant. The corresponding rules live in `lib/ai/prompts/system-template.ts` under "# Universal voice rules". **The two are dual sources of truth and must move in lockstep.** When a universal rule is added, removed, renumbered, or substantially reworded in `SYSTEM_TEMPLATE`, update `UNIVERSAL_RULES_DISPLAY` in the same commit. Tracking follow-up to extract a structured rules registry so this coupling goes away (THE-237 follow-up: structured rules registry).

**Realtime on the per-voice page.** The threads list + thread pane subscribe to `messages` rows for the venue using the same `createBrowserClient` + `postgres_changes` pattern as the conversations viewer ([conversations-client.tsx:153-214](app/admin/(authed)/conversations/conversations-client.tsx#L153-L214)). Duplicated inline this round; extract a shared `useVenueMessagesSubscription(venueId)` hook in a follow-up if drift becomes real.

**Regen helper coupling with `lib/agent/stages.ts` (THE-238, refined in TAC-183).** `lib/voices/regenerate-with-critique.ts` deliberately mirrors the `classifyStage → retrieveCorpusStage → retrieveKnowledgeStage → generateStage` wiring in `lib/agent/stages.ts`, calling the raw `lib/ai` + `lib/rag` primitives directly because the agent stages emit PostHog/Langfuse events that would flood telemetry on the regen path (5–20 regens per session). **Analytics isolation means: don't invoke each other's telemetry paths. Sharing values via imports is fine and preferred.** TAC-183 dedupes the four retrieval thresholds (`STRONG_MATCH_SIMILARITY`, `MIN_STRONG_MATCHES`, `CORPUS_RETRIEVE_LIMIT`, `KNOWLEDGE_RETRIEVE_LIMIT`) by importing them from `lib/agent/stages.ts` rather than redeclaring them — silent drift between the two paths is now structurally impossible. The two paths still share the same `buildAiRuntime` mapper (exported from stages.ts so regen can reuse it) and the same knowledge-degrades-gracefully posture. **If gating logic (e.g. `shouldRetrieveKnowledge`) or post-generation behavior changes in `stages.ts`, mirror it in `regenerate-with-critique.ts`.** Regen does NOT enforce `SEND_FIDELITY_FLOOR` — operator decides what's good enough by reading the result.

**Pattern detection persistence rule.** `voice_critiques` stores every committed critique regardless of `kind`; the cluster query (`find_similar_critiques` SQL function) filters to `kind = 'edit_only' AND promoted_at IS NULL AND dismissed_at IS NULL` at read time. Converting an edit_only critique into a rule (kind change) would require row reshape; in practice that path doesn't exist yet, but the rule is documented to keep schema-future-readers from gating insert by kind. The 0.85 cosine threshold is the verification-call gate; logged via `voice_critique_committed` PostHog events with `topSimilarity` and `clusterFormed` so the threshold can be empirically tuned during the first 30 days of usage.

### Tunables viewer (TAC-183)

`/admin/tunables` lists every operational tunable (agent runtime thresholds, recognition signal weights, retrieval floors, timing windows, alert thresholds) with name, current value, type, category, and source location. Read-only — values come from `lib/tunables/manifest.ts`, which imports the live constants from their source files so they can never drift. URL-synced single-select category pill + name-substring search; click a row to expand an inline detail panel (object-typed entries render as `<pre>` JSON). No mutation API exists — read-only is enforced structurally, not just by the UI. Editable overrides are Phase 2 (separate ticket).

**Adding a tunable** = (a) `export const` the source file's constant if not already exported, (b) add a metadata entry to `TUNABLES` in `lib/tunables/manifest.ts`, (c) bump the count assertion in `lib/tunables/manifest.test.ts`. Categories are fixed: `agent_runtime`, `classification`, `timing`, `recognition`, `retrieval`, `mechanics`. Adding a new category requires updating `TunableCategory` plus the `CATEGORIES` pill list in the table component.

## Operator API (TAC-258)

The mobile-operator approval queue is served by five route handlers under `app/api/operator/*`, on the **guest host** (the middleware host-gate only restricts `/admin/*` — `/api/operator/*` flows through). When a dedicated operator host comes online, the routes can move under a host-rewrite without touching the handlers.

**Auth.** All five routes wrap their handler in `withOperatorAuth` (from `lib/auth/operator-auth.ts`). The HOF runs `verifyOperatorRequest` (bearer-token JWT → `operators.id` + `operator_venues` allowlist), shapes `AuthError` as 401/403 JSON, and threads `{operator, params}` into the inner handler. Operator-venues with **zero rows** means an operator has no venue access — the queue returns `{drafts: []}`, the action endpoints return 404 (don't leak existence).

**State machine.** `messages.review_state` is a **separate axis from `messages.status`** (migration 018). Five values: `pending` (draft awaiting review — TAC-212 will set this), `approved` (operator approved, Sendblue dispatched), `edited` (operator edited body, Sendblue dispatched with the edit), `skipped` (operator chose nothing), `auto_sent` (never queued — set by the autonomous-agent path via `lib/agent/schedule-and-send.ts`). NULL for inbound rows and pre-TAC-258 outbounds (the migration backfilled the latter to `'auto_sent'`).

**Idempotency.** Approve + edit + skip use optimistic conditional UPDATEs that gate on `review_state='pending'`. Rowcount=0 means another caller already acted (or the row was never pending) — surface as 200 `{status: 'already_acted', reviewState: ...}`. The migration 006 `provider_message_id` unique constraint is the second backstop against double-send. There's no explicit transaction wrapper — the conditional UPDATE is itself atomic, and the small TOCTOU window before the Sendblue call is acceptable v1.

**Undo.** 3-second server-side window enforced via `now() - last_operator_action_at < 3000ms`. Only skip→pending is truly revertible; approve and edit can't be unsent so undo on those fires a PostHog event with `undoneAfterDispatch=true` and leaves state alone. Operator-mismatch (different operator's action) returns 403. Outside the window returns 409 Conflict with `code: 'UNDO_WINDOW_EXPIRED'`. v1 supports single-level undo only.

**Edit path persistence.** Mobile-operator edit overrides `messages.body` (canonical sent text invariant — see plan v3 §7). The operator's text is also written to `response_review.editedMessage` (the "human edited this" signal), and the AI's pre-edit draft is captured in `response_review.originalAiBody` (closes the Langfuse-retention gap so single-row diff queries work). Voice corpus ingestion uses `upsertCorpusEdit` with `source_ref = 'operator-approve:{messageId}'` (registered in `lib/voice-training/channels.ts`) in `'replace'` mode. **Anti-corpus-poisoning rule still applies** — only the operator's final text is embedded; the AI draft never is. The route mirrors cc-review's circuit-breaker chain: corpus → response_review stamp (last). On already-acted, do NOT re-stamp `response_review` (the first operator's stamp wins).

**v1 failure-recovery gap.** If Sendblue throws after the optimistic state flip, the row is left in `review_state='approved'` (or `'edited'`) with `provider_message_id=NULL`. The queue no longer surfaces it; the operator can't retry via the queue. Recovery is manual SQL or a future `failed_dispatch` reconciliation cron. Mitigation: dispatch errors return 502 from the route — the mobile client surfaces a generic "send failed" toast. **Follow-up ticket needed** for `failed_dispatch` state + reconciliation cron; track post-merge.

**PostHog events.** `operator_message_approved`, `operator_message_edited`, `operator_message_skipped`, `operator_message_action_undone` — all in `lib/analytics/posthog.ts`. IDs-only payload shape per the operator-side precedent (`voice_critique_committed`); bodies live on the row and Langfuse. `operator_message_edited` carries length-delta scalars (`bodyLengthBefore`, `bodyLengthAfter`, `bodyLengthDeltaPct`), not the bodies themselves. None of these post to Slack — they're product analytics, not operational alerts.

## Synthetic guests

Four synthetic guests are seeded per venue when `run-test-scenarios` runs against that venue for the first time. Deterministic phone numbers, reused across venues:

- `+15550001000` — `new`
- `+15550001100` — `returning`
- `+15550001200` — `regular`
- `+15550001300` — `raving_fan`

Each is marked `is_test_synthetic = true` (migration 007). Per-venue history rows (transactions, messages, engagement_events) are seeded with `created_at` ≥30 days old so the recent-conversation block stays empty during testing. The seeded values are tuned so `computeGuestState` lands in the right band. If recognition formula changes, re-tune `seedSignalsForState` in `scripts/onboarding/run-test-scenarios.ts`.

If a state lands in the wrong band, the script logs all four outcomes and then throws (so the operator sees the full tuning picture, not just the first miss).

THE-184 tracks the alternative of fixture-based synthetic guests (skip the DB entirely) — picked up only if the DB-seeded approach becomes annoying to maintain.

---

## Environment variables

One line per var, grouped by purpose. This section is the index — defaults and behavior live in the relevant sections (Observability, Drive integration, Admin scaffold) and are not duplicated here.

- **LLM:** `ANTHROPIC_API_KEY`.
- **Embeddings:** `VOYAGE_API_KEY`.
- **Database (Supabase):** `SUPABASE_SECRET_KEY` (service role, `lib/db/admin.ts`); `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (browser client `lib/db/browser.ts`).
- **Messaging (Sendblue):** `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY` (outbound), `SENDBLUE_SIGNING_SECRET` (inbound webhook verification).
- **Drive:** `GOOGLE_DRIVE_VENUES_FOLDER_ID` (parent folder for venue artifact files 04–09).
- **Onboarding (Airtable):** `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE_ID` — read by `extract-venue-spec`.
- **Observability (Langfuse):** `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`; host as `LANGFUSE_BASE_URL` (preferred) or `LANGFUSE_HOST` (legacy alias); `LANGFUSE_ENABLED` (explicit kill-switch); `LANGFUSE_CAPTURE_CONTENT` (THE-216, default on).
- **Analytics (PostHog):** `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`.
- **Admin auth callback:** `NEXT_PUBLIC_ADMIN_URL` (per environment); `NEXT_PUBLIC_VERCEL_URL` (preview-deploy fallback).
- **Cron:** `CRON_SECRET` (bearer auth for Vercel cron handlers).
- **Scripts / dev:** `TEST_VENUE_ID` (used by `npm run send-test`); `NODE_ENV` (switches Langfuse + other dev/test branches).

---

## Common gotchas

- **`@/*` aliases in tests.** Resolved via `vitest.config.ts` (THE-231); previously a recurring cause of test-side import failures. Module-split pattern is still required when a transitively-imported module runs heavy SDK init at module load (see "Module split for testability").
- **Zod `.min()`/`.max()` on LLM output number fields.** Anthropic's structured output rejects these. Use `.refine()` or post-LLM validation. (THE-157.)
- **Permissive schema + filter-time validation pattern.** When the same field is validated at two boundaries (input parse + runtime), prefer strict at the offline boundary (parser/seed) and permissive-with-defensive-filter at the live boundary (runtime). Crashes during seed are catchable; crashes during agent runs hurt guests. Three instances: THE-157 (`.min()/.max()` rejected by Anthropic structured output, validate post-LLM), THE-150 (`expiresAt` stored as plain `z.string().optional()`; `filterActiveContext` parses + drops malformed entries with `console.warn` instead of failing the whole `venue_info` JSONB parse), THE-170 (mechanic `min_state` is strict `z.enum(GUEST_STATES)` at the parser boundary inside `parse-venue-spec.ts`, but `isStateAtLeast` at runtime treats unknown values defensively — drop the gated mechanic, log, don't crash).
- **`filterActiveContext` (THE-150).** Pure helper at `lib/schemas/venue-info.ts`. Drops `currentContext` entries whose `expiresAt` is past or equal to `now`; entries with no `expiresAt` are permanent; malformed `expiresAt` logs and drops. Wired in `build-runtime-context.ts` via the same `computedAt` reused for the recognition snapshot (single "now" per agent run).
- **Re-seeding via `npm run seed-venue` for voice training.** Don't. Phase 5 voice training uses surgical updates via `ingest-response-review`. Re-seed only when the venue spec markdown itself changed structurally.
- **Drive ADC re-auth.** Tokens expire. If you see `invalid_grant` / `invalid_rapt`, re-run `gcloud auth application-default login --client-id-file=... --scopes=...`.
- **gcloud Python version.** Workspace install can break against newer Python. If `gcloud` errors with Python version mismatch, set `CLOUDSDK_PYTHON` to a specific Python 3.10-3.14 binary.
- **Migration application order.** Always apply the migration in Supabase Studio BEFORE running scripts that depend on it locally. Hand-patches to `db/types.ts` are temporary; `npm run db:types` is the resolution.
- **`venue_configs.brand_persona` vs `venues.brand_persona`.** It lives on `venue_configs`, not `venues`. Check `build-runtime-context.ts` for the canonical access pattern.
- **`response_review.reviewedVia` is optional with a read-time default (TAC-258).** `MessageReviewSchema` added `reviewedVia: z.enum(['cc_review', 'mobile_operator']).optional()` without bumping `schemaVersion`. Pre-TAC-258 cc-review rows don't carry the field. Readers MUST go through `getReviewedVia(review)` from `lib/schemas/message-review.ts`, which defaults missing values to `'cc_review'` (the only pre-existing channel). New writes on the cc-review path stamp the field explicitly; the mobile-operator edit path always stamps `'mobile_operator'`. Don't try to read `review.reviewedVia` directly — you'll get `undefined` on legacy rows and silently fall through wrong branches.
- **`response_review.originalAiBody` only set on the mobile-operator edit path (TAC-258).** For mobile-operator edits, the route overwrites `messages.body` with the operator's text (preserving the `body = canonical sent text` invariant cc-review depends on), and captures the pre-edit AI draft in `response_review.originalAiBody`. cc-review never sets `originalAiBody` — `messages.body` already carries the AI draft because cc-review is post-hoc. So a non-null `originalAiBody` is the strongest signal of "this row went through the mobile approval queue's edit path."
- **`voiceAntiPatterns` shape (THE-236).** Stored shape is `Array<{ text, source: 'auto' | 'manual', authorOperatorId?, addedAt? }>`. **The DB is in a dual-shape state in perpetuity:** legacy `string[]` entries from rows last written before THE-236 stay legacy until any writer touches them; new and migrated rows persist as struct. `BrandPersonaSchema` accepts both forms and normalizes string entries to `{text, source: 'manual'}` on parse, so all in-process code sees the struct shape uniformly — but the JSONB on disk does not. Three rules follow:
  - **Always go through `BrandPersonaSchema`.** Reading `venue_configs.brand_persona->'voiceAntiPatterns'` directly via SQL or a JSONB path expression breaks on the legacy half of the fleet — `jsonb_array_elements_text` works on legacy rows, `... ->> 'text'` works on migrated rows, neither works on both. If you need a SQL query that touches anti-patterns, write the union explicitly (`CASE WHEN jsonb_typeof(elem) = 'string' THEN elem #>> '{}' ELSE elem ->> 'text' END`) or load the row in app code and parse with the schema.
  - **Readers must reach for `.text` on each entry.** Code that previously rendered the entry directly (`${a}`) prints `[object Object]` after parse; the serializer is updated, any new UI is not exempt.
  - **Writers must take a `{ source, authorOperatorId? }` opts arg.** `dedupeAndAppendAntiPatterns` is the only current writer; any new helper that mutates this field must stamp the metadata so the migrated rows don't lose attribution.
- **Loyalty-program language is forbidden.** Points / rewards / tier / earn / badges / progress-bars in operator-facing or guest-facing surfaces violates the product principles at the top of this file. The voice critique system (THE-237/238) catches some drift; do not rely on it. Guests are *recognized*, not *enrolled*. If you write "this perk has been earned," the framing is wrong.
- **In-place mechanic edits without re-seed (THE-170).** `seed-venue` hard-fails on existing slugs and a full re-seed cascades through `venue_configs`/`mechanics`/`voice_corpus`/`voice_embeddings`/etc — destroying any Phase 5 voice corpus additions written by `ingest-response-review`. To update mechanic eligibility gates without losing voice training, run a SQL `UPDATE` directly in Supabase Studio:
  ```sql
  -- Set The Joey to regulars-only on mock-central-perk
  update mechanics
  set min_state = 'regular'
  where venue_id = (select id from venues where slug = 'mock-central-perk')
    and name = 'The Joey';

  -- Renewable mechanic example (free first drink each month)
  update mechanics
  set redemption_policy = 'renewable',
      redemption_window_days = 30
  where venue_id = (select id from venues where slug = 'mock-central-perk')
    and name = 'First Drink Free';

  -- Mark a mechanic as redeemed for a specific guest. mechanic_id FK column is
  -- the source of truth; the data jsonb mirrors it for self-describing rows.
  insert into engagement_events (venue_id, guest_id, event_type, mechanic_id, data)
  values (
    (select id from venues where slug = 'mock-central-perk'),
    '<guest_uuid>',
    'mechanic_redeemed',
    '<mechanic_uuid>',
    jsonb_build_object(
      'mechanic_id', '<mechanic_uuid>',
      'source', 'operator_marked',
      'recorded_by_operator_id', '<operator_uuid>',
      'notes', 'Walk-in redemption on 2026-04-29'
    )
  );
  ```
  After updating, re-run `npm run run-test-scenarios mock-central-perk` to verify expected behavior. Per-guest data jsonb shape is documented by `MechanicRedeemedDataSchema` in `lib/recognition/eligibility.ts`. Proper upsert flow tracked in THE-196.
- **Granting analog admin access (THE-199).** `operators.is_analog_admin` defaults `false`. To grant access to `admin.theanalog.company`, run a SQL `UPDATE` directly in Supabase Studio:
  ```sql
  -- Grant admin access. Use the operator's email; do not interpolate the value
  -- into the query — type it manually so this template can't be copy-pasted
  -- against the wrong row.
  update operators
  set is_analog_admin = true
  where email = '<email>';
  ```
  No app code automates this — it's one operator at a time, by hand, with someone reviewing. Mirrors the friction-by-placeholder pattern from the seed-venue error template. Revoking is the same statement with `false`.
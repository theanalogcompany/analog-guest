# analog-guest

This is the messaging engine for Analog — a guest recognition platform for independent cafes, bakeries, and restaurants. This repo handles inbound and outbound messages between venues and their guests, plus the AI generation, classification, and routing logic. The operator-facing dashboard lives in a separate repo (`analog-operator`) and calls into this repo's API.

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
- **Messaging:** iMessage + SMS fallback (Sendblue as the current provider). One dedicated number per venue.
- **LLM:** Anthropic API via the Vercel AI SDK abstraction layer (model-agnostic from day one)
- **Embeddings:** Voyage
- **Drive integration:** Google Drive + Sheets API for the venue onboarding artifact pipeline (06-09 files described below)
- **Analytics:** PostHog for product/event analytics, Slack for operational alerts

Treat the database, messaging, and LLM providers as swappable. Code should depend on internal interfaces (e.g., `lib/messaging/send.ts`), not on vendor names.

---

## Folder layout

### App and library code

- `app/api/` — route handlers (webhooks, internal API for operator)
- `lib/db/` — database clients and queries (currently backed by Supabase). `lib/db/admin.ts` exports `createAdminClient` for service-role access in scripts and crons.
- `lib/messaging/` — message send + receive + webhook verification (currently backed by Sendblue)
- `lib/ai/` — AI SDK setup, prompts, classification, generation. Contains `classify-message.ts`, `generate-message.ts`, the `SYSTEM_TEMPLATE`, and the universal voice rules R1-R7.
- `lib/rag/` — embedding (`ingestCorpusEntry`), retrieval, the `match_voice_corpus` RPC wrapper
- `lib/recognition/` — relationship strength scoring, state machine logic (`computeGuestState`, `computeRelationshipStrength`, `loadSignals`, `normalize-signals`), threshold evaluation
- `lib/agent/` — orchestration layer. `build-runtime-context.ts` (assembles RuntimeContext for a single agent run), `stages.ts` (classify → retrieve → generate stage functions), `handle-inbound.ts`, `handle-followup.ts`. The agent module owns the per-request lifecycle.
- `lib/drive/` — Google Drive helpers used by the operator app side
- `lib/analytics/` — PostHog event emission helpers (events fire and forget; failures must not crash the agent path)

### Scripts

- `scripts/` — top-level CLI entry points. Each is a thin orchestrator that reads args, sets up clients, calls helpers, logs progress.
- `scripts/onboarding/` — helpers used by the onboarding pipeline scripts. One helper module per pipeline step. Helpers may be split into `<name>-pure.ts` (no `@/*` imports, vitest-loadable) and `<name>.ts` (DB-touching wrapper) when tests need to load the pure logic — see "Module split for testability" below.
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
- Errors are values for internal functions: return `{ ok: true, data }` or `{ ok: false, error }`. Throw only at outer boundaries (route handlers, scripts).
- Imports use the `@/*` alias for repo-relative paths in app/lib code. Scripts may use either `@/*` or relative imports; see "Module split for testability" for when relative imports are required.

### Module split for testability

Vitest can't always resolve `@/*` aliases when test files transitively import application code that pulls in heavy dependencies (Voyage SDK, Supabase admin client, etc.). When this happens, split the helper module:

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

### Audit-first

Before writing any code for a new ticket, read:
1. This file (CLAUDE.md)
2. The relevant existing files the new code will sit next to (e.g., for a new script in `scripts/`, read at least one existing script in the same directory)
3. The migrations that touch the relevant tables
4. Any existing tests for the modules being modified

Cite specific file paths and existing patterns in your plan. Don't infer architecture from filenames; read the actual code.

### Plan → review → build → review → commit

1. **Plan only on the first request.** Output a written plan covering scope, file paths, function decomposition, sequence of operations, existing patterns to reuse, edge cases, what you intentionally chose NOT to do, and open questions. Stop and wait for review.
2. **Build only after the plan is approved.** A second prompt will explicitly authorize the build per the approved plan.
3. **Verify and report.** After building, run `npx tsc --noEmit` and `npx vitest run`. Report file changes, test count, deviations from the plan, and anything you'd push back on.
4. **Commit only after review.** Don't commit until the human says go.

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
- `006_idempotency_and_inbound_message_origin.sql` — adds unique constraint on `messages.provider_message_id` as last-line defense against duplicate orchestrator runs (replaces the prior regular index), and extends `guests.created_via` to include `'inbound_message'` for guests auto-created from unrecognized phone numbers texting in. Inbound→outbound message linking already exists via `messages.reply_to_message_id` from migration 001 — no schema change needed for that. Visit dedupe timezone fix and `venue_info.currentContext` are app-side changes, not migrations.
- `007_test_synthetic_guests.sql` — adds `is_test_synthetic` boolean to `guests` (default false, not null) plus a partial index on `(venue_id, is_test_synthetic) WHERE is_test_synthetic = true`. Used by `run-test-scenarios` (THE-181) to mark synthetic guests seeded for Phase 5 testing so analytics can filter them out. Synthetic guests are still per-venue (schema-required); the deterministic phone numbers `+15550001000/100/200/300` are reused across venues but each venue gets its own four guest rows.
- `008_voice_corpus_source_ref.sql` — adds `source_ref text` column to `voice_corpus`, extends the `source_type` check constraint to include `'operator_edit'`, and adds a partial unique index on `(venue_id, source_ref) WHERE source_ref IS NOT NULL`. Enables idempotent upsert-by-source-ref for `ingest-response-review` (THE-178), which keys voice corpus rows on `'08-review:{sample_id}'` so re-runs don't duplicate.

RLS policies will be added in a future migration before any external user gets DB access (THE-110).

---

## Scripts

One-off scripts live in `scripts/` and run via `tsx` with env loading from `.env.local`. To add a new script: drop the file in `scripts/` (CLI orchestrator) and `scripts/onboarding/<name>.ts` (helpers, if it's part of the onboarding pipeline), add a `package.json` entry of the form `"<name>": "tsx --env-file=.env.local scripts/<file>.ts"`, run with `npm run <name> -- <args>`.

### Available scripts

- `npm run send-test -- <phone> [body]` — sends a test message via the messaging module to the given E.164 phone number. Requires `TEST_VENUE_ID` in `.env.local` pointing to a venue row that has `messaging_phone_number` set.
- `npm run extract-venue-spec -- <slug>` — reads the venue's onboarding transcript + Airtable record + menu CSV from Drive, calls Sonnet to extract a structured venue spec, writes `06-{slug}-venue-spec-draft.md` to the venue's Drive folder.
- `npm run extract-test-scenarios -- <slug> [--force]` — reads the venue spec + the categories fixture, calls Sonnet to generate venue-tailored test scenarios (THE-180), writes `07-{slug}-test-scenarios.json` to Drive. `--force` overwrites an existing 07-file.
- `npm run seed-supabase -- <slug>` — reads the 06-spec markdown from Drive, parses it via Zod schemas, ingests into the database (venue, venue_configs, mechanics, voice_corpus + embeddings via Voyage). Idempotent guards against accidental re-seed.
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

---

## Testing

Vitest is the test runner. Tests are colocated with source files (`module.test.ts` next to `module.ts`). Pure functions get unit tests; DB-touching code generally doesn't (live-DB tests aren't worth the harness yet).

- Run all: `npx vitest run`
- Run single file: `npx vitest run path/to/file.test.ts`
- Watch mode for development: `npx vitest`

Test count baseline: 71 tests across 5 files as of THE-178 ship (2026-04-29). Don't let regressions land — every PR should keep tests green.

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
- **Trace-level observability.** Per-run visibility into the agent's reasoning (corpus retrieval scores, prompt content, fidelity self-rating, etc.). Currently scattered across console.log calls. The right answer is probably Langfuse self-hosted; spike ticket pending.

---

## AI agent runtime contract

These constraints are real and have caused bugs:

- **Voice fidelity floor:** the agent self-rates voice fidelity. Below 0.4, regenerate. Above 0.4 send. (THE-187 will alert on the 0.4-0.5 band as "low but sent.")
- **Corpus retrieval floor:** retrieval is fail-closed. Need at least 3 matches above 0.65 similarity to proceed; otherwise the agent bails to a fallback acknowledgment.
- **Recent conversation block:** the last 14 days of messages between this guest and this venue are loaded into RuntimeContext. THE-173 added this; future changes to the window should consider impact on synthetic-guest seeding (`run-test-scenarios` seeds messages >30 days old to keep this block empty during testing).
- **Today's date in context:** `RuntimeContext.todayInVenueTimezone` is set from `new Date()` at runtime, formatted in the venue's timezone. THE-174 added this so the agent answers "are you open today?" correctly.
- **Universal voice rules R1-R7:** live in `SYSTEM_TEMPLATE`. Apply to every agent on every venue. Don't reference actions the guest didn't take, give today's specific answer, no em dashes, don't reference physical artifacts the agent doesn't have, don't redirect to alt channels for things the venue can answer, yes/no questions get yes/no answers, don't restate context already in the conversation.

---

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

## Common gotchas

- **`@/*` aliases in test files.** Vitest can't resolve them when transitive imports pull in heavy deps. Use the module-split pattern (see "Module split for testability").
- **Zod `.min()`/`.max()` on LLM output number fields.** Anthropic's structured output rejects these. Use `.refine()` or post-LLM validation. (THE-157.)
- **Re-seeding via `seed-supabase.ts` for voice training.** Don't. Phase 5 voice training uses surgical updates via `ingest-response-review`. Re-seed only when the venue spec markdown itself changed structurally.
- **Drive ADC re-auth.** Tokens expire. If you see `invalid_grant` / `invalid_rapt`, re-run `gcloud auth application-default login --client-id-file=... --scopes=...`.
- **gcloud Python version.** Workspace install can break against newer Python. If `gcloud` errors with Python version mismatch, set `CLOUDSDK_PYTHON` to a specific Python 3.10-3.14 binary.
- **Migration application order.** Always apply the migration in Supabase Studio BEFORE running scripts that depend on it locally. Hand-patches to `db/types.ts` are temporary; `npm run db:types` is the resolution.
- **`venue_configs.brand_persona` vs `venues.brand_persona`.** It lives on `venue_configs`, not `venues`. Check `build-runtime-context.ts` for the canonical access pattern.
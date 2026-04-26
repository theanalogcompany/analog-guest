# analog-guest

This is the messaging engine for Analog — a guest recognition platform for independent cafes, bakeries, and restaurants. This repo handles inbound and outbound messages between venues and their guests, plus the AI generation, classification, and routing logic. The operator-facing dashboard lives in a separate repo (`analog-operator`) and calls into this repo's API.

## Product principles (do not violate)
- Recognition, not loyalty. Guests do not "earn" things — they get recognized.
- Messages to guests can come from a few different framings depending on what the venue approves: from the venue itself (default), from a named person at the venue ("[Name] from [Venue]"), or from the owner directly when the owner approves that framing. The default is venue-level until told otherwise per venue.
- Every venue is its own isolated block: own messaging number, own voice corpus, own config, own data.
- The product is messaging-only. There is no guest app. Do not assume a frontend for guests.

## Tech stack
- TypeScript, strict mode
- Next.js (App Router) deployed on Vercel
- Postgres database with pgvector, plus Auth and Storage (Supabase as the current provider)
- Messaging via an iMessage + SMS fallback provider (Sendblue as the current provider)
- LLM via Anthropic API; embeddings via Voyage
- Vercel AI SDK as the LLM abstraction layer (model-agnostic from day one)

Treat the database, messaging, and LLM providers as swappable. Code should depend on internal interfaces (e.g., `lib/messaging/send.ts`), not on vendor names.

## Code conventions
- Industry-standard TypeScript and Next.js naming. PascalCase for components and types, camelCase for functions and variables, kebab-case for filenames, SCREAMING_SNAKE for env vars.
- Prefer functions over classes
- Async/await over `.then()`
- Zod for runtime validation at all API boundaries
- No `any` types. Use `unknown` and narrow.
- Errors are values for internal functions: return `{ ok: true, data }` or `{ ok: false, error }`. Throw only at outer boundaries (route handlers, scripts).

## Folder layout
- `app/api/` — route handlers (webhooks, internal API for operator)
- `lib/db/` — database clients and queries (currently backed by Supabase)
- `lib/messaging/` — message send + receive + webhook verification (currently backed by Sendblue)
- `lib/ai/` — AI SDK setup, prompts, classification, generation
- `lib/rag/` — embedding, retrieval
- `lib/recognition/` — state machine, thresholds, events
- `db/migrations/` — SQL migrations (single source of DB truth)

## Workflow rules for Claude Code
- Always show me the plan before writing code I haven't asked for
- For any new file, propose the path first
- When unsure about product behavior, ask — do not guess
- Commit messages: lowercase, imperative ("add inbound webhook handler"), no emoji

## Scripts

One-off scripts live in `scripts/` and run via `tsx` with env loading from `.env.local`.

- `npm run send-test -- <phone> [body]` — sends a test message via the messaging module to the given E.164 phone number. Requires `TEST_VENUE_ID` in `.env.local` pointing to a venue row that has `messaging_phone_number` set. Used to validate the messaging pipeline end-to-end.

To add a new script: drop the file in `scripts/`, add a `package.json` entry of the form `"<name>": "tsx --env-file=.env.local scripts/<file>.ts"`, run with `npm run <name> -- <args>`.

## Database migrations

Migrations live in `db/migrations/` numbered sequentially. Each migration is hand-written SQL, run against Supabase via the SQL Editor, then `npm run db:types` regenerates `db/types.ts`.

- `001_initial_schema.sql` — 13 tables: venues, operators, operator_venues, venue_configs, guests, mechanics, transactions, messages, engagement_events, guest_states, voice_corpus, voice_embeddings, audit_log. Includes the shared `updated_at` trigger function.
- `002_add_message_reactions.sql` — adds `reaction_type` column to `messages`, extends the category check to include `'reaction'`, updates the content constraint to allow rows with only a reaction_type, and adds a consistency check between `category` and `reaction_type`.
- `003_ai_module_refinements.sql` — batches schema changes from AI module design: renames `messages.confidence_score` to `voice_fidelity` for terminology consistency; adds `review_reason` and `pending_until` columns to support routing audit trail and the hold-and-fallback workflow; extends `messages.category` check to include `'acknowledgment'` for fallback messages.

RLS policies will be added in a future `003_enable_rls.sql` migration before any external user gets DB access.
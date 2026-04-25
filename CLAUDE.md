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
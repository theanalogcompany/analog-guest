# analog-guest

The messaging engine for Analog, a guest recognition platform for independent cafes, bakeries
and restaurants. Inbound and outbound messages between venues and their guests, plus the AI
generation, classification and routing. Also hosts the internal Command Center
(`app/admin/*`), served on `admin.theanalog.company`.

A separate venue-operator dashboard (`analog-operator`) is a different repo; bearer-token
scaffolding for it lives in `lib/auth/`.

## Where things are written down

This file holds what **every** task needs. Everything else is routed:

| what you have | where it goes |
| --- | --- |
| a rule every task needs | here |
| a rule one directory needs | that directory's `CLAUDE.md` |
| a rule that follows a file pattern | `.claude/rules/` |
| why a decision was made | that source file's header comment |
| an incident, a measurement run | the PR body |
| a cross-cutting decision people re-litigate | `docs/decisions/README.md` indexes them |
| per-ticket narrative | nowhere. Git has it. |

**Do not append subsystem detail here.** This file was 1.34 MB and 376k tokens, which
exceeded a subagent's entire context window and broke every `.claude/agents/*` and every
subagent handoff. Keep it an index. Full
reasoning: `docs/decisions/0001-claude-md-is-an-index.md`.

Nested files load only when Claude reads a file in that directory, so they cost nothing
otherwise. `@path` imports are **eager** and do not help.

| read this when you work in that directory | covers |
| --- | --- |
| `lib/agent/CLAUDE.md` | orchestrators, stage pipeline, floors, the 20 approval triggers, pending slots, coalescing, intentions |
| `lib/ai/CLAUDE.md` | `generateObject` patterns, the schema budget, the four verifiers, truncation |
| `lib/ai/prompts/CLAUDE.md` | prompt assembly order, universal voice rules, channel copy, serializers |
| `lib/messaging/instagram/CLAUDE.md` | the Meta half: signatures, echoes, the reply window, tokens, deletion |
| `db/migrations/CLAUDE.md` | apply order, high-stakes tables, the SQL patterns this schema uses |
| `lib/operator/CLAUDE.md` | venue scope, queue Contract fields, card copy, dispatch |
| `lib/relationship/CLAUDE.md` | **the v2 relationship engine** (graph, missions, moves, profiles, memory, policy gate, judge) - replaces intentions + recognition bands when the per-venue flag flips; read before touching either |
| `lib/guests/CLAUDE.md` | commitment CAS and dedup, guest context, visit precision |
| `lib/notifications/CLAUDE.md` | APNs env validation, `PUSH_POLICY`, payload privacy, badges |
| `lib/observability/CLAUDE.md` | the Langfuse wrapper, the span tree, and **where the latency and prompt-cache numbers already live** - read before answering any latency question |
| `app/admin/CLAUDE.md` | route paths, loaders, write routes, brand tokens |
| `scripts/CLAUDE.md` | onboarding pipeline, measurement harness convention, Drive auth |
| `.github/CLAUDE.md` | what a CI session may run, and the known gaps in that allowlist |

`.claude/rules/` holds `prompt-versioning.md` and `errors-as-values.md`. `.claude/process.md` is canonical for Linear statuses, labels and
markers.

## Product principles (do not violate)

- **Recognition, not loyalty.** Guests do not "earn" things, they get recognized. No
  loyalty-program language ("points", "rewards", "tier", "earn") in guest-facing output,
  system prompts, or operator-facing copy.
- **Speaker framing is per-venue.** From the venue itself (default), from a named person, or
  from the owner. Venue-level until told otherwise per venue.
- **Every venue is its own isolated block.** Own number, voice corpus, config, data.
  Cross-venue queries are Analog-internal only.
- **Messaging-only.** There is no guest app. The guest's only surface is the conversation.
- **Voice is the product.** Treat voice quality as first-class, not polish-later.

## Stack

TypeScript strict · Next.js App Router on Vercel · Postgres with pgvector, Auth and Storage
(Supabase today) · iMessage/SMS with one number per venue (Sendblue today) · Instagram DM as a
second inbound channel (Meta, Instagram Login path) · Anthropic via the Vercel AI SDK ·
Voyage embeddings · Google Drive + Sheets for onboarding artifacts · PostHog for events,
Slack for alerts, Langfuse for traces.

**Treat database, messaging and LLM providers as swappable.** Depend on internal interfaces
(`lib/messaging/send.ts`), never on vendor names.

Webhooks live on `webhooks.theanalog.company`; future integrations inherit that subdomain.

## Code map

| path | owns |
| --- | --- |
| `app/api/` | route handlers: webhooks, the operator API |
| `app/admin/` | Command Center (auth-gated, host-gated) |
| `lib/agent/` | per-request orchestration: context, stages, gates, dispatch |
| `lib/ai/` | model calls, prompts, classification, the verifier family |
| `lib/messaging/` | send/receive/verify; `instagram/` is the Meta half |
| `lib/db/` | clients and queries; `admin.ts` exports `createAdminClient` |
| `lib/rag/` | embedding, retrieval, the `match_*` RPC wrappers |
| `lib/recognition/` | relationship scoring, state bands, mechanic eligibility |
| `lib/guests/` | per-guest context, commitments, cron processors |
| `lib/operator/` | operator API building blocks |
| `lib/notifications/` | APNs push |
| `lib/relationship/` | v2 relationship engine: graph, state, profile/memory, turn runner (detail: its `CLAUDE.md`) |
| `lib/policy/` | v2 policy gate: registry, Jev semantic check, decision table (detail: `lib/relationship/CLAUDE.md`) |
| `lib/eval/` | v2 maitre d' judge (detail: `lib/relationship/CLAUDE.md`) |
| `lib/followups/` | the follow-up engine and its detectors |
| `lib/schemas/` | Zod schemas for JSONB fields. Read JSONB through these, never raw SQL paths |
| `lib/auth/` | cookie-session admin gate, bearer operator gate, venue scope |
| `lib/observability/` | Langfuse wrapper. Never import `langfuse` directly from app code |
| `lib/ui/` | brand primitives; `components/ui/` is vendored shadcn |
| `db/migrations/` | hand-written SQL, the single source of DB truth |
| `scripts/` | CLI entry points; `onboarding/`, `lib/`, `measurement/` |
| `docs/brand/style-guide-v01.html` | the visual language. Reference material, do not modify; updates land as a new version |

## Conventions

Industry-standard TypeScript and Next.js naming: PascalCase components and types, camelCase
functions, kebab-case filenames, SCREAMING_SNAKE env vars. Prefer functions over classes,
`async/await` over `.then()`, Zod at every API boundary. No `any` - use `unknown` and narrow.
`@/*` alias for repo-relative imports.

**Errors are values.** `{ok: true, data} | {ok: false, error}`, throwing only at outer
boundaries. Failure *direction* is a design decision, not a style choice - see
`.claude/rules/errors-as-values.md`.

**Never use `.min()` or `.max()` on a number field in an LLM-output schema** - Anthropic's
structured output rejects them. Same for `.max()` on an array (`maxItems`); `.min()` on an
array is fine. Cap with `.slice(0, N)` after the call.

**Propose a new file's path before creating it.** Match the directory's pattern; do not invent
a new top-level directory without asking.

## Workflow

**Tickets are optional.** A ticket is not a precondition for planning or building; work can
start without one. When one does exist, cross-repo work is two tickets, one per repo, linked -
never one ticket carrying both repo labels.

**Plan, review, build, review, commit.** Output a written plan first (scope, file paths,
decomposition, sequence, patterns to reuse, edge cases, what you chose *not* to do, open
questions) and stop. Build only on explicit authorization. Then run `npx tsc --noEmit` and
report changes, deviations, and anything you would push back on. Commit only when told.

**Two gates above that:**

- **Hard stop** - `lib/auth/`, `verifyAnalogAdminAccess`, RLS, payment/Stripe, Sendblue webhook
  handlers, or a migration against `messages` / `engagement_events` / `voice_corpus`. Post the
  plan as `[PLAN]`; on approval post `[HUMAN-REVIEW-REQUIRED]` and **stop** - a human drives
  the build.
- **Plan gate** - the agent runtime contract: retrieval floors, the
  universal voice rules. Post `[PLAN]`, wait, then build and open a draft PR.

Neither tier proceeds on `[NEEDS-INPUT]` alone. A change to guest-facing copy shows the new
wording **verbatim** in the plan and waits for approval of that wording.

**Audit first.** Before writing code: this file, the nested `CLAUDE.md` for the directory,
the neighbouring files, and the migrations touching the relevant tables. Cite specific
paths in the plan. Do not infer architecture from filenames.

**Comment protocol.** Every Linear comment opens with `**[FROM CLAUDE CODE]**` on its own
line - Linear shows Jaipal as author of MCP-posted comments, so the prefix is the only
distinguisher. A clarifying question is `[NEEDS-INPUT]`, numbered, plus the `Needs Decision`
label, status unchanged, then stop. Post flat, never threaded. `.claude/process.md` is
canonical.

**Claim a ticket you are working from.** Post `[CLAIM]`, edit it to `released` when handing
back. Not a gate on starting work - but two sessions on one ticket has happened, and a human
cancelling the run was all that stopped it. A second local session works in its own
`git worktree`, pushes by explicit refspec (`git push origin <branch>:<branch>`), and runs
`git branch --show-current` immediately before its first commit - two sessions in one checkout
share one HEAD, and commits have landed on the wrong branch that way.

**Never just acknowledge.** If asked to remember or forget something, update memory. Do not
reply "I'll remember that" without doing it.

**When unsure, ask.** Do not guess product behaviour.

### Never write `.env.local`. Never run `vercel env pull`.

**Standing rule, no exceptions, under any flag, in any directory, for any reason.** When
credentials look missing, empty or wrong, **stop and ask the operator.** Do not try to
repopulate them.

`.env.local` is operator-owned local state existing in exactly one place on one machine. It is
gitignored, in no backup this repo controls, and there is no safe idempotent command that
rebuilds it.

The rule is absolute because every plausible guard failed once: `vercel env pull` destroyed 29
live keys. It **never merges, never prompts, never backs up** - and every variable in this
project is stored `Encrypted`, so it returns `KEY=""` for all of them while the CLI's diff
still prints a `+ KEY` line per key. It looks like a successful restore and writes nothing.
Five local keys are not in Vercel at all. Recovery last time came from VS Code's local file
history, which is luck, not a recovery path.

Reading `.env.local` is fine. Writing it is not. `vercel env ls` is read-only and is the right
command when the question is which variables exist.

### Git

Branch protection on `main`; everything goes through a PR. CI must be green:
`tsc --noEmit`, `npm run lint`, `npx prettier --check .`, `npx jscpd` (the duplication
gate; threshold in `.jscpd.json`), `npm run build`.
`.github/workflows/ci.yml` is the source of truth for this list - read it before claiming
a change is verified, because this line has been stale before (prettier shipped in TAC-554
and the list above missed it, and a branch failed CI on exactly that).

Branch `<your-username>/<ticket>-short-description`, ticket id lowercase. Any single path
segment works as the owner; `team/alex/<ticket>-x` and a bare `<ticket>-x` do not, because the
owner is what makes a branch attributable to a session. The pattern has **one** definition,
`TICKET_BRANCH_OWNER` in `scripts/lib/ticket-branch.mjs` - claim detection and the turn-limit
report both import it, so they cannot disagree about what a ticket branch is. See
`docs/decisions/0004-ticket-branch-owner-is-any-username.md`.

Commits: lowercase imperative, no emoji, `THE-XXX: <subject>` (or a `docs:`-style prefix with
no ticket). The body explains **why** when the change is not obvious. Never add your agent
name as co-author. Never hand-edit `CHANGELOG.md` or any generated file.

Merge with `gh pr merge <num> --squash --delete-branch`.

**Do not stack PRs.** A squash merge of the base **closes the child unmerged**, and reopening
is refused outright. Branch each PR from `main` and take the conflict at merge time: a merge
conflict is visible and recoverable, a destroyed PR object is not. Stack only when a PR
genuinely cannot be reviewed without its parent, and budget a replacement PR.

Pre-commit hook: lint-staged (`eslint --fix` + `prettier --write`) on staged files,
`tsc --noEmit` project-wide. Do not `--no-verify` without a reason - and
when the hook cannot run (an environment floor, e.g. git under lint-staged's minimum), the
manual substitute must mirror every step including lint-staged's prettier pass; skipping
the step the hook could not reach is how a formatting failure reaches CI as news. **In a `git worktree` the hook half-fails** on
`.git/index.lock` *after* those checks pass, and the commit still lands - check
`git status --porcelain` and `git show --stat HEAD` rather than reading `[FAILED]` as a
rejection.

### Cross-repo contracts

A ticket spanning this repo and a sibling carries a `## Contract` section pinning endpoint
paths, request and response shapes per status code (including the negatives), and env vars
character-exact. The Contract is the single source of truth.

- **Deviate from the Contract? Update the ticket FIRST**, during plan review. Never diverge
  silently from a stale Contract.
- **Server first.** Deploy and verify by `curl` against the Contract's exact shape before the
  client ticket starts. The bar is 401 on missing auth - not 404 (route not deployed where the
  Contract said) and not 400 on a valid body (schema diverged).
- **Manual end-to-end UAT gates the server ticket**, never deferred to the client.
- **Check against the Contract's literal payload, never against your own serialization.** A
  check written by reading the implementation can only confirm the code equals itself. A client
  check once *certified* a mismatch on every green run while five operator sends failed in
  production - and the server side was correct throughout.

## Migrations

`db/migrations/`, hand-written, numbered. **The operator applies them in Supabase Studio**,
then runs `npm run db:types`. Nothing in this repo runs a migration.

**Backwards-incompatible - deploy the code FIRST, then apply.** A `DROP COLUMN`,
`RENAME COLUMN`, `DROP FUNCTION`, `SET NOT NULL`, or a tightened `CHECK`. The reverse order
opens a window where deployed code queries a schema that no longer exists; it took
`admin.theanalog.company` down for three minutes once.

**Additive but the deployed code reads it - apply BEFORE merging.** Vercel deploys on merge,
so the first request after merge fails otherwise. On a webhook path that failure is invisible:
the route answers 200 and the guest's message is lost with no retry.

**Purely additive with no new reader - order does not matter.**

Everything else, including the high-stakes list and the SQL patterns: `db/migrations/CLAUDE.md`.

## Commands

| | |
| --- | --- |
| `npx tsc --noEmit` | typecheck. Run it directly, **never through a pipe** - `$?` after a pipe reports the pipe and has misread a failing typecheck as clean |
| `npm run lint` | eslint. `-- --fix` for the auto-fixable |
| `npm run build` | Next.js build |
| `npm run db:types` | regenerate `db/types.ts` after a migration |
| `npm run seed-venue -- <slug>` | ingest a 06-spec. First-write-only; `--force` rewrites config stores only |
| `npm run run-test-scenarios -- <slug>` | the scenario harness. **Run during the venue's open hours** |
| `npm run extract-venue-spec -- <slug>` | transcript to venue spec |
| `npm run ingest-response-review -- <slug>` | read the 08-sheet back into the corpus |
| `npm run send-test -- <phone> [body]` | one outbound via the messaging module |

`npm run` with no args lists the rest, including the measurement harnesses.

## Testing

This repo has no automated test suite. Verification is `npx tsc --noEmit`, `npm run lint`,
`npx prettier --check .`, `npx jscpd`, `npm run build`, and checking against the running
system: `curl` the real endpoint, or run the measurement harness the ticket names (`npm run`
lists them). For behaviour a human needs to see, say what to try by hand.

## AI agent runtime contract

The live floors, all in `lib/agent/stages.ts`. A number quoted anywhere else may be stale.

| | |
| --- | --- |
| voice pack (`lib/rag/voice-pack.ts`) | static per venue, no similarity; empty pack fails **closed** on inbound (decision 0008) |
| `KNOWLEDGE_RELEVANCE_FLOOR` 0.3 | knowledge retrieval, degrades **gracefully** |
| `PROMPT_VERSION` v1.87.0 | bumping it is a repo-wide sweep - `.claude/rules/prompt-versioning.md` |

**20 approval triggers compose; any one queues the draft.** The four post-generation LLM
checks run **post-send** on inbound (Slack forward on a finding, never a hold) and keep the
fail-**closed**-after-one-retry posture on followups and the holding message - treat a
posture change to one as a change to all four
(`docs/decisions/0003-post-generation-checks-fail-closed.md`). `lib/agent/CLAUDE.md` has the
trigger table and priority order.

A guest holds **two** pending cards, one per slot
(`docs/decisions/0006-two-pending-slots-per-guest.md`). A guest's burst of messages is **one**
turn (`docs/decisions/0005-inbound-coalescing-settle-window.md`).

`venues.status` gates processing as a **deny-list**, never an allow-list on `active` - the live
pilot venue is `pending` (`docs/decisions/0002-deny-list-not-allow-list.md`).

A getting-to-know-you question always goes out as its **own last message**, guaranteed at
generation rather than asked for in prose
(`docs/decisions/0007-intention-question-is-its-own-bubble.md`).

## Environment variables

One line per purpose. Defaults and behaviour live with the code that reads them.

**LLM** `ANTHROPIC_API_KEY` · **Jev classification** `JEV_API_KEY` · **Embeddings** `VOYAGE_API_KEY` · **DB** `SUPABASE_SECRET_KEY`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` · **Sendblue**
`SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, `SENDBLUE_SIGNING_SECRET` · **Instagram**
`META_VERIFY_TOKEN`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_APP_ID`, `INSTAGRAM_ACCESS_TOKEN`,
`INSTAGRAM_TOKEN_ENC_KEY`, `INSTAGRAM_OAUTH_REDIRECT_URL` · **APNs** `APNS_AUTH_KEY` (PEM
contents, multi-line, both armor lines), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`,
`APNS_ENV` · **Cron** `CRON_SECRET`, `EXTERNAL_CRON_SECRET` · **Langfuse**
`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `LANGFUSE_ENABLED`,
`LANGFUSE_CAPTURE_CONTENT` · **PostHog** `NEXT_PUBLIC_POSTHOG_KEY`,
`NEXT_PUBLIC_POSTHOG_HOST` · **Drive/Airtable** `GOOGLE_DRIVE_VENUES_FOLDER_ID`,
`AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE_ID` · **Admin**
`NEXT_PUBLIC_ADMIN_URL` · **Scripts** `TEST_VENUE_ID`

**Set every server-side var on Preview as well as Production.** A missing one surfaces as a
500 with an **empty body**, because the helper throws before any JSON response is shaped.

**A new credential var ships with its validator in the same PR**, in three parts: a pure shape
validator that never returns key material, first-call enforcement (**not** module-load - CI
sets no `APNS_*` at all, so a module-init throw breaks `tsc` and `next build`), and
an `/admin/health` row. A validator that only runs on the unhappy path of a fire-and-forget
call is not loud enough alone.

## Gotchas worth carrying everywhere

- **Ask what would fail if a claim were untrue.** The expensive defects here are a claim
  nothing enforces - a comment, a printed PASS, a schema default - and the claim
  is what stops anyone looking. If no input could make it fail, it proves nothing.
- **Fix the mechanism, never the symptom - and find the mechanism by ablation.** A fix is not
  proposed until something was *removed* and the defect went away. For a prompt that means
  leave-one-out over its units (frame paragraphs, brief sections, then clauses inside the
  guilty unit), and the fix is measured on sibling inputs it was never tuned on plus the case
  the guilty unit exists to protect. Copy that names the failing input passes its own test and
  leaves every sibling broken: a line answering "a good first order" was 11/11 on that phrase
  while the actual cause - the moves header telling the model its turn is for asking, in the
  last position before the guest's message, with nothing anywhere saying to answer - still
  swallowed every other answer-before-ask turn.
- **Arrange for something to disagree.** Careful reading catches none of those. A control arm,
  a reconciliation against a total, an independent tool. A number nobody can
  contradict is not evidence.
- **Later beats earlier in the composed prompt.** Proximity reads as authority; this has cost
  six separate defects.
- **A totality claim needs `satisfies Record<K, V>`.** `readonly K[]` is not
  exhaustiveness-checked.
- **When you find a well-named thing, confirm it has a reader before reasoning from it.** Three
  columns recorded first contact while named as activity timestamps; one config column sat
  unread for 102 days; one flag reads like a runtime switch and changes nothing.
- **Distrust any gate whose true-positive history you cannot produce.** One backstop fired once
  in its lifetime, on a false positive, and was read as working for two months.
- **A stray `.worktrees/` or `.claude/` worktree** adds a full repo copy to `eslint`
  runs. Config excludes them; a stray one still doubles per-file counts.

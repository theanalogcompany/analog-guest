# analog-guest

Messaging engine for the Analog guest recognition platform. Handles inbound
and outbound messages between hospitality venues and their guests, plus AI
generation, classification, and routing.

A guest texts a venue's number. This repo decides what comes back: it builds
the guest's context, retrieves the venue's own voice, drafts a reply, runs five
checks over that draft, and either sends it or queues it for a human operator to
approve. It also hosts the internal Command Center at `/admin`.

## Start here

Read in this order. The first two are enough to be useful; the rest are
reference you follow when a task takes you there.

| read | why |
| --- | --- |
| [CLAUDE.md](CLAUDE.md) | the index. Product principles, stack, code map, conventions, the runtime floors, the workflow gates. Written for agents, accurate for humans |
| [docs/decisions/README.md](docs/decisions/README.md) | the decisions people otherwise re-litigate, each with what breaks if you reverse it |
| the directory guide for wherever you land | table below |
| [.claude/process.md](.claude/process.md) | how a ticket moves: Linear statuses, labels, comment formats |

Then run it locally and follow one request through
[lib/agent](lib/agent/CLAUDE.md) with
[`lib/agent/stages.ts`](lib/agent/stages.ts) open beside it. Read that file by
its exported `*Stage` functions in the order they appear - classify, retrieve
corpus, retrieve knowledge, generate, the five verifiers, apply approval policy.
That sequence is one request's whole life. It is a 3,500-line file, so start at
`classifyStage`, not at the top.

## Directory guides

Each of these sits next to the code it describes and covers the traps that
directory has actually paid for. Agents load them automatically on touching the
directory; a human has to click.

| guide | covers |
| --- | --- |
| [lib/agent](lib/agent/CLAUDE.md) | orchestrators, stage pipeline, floors, the approval triggers, pending slots, coalescing, intentions |
| [lib/ai](lib/ai/CLAUDE.md) | `generateObject` patterns, the schema budget, the five verifiers, truncation |
| [lib/ai/prompts](lib/ai/prompts/CLAUDE.md) | prompt assembly order, universal voice rules, channel copy, serializers |
| [lib/messaging/instagram](lib/messaging/instagram/CLAUDE.md) | the Meta half: signatures, echoes, the reply window, tokens, deletion |
| [lib/operator](lib/operator/CLAUDE.md) | venue scope, queue Contract fields, card copy, dispatch |
| [lib/guests](lib/guests/CLAUDE.md) | commitment CAS and dedup, guest context, visit precision |
| [lib/notifications](lib/notifications/CLAUDE.md) | APNs env validation, `PUSH_POLICY`, payload privacy, badges |
| [app/admin](app/admin/CLAUDE.md) | route paths, loaders, write routes, brand tokens |
| [db/migrations](db/migrations/CLAUDE.md) | apply order, high-stakes tables, the SQL patterns this schema uses |
| [scripts](scripts/CLAUDE.md) | onboarding pipeline, measurement harness convention, Drive auth |
| [.github](.github/CLAUDE.md) | what a CI session may run, and the known gaps in that allowlist |

Three more rule files load by file pattern rather than by directory:
[errors as values](.claude/rules/errors-as-values.md) across `lib/` and
`app/api/`, and [prompt versioning](.claude/rules/prompt-versioning.md) in the
directories that own the composed prompt.

Design reference: [brand style guide](docs/brand/style-guide-v01.html) is the
visual language and is read-only, updates land as a new version.
[Command Center voices mockup](docs/command_center/voices_mockup_v01.html) is an
early mockup, not a spec, and the shipped UI is the authority where they differ.

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:3000. The Command Center is at `/admin` (sign-in via
magic link).

`npm install` also wires up the git pre-commit hook (via husky's `prepare`
script). The hook runs `eslint --fix` on staged `.ts/.tsx` files, then
`tsc --noEmit` against the full project. Any failure rejects the commit.

Environment variables: copy `.env.local.example` to `.env.local` and fill in
real values (ask the operator for the secrets bundle). Never regenerate
`.env.local` from Vercel - see CLAUDE.md for why that rule has no exceptions.

## Deployments

This repo deploys to two Vercel projects from the same branch:

- `analog-guest` - guest host (webhooks, public surfaces). Middleware 404s
  `/admin/*` here.
- `analog-admin` - `admin.theanalog.company`. Middleware 404s everything
  except `/admin/*` here.

Local dev and `*.vercel.app` previews serve everything for QA. The host gate
lives in root `middleware.ts`; [app/admin](app/admin/CLAUDE.md) covers how it
behaves per environment and the failure it produces when it is wrong.

## Pre-push checks

Before pushing, run the same checks CI runs:

```bash
npx tsc --noEmit && npm run lint && npx prettier --check . && npm run build
```

## CI

GitHub Actions runs `tsc --noEmit`, `eslint`, `prettier --check`, `jscpd`, and `next build`
on every pull request and push to `main`. Merge to `main` is blocked on red.

The workflow lives at `.github/workflows/ci.yml`. To configure branch
protection (one-time, after the first CI run):

1. Repo Settings → Branches → Branch protection rules → Add rule
2. Branch name pattern: `main`
3. Enable **Require status checks to pass before merging** and select
   `CI / ci`
4. Enable **Require branches to be up to date before merging**

# analog-guest

Messaging engine for the Analog guest recognition platform. Handles inbound
and outbound messages between hospitality venues and their guests, plus AI
generation, classification, and routing.

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:3000. The Command Center is at `/admin` (sign-in via
magic link).

`npm install` also wires up the git pre-commit hook (via husky's `prepare`
script). The hook runs `eslint --fix` on staged `.ts/.tsx` files, then
`tsc --noEmit` against the full project, then `vitest related --run` on the
staged files. Any failure rejects the commit.

Environment variables: copy `.env.local.example` to `.env.local` and fill in
real values (ask the operator for the secrets bundle).

## Deployments

This repo deploys to two Vercel projects from the same branch:

- `analog-guest` — guest host (webhooks, public surfaces). Middleware 404s
  `/admin/*` here.
- `analog-admin` — `admin.theanalog.company`. Middleware 404s everything
  except `/admin/*` here.

Local dev and `*.vercel.app` previews serve everything for QA. See
[CLAUDE.md](CLAUDE.md) "Admin scaffold" for the full setup.

## Pre-push checks

Before pushing, run the same checks CI runs:

```bash
npx tsc --noEmit && npm run lint && npx vitest run && npm run build
```

## CI

GitHub Actions runs `tsc --noEmit`, `eslint`, `vitest run`, and `next build`
on every pull request and push to `main`. Merge to `main` is blocked on red.

The workflow lives at `.github/workflows/ci.yml`. To configure branch
protection (one-time, after the first CI run):

1. Repo Settings → Branches → Branch protection rules → Add rule
2. Branch name pattern: `main`
3. Enable **Require status checks to pass before merging** and select
   `CI / ci`
4. Enable **Require branches to be up to date before merging**

## Architecture

See [CLAUDE.md](CLAUDE.md) for the project's product principles, tech stack,
code conventions, and module layout.
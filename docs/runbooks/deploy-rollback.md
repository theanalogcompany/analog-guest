# Rolling back a bad deploy

Vercel deploys `main` on every merge, so "roll back" means either re-pointing production at the previous deployment (fast, no CI) or reverting the merge (slower, durable).
Do the fast one first, then the durable one.

## 1. Instant rollback (minutes)

In the Vercel dashboard, open the project, go to **Deployments**, find the last good production deployment, and promote it (Vercel's Instant Rollback).
This re-points production without a build, so it takes effect immediately.
Nothing in the repo changes; the bad commit is still on `main` and will redeploy on the next merge unless step 2 happens.

## 2. Revert the merge (durable)

```
git revert -m 1 <merge-commit>
git push origin <branch>:<branch>   # then open a PR as usual
```

The revert PR goes through normal CI and branch protection; merging it redeploys a clean `main` and re-arms auto-deploy safely.

## Before rolling back: check for a migration

**If the bad change shipped alongside a migration, do not roll back blindly.**
The migration ordering rules in root `CLAUDE.md` ("Migrations") cut both ways: rolling code back past a backwards-incompatible migration re-opens the window where deployed code queries a schema that no longer matches, which is exactly the failure the ordering rules exist to prevent.
On a webhook path that failure is invisible - the route answers 200 and the guest's message is lost with no retry.
Involve the operator (who applies migrations in Supabase Studio) before promoting any deployment older than the last applied migration.

## Afterwards

Run the checks in [post-deploy-checks.md](post-deploy-checks.md) against the rolled-back production.
Write the incident up in the body of the fix PR, per root `CLAUDE.md`'s routing table.

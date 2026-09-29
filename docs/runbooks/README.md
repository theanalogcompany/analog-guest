# Runbooks

Operational procedures for the deployed app.
Each runbook is a checklist to follow under pressure, not background reading; the why lives in `CLAUDE.md` and `docs/decisions/`.

| runbook | when to open it |
| --- | --- |
| [deploy-rollback.md](deploy-rollback.md) | a merge to `main` made production worse |
| [post-deploy-checks.md](post-deploy-checks.md) | after any merge, or when deciding whether a deploy is healthy |

Incidents themselves are written up in the PR body of the fix, per the routing table in root `CLAUDE.md`.
A pattern that recurs across incidents graduates into a runbook here.

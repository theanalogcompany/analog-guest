# Post-deploy checks

Where to look after a merge lands, in the order that catches the most damage soonest.
The same list answers "is production healthy right now".

## 1. Vercel deployment status

The vercel bot comments DEPLOYED (or the failure) on the merged PR; the dashboard has build logs if it failed.
A failed build never reaches production - production keeps serving the previous deployment.

## 2. `/admin/health`

One row per credential and dependency: DB connectivity, Langfuse env/host, APNs, and the admin auth chain.
A server-side env var missing on the new deployment surfaces here first.
Remember the failure shape from root `CLAUDE.md`: a missing var is a 500 with an **empty body**, because the helper throws before any JSON response is shaped.

## 3. Slack alerts

`fireRedAlert` (`lib/agent/alerts.ts`) posts to the alerts channel on every fail-closed branch of inbound and follow-up handling.
Silence here is only meaningful if traffic is flowing; check during the pilot venue's open hours.

## 4. Langfuse traces

Every agent run is traced end-to-end (`lib/observability/langfuse.ts`), and `messages.langfuse_trace_id` links a message row to its trace.
After a deploy touching `lib/agent/` or `lib/ai/`, open the first few post-deploy traces and check the stages, floors, and verifier outcomes look normal.

## 5. PostHog events

Stage and failure events (`lib/analytics/posthog.ts`) give the aggregate view: a spike in `*_failed` or `regeneration_triggered` events after a deploy is the earliest population-level signal that something regressed.

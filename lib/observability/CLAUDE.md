# lib/observability - the Langfuse wrapper, and where latency numbers live

Loads only when you work in this directory.

Rehomed here 2026-09-29: PR #282 deleted the root "Observability and alerting" section instead
of routing it, and for four days a measured latency baseline existed that no document mentioned.
**If you move this again, move it - do not delete it.**

## Three layers, each filling a different gap

Do not conflate them.

**PostHog events** - product analytics: inbound/outbound events, fidelity scores,
classification outputs. Emission is wrapped in try/catch; a failure must never crash the agent
path.

**Slack alerts** - fired from PostHog event filters. Changing one improves what an alert
*says*, never what fires.

**Trace-level observability** - per-run visibility into the agent's reasoning, via Langfuse
Cloud. `langfuse.ts` is a thin wrapper; app code must never import `@langfuse/*` directly.

## Wrapper invariants

`startAgentTrace` returns an `AgentTrace` (`span()`, `update()`, `flushAsync()`); spans expose
`span()` / `generation()` / `update()` / `end()`.

- **Never throws.** SDK errors are caught at the wrapper boundary and logged via `console.warn`.
  Observability is diagnostic, not load-bearing - a Langfuse outage must not kill an agent run.
- **No-op fallback** when `NODE_ENV=test`, `LANGFUSE_ENABLED=false`, any required env var is
  missing, or SDK init throws. In no-op mode `trace.id === ''` and every method is silent, so
  agent code runs unchanged with no guards.
- **Host resolution:** `LANGFUSE_BASE_URL` (preferred - matches the SDK's `baseUrl` field) or
  `LANGFUSE_HOST` (legacy alias, accepted because Langfuse's docs and the Vercel integration use
  it; remove post-pilot). `BASE_URL` wins when both are set.
- **Trace ID is synchronous.** Available the moment `startAgentTrace` returns (v5:
  `observation.traceId`, a plain readonly field), so `schedule-and-send.ts` writes
  `trace.id || null` to `messages.langfuse_trace_id` at insert time without waiting for a
  flush round trip. This is why no-op mode is checked **explicitly** rather than left to OTel's
  no-op tracer: that tracer still yields a zero-filled trace id, and the difference is a column
  full of ids resolving to nothing versus a column of nulls.
- **Content is gated, metadata is not.** Counts, scores and IDs always ride on span
  `input`/`output`. Heavy content (full bodies, prompts, corpus chunk text) is gated by
  `LANGFUSE_CAPTURE_CONTENT`, default-on, folded into `output.content` when on and dropped
  entirely when off. Read once at module init - flipping it needs a redeploy.
  `lib/agent/trace-content.ts` centralizes the per-stage content shape; read
  `trace.captureContent` to skip building payloads nobody will look at.
- **`flushAsync` is awaited** in each handler's `finally`. Both handlers run inside a
  `waitUntil` keep-alive window from their caller, so the flush completes.
- **`flushAsync` also ends the root span**, and is the only thing that does. In v5 the root is
  a real span that must be closed or `agent.inbound` gets **no duration** - the number every
  whole-turn latency query rests on, and it fails by reading `null` rather than by erroring. So
  any new code path that starts a trace **must** await `flushAsync`, failure paths included.
  `AgentTrace` has no `end()`: flush is already the "run is over" signal, and adding one would
  touch ~20 consumers.
- **`/admin/health`** reports four states via `app/admin/(authed)/health/check-langfuse.ts`:
  Active, Disabled, Misconfigured, Not configured. It does not probe Langfuse - the SDK has no
  synchronous ping and probing per page load would pollute the trace stream.

## Span tree per agent run

`agent.inbound` (or `agent.followup`) → `context_build` → `classify` (inbound only) →
`retrieve` → `retrieve_knowledge` (conditional) → `generate` → the five `verify_*` checks →
`queue` or `send`.

`retrieve` is **started** alongside `classify` and awaited at its old position (TAC-540 part C),
so the span covers a window that overlaps classification. `retrieve_knowledge` is gated by
`shouldRetrieveKnowledge`: always for inbound, only for followup `event` / `manual` triggers.

The five `verify_*` spans each own their own timing (TAC-540 part D) - before that they shared
three spans wrapping the whole batch, so each recorded the maximum of the five.

Knowledge retrieval **degrades gracefully** on a Voyage or DB error - logs, returns `[]`, span
closes normally with `matchCount=0`. Voice retrieval **fails closed**, because a voice failure
breaks voice fidelity itself.

## Latency and cost: where the numbers already live

**Do not add a `duration_ms` column or reach for SQL to answer a latency question.** Langfuse
already stores every stage as a timed span and its metrics API aggregates them into the
per-stage, per-percentile timeseries you want. Rediscovered the hard way on 2026-09-23.

Per-stage p50/p90/p99 across a window, grouped by span name:

```bash
PK=$LANGFUSE_PUBLIC_KEY; SK=$LANGFUSE_SECRET_KEY
Q='{"view":"observations",
    "metrics":[{"measure":"latency","aggregation":"p50"},
               {"measure":"latency","aggregation":"p90"},
               {"measure":"latency","aggregation":"p99"}],
    "dimensions":[{"field":"name"}],
    "fromTimestamp":"2026-09-16T00:00:00Z","toTimestamp":"2026-09-24T00:00:00Z"}'
curl -s -u "$PK:$SK" -G "$LANGFUSE_BASE_URL/api/public/v2/metrics" --data-urlencode "query=$Q"
```

Add `"timeDimension":{"granularity":"day"}` for a daily series - this is how you show a change
landing - and a `filters` array to scope to one span, e.g.
`[{"column":"name","operator":"=","value":"generate","type":"string"}]`.

**Use `/api/public/v2/metrics`.** The v1/v3 path still answers but returns a deprecation notice,
and is removed **2026-11-16**.

### The 2026-11-16 deadline, and the v5 migration that answered it

**The same date removes the legacy batch ingestion API, and `langfuse@3.x` stops ingesting
traces entirely.** **Migrated to SDK v5 on 2026-09-29, so this repo is handled** - a package
replacement, not a version bump: `langfuse` → `@langfuse/tracing` + `@langfuse/otel` +
`@langfuse/client` + `@langfuse/core`. Recorded because the traps below stay live, and a sibling
repo or old branch still on v3 needs to know the date is real. Three traps:

- **v5 filters spans by default** and filtering drops them **silently**. `span-processor.ts`
  passes an explicit predicate keyed on instrumentation scope: keep `langfuse-sdk` (everything
  `startObservation` creates) and `ai` (so `experimental_telemetry` is not dropped the day someone
  enables it). **Do not widen it to `() => true`** - `@vercel/otel` instruments `fetch`, so that
  exports a span per outbound HTTP call with the full URL as the span NAME: ingestion volume
  nobody chose, and a PII surface `LANGFUSE_CAPTURE_CONTENT` does not gate. `npm run
  langfuse-smoke` checks both directions.
- **Use SDK ≥ 5.4.0**, or set `x-langfuse-ingestion-version: 4` on a direct OTLP exporter.
  Without it, ingested data can lag up to 15 minutes - the real source of the "data delays".
- **`@langfuse/core` is a declared direct dependency though it looks transitive.**
  `LangfuseOtelSpanAttributes` is a runtime value, not a type, so relying on npm hoisting it
  from the other three would break on any install that deduped differently.

## How telemetry is wired

| file | owns |
| --- | --- |
| `instrumentation.ts` (repo root) | Next's `register()` hook. Registers the OTel provider once per runtime, before the first request |
| `lib/observability/span-processor.ts` | the `LangfuseSpanProcessor` singleton and `readLangfuseConfig()` - the single source of truth for "is observability on" |
| `lib/observability/langfuse.ts` | the `AgentTrace` / `AgentSpan` wrapper every consumer imports |
| `lib/observability/logger.ts` | structured one-JSON-line-per-event logging. **Convention for new code:** `logger.warn('[area] what', { fields })` rather than `console.warn`. Pure, no `@/*` imports. Existing `console.*` call sites migrate as they are touched, keeping the message text so log searches survive the migration - `langfuse.ts` is still on `console.warn` for that reason |

Four structural choices, reasoning in each file's header. Read those before changing any of
them; all four fail quietly.

- The processor is **its own lazy singleton module**, not owned by either caller.
- `instrumentation.ts` imports **dynamically** behind a `NEXT_RUNTIME !== 'nodejs'` guard.
- The **read** client (`fetchTrace`) is a separate singleton from the write path, so the admin
  trace panel still works when tracing is off - exactly when someone wants to look at it.
- `langfuse.ts` keeps the **v3-era `AgentTrace` / `AgentSpan` interfaces unchanged**, which is
  why the v5 migration touched zero of its ~20 consumers. Keep new surface behind the wrapper.

## Adding a span

Take the `AgentTrace` from the caller - never call `startAgentTrace` in a stage, the
orchestrator owns it - and wrap the work:

```ts
const span = trace.span('retrieve_knowledge', { query: q.length })
span.end({ output: { matchCount: rows.length } })
```

- `trace.span()` / `span.span()` nest. **A model call uses `generation()`, not `span()`**, and
  passes `model` plus `usage: toAgentUsage(...)` to `end()`. Langfuse prices only GENERATION
  observations, and all three parts are needed: a model call recorded as a plain span, or a
  generation with no `model`, reports $0 and loses the token rollup **silently**.
- **Metadata in `input`/`output`, heavy content in the third `content` arg** - "Content is
  gated" above.
- **End the span on every path, failures included.** An unended span gets no duration, so a
  stage that only ends on success reports a percentile over its happy path alone.
- **Do not add a `duration_ms` column.** See "where the numbers already live" below.
- Do not re-implement the never-throws / no-op guarantees. Call `.span(...).end(...)` unguarded.

## Verifying the write path

**A green build does not tell you traces are landing.** `next build` has no credentials so
`register()` returns early, so it passes with a write path that ingests nothing, and the v3
deadline failure is itself silent and server-side.

```
npm run langfuse-smoke
```

`scripts/measurement/langfuse-v5-smoke.ts` writes a real trace through the real `register()` +
`startAgentTrace` path, then **reads it back through the read API** and checks the trace name,
the session id, the full parent/child/generation tree, a non-null root duration, and that the
generation came back **priced** - `type: GENERATION`, the model id, exact `usageDetails`, non-empty
`costDetails`. A second source that can disagree with the first.

Run it after any change to these three modules and after any `@langfuse/*` bump. It traces as
`smoke.langfuse_v5`, so it joins no `agent.*` percentile. Expect a 404 or two on the first read
attempts; that is ingestion lag. The script polls until every expectation holds, up to 3min -
it does NOT assert as soon as the trace appears, because ingestion is not atomic and the root
lands before its children.

### End-to-end latency needs a different query

`/api/public/v2/metrics` has no `traces` view any more (only `observations` and `scores-*`), and
pre-v5 trace roots return `null` latency in the observations view because v3 roots were not real
spans. So for whole-turn numbers, page the traces endpoint and compute percentiles yourself:

```bash
curl -s -u "$PK:$SK" -G "$LANGFUSE_BASE_URL/api/public/traces" \
  --data-urlencode "name=agent.inbound" --data-urlencode "limit=100" \
  --data-urlencode "page=1" --data-urlencode "fromTimestamp=2026-08-29T00:00:00Z"
# repeat pages until a page returns <100; each row has `latency` in seconds
```

**v5 roots ARE real spans**, so once enough post-migration traffic accumulates the plain
observations query above answers this directly and this section can go.

### The shape of the latency budget

**No numbers here on purpose.** Re-deriving the whole baseline is 1 call and 0.3s for per-stage,
3 calls and 14s for end-to-end, and Langfuse meters ingestion rather than reads - so a measured
p50 in this file would be a stale copy of something free to fetch, and a stale number is worse
than none because it stops the next person looking. Per the routing table in the root file, a
measurement run belongs in its PR body. Run the queries above.

What does *not* change between runs, and is the part that got mis-read once:

- **The time is model round trips in series.** Everything non-LLM - `context_build`, `retrieve`,
  `retrieve_knowledge`, `queue` - sums to roughly a second, low single-digit percent of a turn.
  **Do not bring a latency plan that optimizes one of those**; a planning session proposed
  exactly that against `retrieve_knowledge`, which is ~1% of the turn.
- **Ranked by cost:** `generate` > slowest `verify_*` > `classify` > `send` > the settle >
  everything else. `generate` and the verifiers are the same order of magnitude and dominate.
- **The five verifiers run in parallel** (`Promise.allSettled` in `handle-inbound.ts`), so the
  block costs the slowest one, not their sum. Serializing one is the regression to watch for,
  and nothing in CI catches it.
- **`agent.inbound` and `agent.followup` differ by about two orders of magnitude** at p50,
  because most followups never reach a model call, and followup's distribution is bimodal.
  **Any single latency number applied to both kinds is wrong for one of them** - that was the
  `agent_latency_high` defect. The two thresholds that replaced it, with the measurement and the
  date that chose them, are in `lib/analytics/posthog.ts`.

### Prompt cache

`cacheReadTokens` / `cacheWriteTokens` sit in the `generate` span's **`output` object**, which the
metrics API cannot aggregate. Since 2026-09-29 the same two numbers ALSO ride that span's native
`usageDetails` as `input_cached_tokens` / `input_cache_creation`, which it can - prefer those for
anything new. The output fields stay because they are what pre-2026-09-29 spans carry.

To read the output fields, the only option on historical spans:

```bash
curl -s -u "$PK:$SK" -G "$LANGFUSE_BASE_URL/api/public/observations" \
  --data-urlencode "name=generate" --data-urlencode "limit=100" \
  --data-urlencode "fromStartTime=2026-09-22T00:00:00Z"
# then count output.cacheReadTokens > 0 against the total
```

Spans older than the accounting carry no such fields - exclude them, do not count them as misses.
Measured once at a ~75% hit rate; re-run the query rather than trusting that sentence.

**This span is the only surface the cache is visible on.** A hit and a fast uncached call have
identical latency, and a breakpoint that quietly stops reading raises no error. The failure mode is
named in `lib/ai/types.ts`: something per-message leaking into `composePrompt`'s first three
sections, silently killing a ~10k-token cached prefix for every venue.

The breakpoint sits on the first of two adjacent system blocks - template + persona + venue info,
stable per (venue, channel); the second carries the retrieved slates and is deliberately uncached.
`ttl: '1h'` over the 5m default was chosen from measured inter-message gaps, **already asked and
answered** at the `generateObject` call in `lib/ai/generate-message.ts`. Re-derive only if traffic
shape changes.

### Native cost and usage: how it works, and why not `experimental_telemetry`

Before 2026-09-29 every model call was recorded as `type: SPAN` with **no model, no
`usageDetails`, no `costDetails`** - 0 of 100 `generate` observations - so Langfuse's cost and
token dashboards were **empty for this project** (1,448 traces over 30 days, total cost $0.0003,
and that figure was one probe call). Langfuse prices only GENERATION observations.

The fix: `AgentSpanUpdate` carries `model` and `usage`, built with `toAgentUsage()`, and model call
sites use `trace.generation()`. **`classify` and `generate` are converted; the five verifiers are
not yet.** `generate` sums usage across regen attempts rather than reporting the last, so the
~12.6% of turns that run a second Sonnet call are priced for both.

**The AI SDK's own `experimental_telemetry` was the obvious alternative and is NOT a config flip.**
`span-processor.ts` allowlists the `ai` scope, so the plumbing is there, but a live probe on
2026-09-29 found that enabling it on one `generateObject` nested in one of our spans produced **two
traces**: ours, and a detached `probe.classify:ai.generateObject` carrying the generation. The
cause is structural - `startObservation` returns an object and never makes its span *active* in the
OTel context, so the AI SDK's tracer starts a new root. Making ours active means
`startActiveObservation(name, fn, opts)`, which is **callback-scoped**, and the whole `AgentTrace`
shape exists to hand objects to straight-line code across ~20 sites.

**Do not enable it without deciding that inversion first.** Split traces break the per-stage
latency queries and the Command Center trace panel, both of which assume one trace per turn. The
route above already delivers the usage and cost attribution that was the point.

### Three traps in the native usage fields

**Langfuse silently ESTIMATES usage when the native field is missing.** Send the tokens under any
key other than `usageDetails` and it does not error and does not leave the field empty: it
tokenizes the observation's own `input`/`output` text and stores that, priced. Renaming
`usageDetails` to `usage` produced `{input: 5, output: 5, total: 10}` for a call that reported
194/13/207 - and passed a check that only asked whether `usageDetails` was non-empty. **Any check
here must compare the values, not their presence.** `langfuse-v5-smoke.ts` does, and its
`SMOKE_TOKENS` comment carries the reasoning.

**The input buckets are DISJOINT and Langfuse sums them.** `input`, `input_cached_tokens` and
`input_cache_creation` are priced separately and added, verified live: 1,200 + 8,900 + 140 input
tokens came back as `$0.0012 + $0.00089 + $0.000175`. But the AI SDK's `usage.inputTokens` is the
**total including both cache buckets** - the uncached portion is
`usage.inputTokenDetails.noCacheTokens`. Mapping `inputTokens` to `input`, which is the obvious
reading of the field name, bills every cached token twice at two different rates: on the same
inputs it reports $0.012855 against a true $0.003815, **3.4x over**. Nothing errors, no chart looks
broken, and the call with a ~75% cache hit rate is `generate` - the expensive one. `toAgentUsage()`
owns this arithmetic for exactly that reason; pass the SDK's `usage` through whole and never pick
fields off it at a call site.

**The key names are not free choice.** `input`, `output`, `total`, `input_cached_tokens`,
`input_cache_creation` are what the AI SDK's own `experimental_telemetry` emits. Diverging means
hand-rolled spans and SDK spans aggregate into different buckets, so no dashboard could span the
day Path B lands. `AgentUsage` is the single definition.

### Known gaps

- **`generate.attempt_N` spans are not timed.** Synthesized post-hoc from `attemptScores`, they
  read 0.00s at every percentile, so they count retries without being able to price one. The
  count is still usable: 87 `attempt_1` against 11 `attempt_2` on 2026-09-29 means **12.6% of
  generations run a second Sonnet call**, roughly 6s each, unpriced. Real per-attempt timing is
  **THE-215** (in flight - adds `attemptTimings`, absolute epoch ms plus duration, index-aligned
  with `attemptScores`).
- **~3s of `agent.inbound` is unattributed to any span.** `startAgentTrace` runs at the top of
  `runInboundTurn`, above the venue gate, and `openCoalescedTurn` runs below it in the same
  function, so `COALESCE_SETTLE_MS` has always been inside the traced window. The stage spans sum
  to roughly 3s less than the trace total at p50 with nothing to point at. **THE-215** adds a
  `coalesce_settle` span that closes the arithmetic. Until it lands, do not read the stage sum as
  the whole turn. (An earlier note claimed the settle elapsed *before* the trace opened; false
  when written - TAC-526 had already moved it inside.)
- **A REFUSED generation is unpriced.** When `generateMessage` exhausts the fidelity loop, the
  orchestrator gets a `GenerateOutcome` carrying `attemptScores` and `finalScore` only - no usage,
  no model - so the tokens burned by up to three Sonnet calls are invisible to cost. That is the
  most expensive turn shape there is and it reports $0. Widening `GenerateOutcome` is the fix, and
  it wants the same design conversation as THE-215's `attemptTimings`.
- **The five verifiers are still plain spans**, so their Haiku calls are unpriced too. Same
  conversion as `generate`, not yet done.
- **The Langfuse aggregate latency alert is not set up yet.** This is the half of the
  `agent_latency_high` fix that is console config, not code, so nothing in the repo can assert
  it exists. In Langfuse → Alerts, create a threshold alert on **p95 trace latency for
  `agent.inbound` over a rolling 6h window**, routed to Slack. Suggested bar: **40s**, i.e.
  above the measured p99 of 40.7s, so it means "the distribution moved" and not "one run was
  slow". Until it exists, a latency regression has no alarm at all - the PostHog event is
  forensics, deliberately, and nobody watches it in real time.
- **Nothing gates latency in CI.** Nothing budgets the two things that actually drive it: how
  many model round trips sit in series, and how large the prompt is. A sixth verifier added in
  sequence would pass every existing gate.

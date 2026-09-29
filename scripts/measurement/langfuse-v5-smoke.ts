/**
 * End-to-end smoke test for the Langfuse v5 (OpenTelemetry) write path.
 *
 * WHY THIS EXISTS. `tsc`, `vitest` and `next build` all pass with a write path
 * that ingests nothing - the unit tests assert against mocks, and the build
 * never has Langfuse credentials so `register()` returns early. The v3 SDK
 * failing after 2026-11-16 is itself a silent, server-side failure. A migration
 * whose only evidence is a green suite reproduces exactly the class of defect
 * this repo keeps paying for: a claim nothing enforces.
 *
 * So this writes a real trace through the real `instrumentation.ts` +
 * `startAgentTrace` path, then reads it back with the READ API - a second
 * source that can disagree with the first.
 *
 * Run: npx tsx --env-file=.env.local scripts/measurement/langfuse-v5-smoke.ts
 *
 * The trace is named `smoke.langfuse_v5` so it is trivially filtered out of the
 * latency baseline; it is not an `agent.*` trace and joins no percentile.
 */

/**
 * A model Langfuse Cloud has pricing for. The cost assertion below is only
 * meaningful against a recognised id; bump this if the repo's classification
 * model changes and pricing for this one is retired.
 */
const SMOKE_MODEL = 'claude-haiku-4-5-20251001'

/**
 * The token counts written, and the exact `usageDetails` Langfuse must store back.
 *
 * WHY THE EXPECTED VALUES ARE PINNED rather than checked for mere presence.
 * A mutant renaming the wrapper's native `usageDetails` field to `usage` SURVIVED
 * a non-emptiness check: Langfuse fell back to tokenizing the span's own
 * input/output text and returned `{input: 5, output: 5, total: 10}` - plausible,
 * priced, charted, and nothing to do with the call. That is this repo's recurring
 * defect shape exactly: a number nobody can contradict. Deriving both sides from
 * one constant is the right binding here because what is under test is the
 * transport - whether Langfuse stores what the wrapper sent - not the arithmetic.
 *
 * Deliberately NOT round numbers, and all five distinct, so a fallback estimate or
 * a swapped key cannot coincide with them.
 */
const SMOKE_TOKENS = {
  // inputTokens is the SDK's TOTAL: 1_200 + 8_900 + 140 = 10_240. An earlier
  // version of this fixture read 194/128/64, which does not reconcile - and the
  // inconsistency is what let a double-billing bug in `toAgentUsage` run through
  // this script green.
  inputTokens: 10_240,
  outputTokens: 310,
  totalTokens: 10_550,
  cachedInputTokens: 8_900,
  inputTokenDetails: { noCacheTokens: 1_200, cacheWriteTokens: 140 },
} as const

const EXPECTED_USAGE_DETAILS: Record<string, number> = {
  // `input` is the UNCACHED portion, because Langfuse's buckets are disjoint and
  // it sums them. Spelled as the literal rather than derived from SMOKE_TOKENS so
  // this line cannot silently follow `toAgentUsage` into the same mistake: it is
  // the independent statement of what the cost math requires.
  input: 1_200,
  output: 310,
  total: 10_550,
  input_cached_tokens: 8_900,
  input_cache_creation: 140,
}

/**
 * 3 minutes, not 90s. Observed ingestion lag is usually ~12s but a probe on
 * 2026-09-29 took over 90s to become readable, i.e. exactly the old deadline. A
 * slow ingestion must not read as a broken write path - that is the failure mode
 * that gets a verification script distrusted and then deleted. Named so the
 * failure message cannot go stale against it, which it already had once.
 */
const DEADLINE_MS = 180_000

async function main(): Promise<void> {
  // `register()` guards on this - it is what Next sets for the Node runtime.
  process.env.NEXT_RUNTIME = 'nodejs'

  // The wrapper no-ops on NODE_ENV=test, so a shell that exports it would make
  // this script "pass" by never writing anything. Refuse rather than override:
  // NODE_ENV is readonly to `tsc`, and a silent no-op is the exact failure this
  // script exists to catch.
  if (process.env.NODE_ENV === 'test') {
    console.error('FAIL: NODE_ENV=test forces the wrapper into no-op mode. Unset it and re-run.')
    process.exit(1)
  }

  // Captured before anything is registered, so the leak check below sees every
  // span this run could possibly have created.
  const startedAt = new Date(Date.now() - 1000).toISOString()

  const { register } = await import('../../instrumentation')
  await register()

  const { startAgentTrace, fetchTrace, langfuseInitFailed, toAgentUsage } = await import(
    '../../lib/observability/langfuse'
  )

  if (langfuseInitFailed()) {
    console.error('FAIL: span processor init threw. Check LANGFUSE_* vars.')
    process.exit(1)
  }

  // A unique marker so the read-back cannot pass by matching some other trace.
  const runId = `smoke-${process.pid}-${Date.now()}`
  const trace = startAgentTrace({
    name: 'smoke.langfuse_v5',
    agentRunId: runId,
    metadata: { purpose: 'v5 migration verification', runId },
  })

  if (!trace.id) {
    console.error(
      'FAIL: trace.id is empty, so the wrapper is in no-op mode.',
      'Either credentials are missing or LANGFUSE_ENABLED=false.',
    )
    process.exit(1)
  }
  console.log(`trace.id (synchronous): ${trace.id}`)

  // Exercise every shape the agent path uses: nested span, generation, update,
  // end-with-body. A flat single span would not catch a broken parent/child
  // link, which is the exact failure `shouldExportSpan` guards against.
  const parent = trace.span('smoke.parent', { step: 1 })
  const child = parent.span('smoke.child', { step: 2 })
  const gen = child.generation('smoke.generation', { prompt: 'ping' })
  // A REAL model id, because the read-back below asserts Langfuse actually PRICED
  // this observation. Pricing needs a model it recognises - an invented id yields
  // empty costDetails and would make the assertion fail for the wrong reason.
  gen.end({
    output: { text: 'pong' },
    model: SMOKE_MODEL,
    usage: toAgentUsage(SMOKE_TOKENS),
  })
  child.end({ output: { ok: true } })
  parent.update({ metadata: { note: 'updated before end' } })
  parent.end({ output: { ok: true } })
  trace.update({ output: { status: 'complete', runId } })

  await trace.flushAsync()
  console.log('flushed')

  // Read back, polling until EVERY expectation is satisfied - not until the
  // trace merely exists.
  //
  // Ingestion is not atomic: the root arrives before its children, and the
  // root's duration lands later still. An earlier version of this script polled
  // for `fetchTrace` to return non-null and then asserted on children in the
  // same instant, which passed or failed depending on how far ingestion had got
  // - a flaky verification, which is worse than none, because the natural
  // response to it is to stop believing the failures. Only a deadline may fail
  // the run, and it reports whatever was still missing when it expired.
  const REQUIRED_SPANS = ['smoke.parent', 'smoke.child', 'smoke.generation']
  const deadline = Date.now() + DEADLINE_MS
  let attempt = 0
  let lastProblems: string[] = ['trace never appeared; the write path is not ingesting']

  while (Date.now() < deadline) {
    attempt += 1
    const fetched = await fetchTrace(trace.id)

    if (fetched) {
      const names = (fetched.observations ?? []).map((o) => o.name ?? '').sort()
      const problems: string[] = []

      if (fetched.name !== 'smoke.langfuse_v5') {
        problems.push(`trace name is ${fetched.name}, expected smoke.langfuse_v5`)
      }
      if (fetched.sessionId !== runId) {
        problems.push(`sessionId is ${fetched.sessionId}, expected ${runId}`)
      }
      // Presence of our spans is the binding check that `startObservation` really
      // stamps the instrumentation scope `shouldExportSpan` allowlists. If that
      // scope is ever renamed, these vanish - which the unit test CANNOT catch,
      // because it imports the scope constant from the same place the source does.
      for (const required of REQUIRED_SPANS) {
        if (!names.includes(required)) problems.push(`missing observation ${required}`)
      }
      // The root must have a duration, or `agent.inbound` end-to-end latency -
      // the number the whole baseline rests on - would read as null.
      if (typeof fetched.latency !== 'number' || fetched.latency <= 0) {
        problems.push(`root latency is ${fetched.latency}; the root span did not close`)
      }

      // PRICING. Measured 2026-09-29: every `generate` span was type SPAN with no
      // model and no usage, 0 of 100, so Langfuse's cost and token dashboards were
      // empty for the whole project while every other check here was green. That is
      // the failure this block exists to catch, and it is invisible from the write
      // side: `gen.end({model, usage})` cannot tell you Langfuse ACCEPTED the
      // fields into its native columns rather than folding them into output JSON.
      //
      // So all four are asserted separately. `type` proves `asType: 'generation'`
      // survived; `model` and `usageDetails` prove the native mapping; `costDetails`
      // proves Langfuse actually priced it, which is the only one of the four that
      // depends on anything outside this repo.
      const genObs = (fetched.observations ?? []).find((o) => o.name === 'smoke.generation')
      if (genObs) {
        if (genObs.type !== 'GENERATION') {
          problems.push(`smoke.generation has type ${genObs.type}, expected GENERATION`)
        }
        if (genObs.model !== SMOKE_MODEL) {
          problems.push(`smoke.generation model is ${genObs.model}, expected ${SMOKE_MODEL}`)
        }
        const usageDiff = diffUsageDetails(genObs.usageDetails)
        if (usageDiff) problems.push(`smoke.generation usageDetails wrong: ${usageDiff}`)
        if (!hasEntries(genObs.costDetails)) {
          problems.push(
            `smoke.generation costDetails is empty; Langfuse did not price ${SMOKE_MODEL}` +
              ' (either the fields did not land, or pricing for this model id was retired' +
              ' - check the model list in the Langfuse console before assuming a code defect)',
          )
        }
      }

      if (problems.length === 0) {
        console.log(`\nread back complete after ${attempt} attempt(s):`)
        console.log(`  name:         ${fetched.name}`)
        console.log(`  sessionId:    ${fetched.sessionId}`)
        console.log(`  latency:      ${fetched.latency}`)
        console.log(`  observations: ${JSON.stringify(names)}`)
        console.log(`  generation:   model=${genObs?.model}`)
        console.log(`  usageDetails: ${JSON.stringify(genObs?.usageDetails)}`)
        console.log(`  costDetails:  ${JSON.stringify(genObs?.costDetails)}`)

        // THE INVERSE CHECK, and the one that caught a real defect.
        // `@vercel/otel` instruments `fetch`, so an over-broad `shouldExportSpan`
        // ships a span per outbound HTTP call - Anthropic, Supabase, Voyage,
        // Sendblue - with the full URL as the span NAME. A Supabase REST URL
        // carries table and filter values, so a guest id or phone number rides
        // in a span name that LANGFUSE_CAPTURE_CONTENT does not gate.
        //
        // Those spans land in their OWN traces, not as children of ours, so this
        // is an independent query rather than a look at `observations` above.
        // This script's own `fetchTrace` calls are the trigger: if the predicate
        // is too broad, they self-report. Checked only once the write side is
        // confirmed, so a leak cannot be masked by an incomplete read.
        const leaked = await findLeakedHttpSpans(startedAt)
        if (leaked.length > 0) {
          console.error(`\nFAIL:\n  - ${leaked.join('\n  - ')}`)
          process.exit(1)
        }

        console.log(
          '\nPASS: trace, session id, span tree, root duration and a PRICED generation',
          'landed, and no auto-instrumented HTTP spans leaked.',
        )
        return
      }

      lastProblems = problems
      console.log(`  attempt ${attempt}: ${problems.length} not yet satisfied, waiting…`)
    }

    await new Promise((r) => setTimeout(r, 3000))
  }

  console.error(
    `\nFAIL after ${DEADLINE_MS / 1000}s (${attempt} attempts). Still unsatisfied:\n  - ${lastProblems.join('\n  - ')}`,
  )
  process.exit(1)
}

/**
 * True when Langfuse returned a non-empty record. `usageDetails` and `costDetails`
 * come back as `{}` - not null - when the fields did not map, so a truthiness check
 * on the object itself would pass on exactly the failure being looked for.
 */
function hasEntries(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0
}

/**
 * Compare Langfuse's stored `usageDetails` against what was written, and return a
 * human-readable description of the first disagreement, or null when they match.
 *
 * Checks BOTH directions - every expected key present with the right value, and no
 * unexpected extra key. An extra key means Langfuse interpreted the payload
 * differently than intended (the tokenizer fallback adds none, but a future
 * mis-mapping could), and a silently renamed key would otherwise read as a match on
 * the keys that happened to survive.
 */
function diffUsageDetails(actual: unknown): string | null {
  if (!hasEntries(actual)) return 'empty; tokens did not map to Langfuse at all'
  const got = actual as Record<string, unknown>

  const wrong = Object.entries(EXPECTED_USAGE_DETAILS)
    .filter(([key, want]) => got[key] !== want)
    .map(([key, want]) => `${key}=${JSON.stringify(got[key])} (expected ${want})`)

  const extra = Object.keys(got).filter((key) => !(key in EXPECTED_USAGE_DETAILS))

  if (wrong.length === 0 && extra.length === 0) return null
  return [
    wrong.length > 0 ? wrong.join(', ') : null,
    extra.length > 0 ? `unexpected keys ${JSON.stringify(extra)}` : null,
    `full payload ${JSON.stringify(got)}`,
  ]
    .filter(Boolean)
    .join('; ')
}

/**
 * Query recent observations directly and return a problem per HTTP-shaped span
 * name found. Empty array means the scope filter is holding.
 *
 * Deliberately NOT going through `lib/observability` - this must be able to
 * disagree with the module under test, so it reads the API with plain fetch.
 */
async function findLeakedHttpSpans(startedAt: string): Promise<string[]> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? ''
  const secretKey = process.env.LANGFUSE_SECRET_KEY ?? ''
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST ?? ''
  if (!publicKey || !secretKey || !baseUrl) return ['cannot check HTTP-span leakage: no creds']

  // Scoped to THIS RUN, not a rolling window. A time window couples the check to
  // history: one leaked span from an earlier run would fail every clean run
  // until it aged out, which is the kind of flake that gets a check deleted. The
  // script's own `fetchTrace` calls happen after `startedAt`, so they are the
  // trigger and the window needs to be nothing wider.
  const url = `${baseUrl}/api/public/observations?limit=100&fromStartTime=${encodeURIComponent(startedAt)}`
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64')

  let names: string[]
  try {
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } })
    if (!res.ok) return [`cannot check HTTP-span leakage: read API returned ${res.status}`]
    const body = (await res.json()) as { data?: { name?: string | null }[] }
    names = (body.data ?? []).map((o) => o.name ?? '')
  } catch (e) {
    return [`cannot check HTTP-span leakage: ${e instanceof Error ? e.message : String(e)}`]
  }

  // `fetch GET https://...` is the @vercel/otel naming; bare URLs cover other
  // HTTP instrumentors.
  const leaked = [...new Set(names.filter((n) => /^fetch\s|^https?:\/\/|^(GET|POST) https?:/.test(n)))]
  if (leaked.length === 0) return []
  return [
    `auto-instrumented HTTP spans are being exported: ${JSON.stringify(leaked.slice(0, 5))}` +
      ` (${leaked.length} distinct since this run started). shouldExportSpan is too broad,` +
      ' and these span names carry full URLs.',
  ]
}

main().catch((e) => {
  console.error('FAIL: smoke test threw', e)
  process.exit(1)
})

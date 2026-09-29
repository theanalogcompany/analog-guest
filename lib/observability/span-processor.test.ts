import { LANGFUSE_TRACER_NAME } from '@langfuse/core'
import { describe, expect, it } from 'vitest'

import { shouldExportSpan } from './span-processor'

// WHAT THIS FILE CAN AND CANNOT PROVE.
//
// It proves the predicate's LOGIC: which instrumentation scopes are kept and
// which are dropped. It does NOT prove that `startObservation` actually stamps
// `LANGFUSE_TRACER_NAME` as its scope, because asserting that here would mean
// comparing a value imported from @langfuse/core against the same value
// imported from @langfuse/core — a derivation against itself, which is the
// exact shape of test this repo has been burned by.
//
// That binding is verified in `scripts/measurement/langfuse-v5-smoke.ts`, which
// writes through the real SDK and reads back what landed. Do not "strengthen"
// this file by hardcoding 'langfuse-sdk'; that would weaken it into a tautology.

function span(scopeName: string) {
  return { otelSpan: { instrumentationScope: { name: scopeName } } }
}

describe('shouldExportSpan', () => {
  it('keeps spans from the Langfuse tracer', () => {
    expect(shouldExportSpan(span(LANGFUSE_TRACER_NAME))).toBe(true)
  })

  it('keeps Vercel AI SDK spans so experimental_telemetry is not silently dropped', () => {
    // `ai` is the AI SDK's instrumentation scope. If this flips to false, turning
    // on `experimental_telemetry` produces no traces and no error — the failure
    // would look like "the feature does nothing".
    expect(shouldExportSpan(span('ai'))).toBe(true)
  })

  it('drops auto-instrumented fetch/HTTP spans', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. `@vercel/otel` instruments `fetch`,
    // so with a truthy predicate every outbound call — Anthropic, Supabase,
    // Voyage, Sendblue — shipped a span whose NAME is the full URL. A Supabase
    // REST URL carries table and filter values, so a guest id or phone number
    // rides in a span name that LANGFUSE_CAPTURE_CONTENT does not gate.
    expect(shouldExportSpan(span('@vercel/otel'))).toBe(false)
    expect(shouldExportSpan(span('@opentelemetry/instrumentation-fetch'))).toBe(
      false,
    )
    expect(
      shouldExportSpan(span('@opentelemetry/instrumentation-undici')),
    ).toBe(false)
    expect(shouldExportSpan(span('next.js'))).toBe(false)
  })

  it('drops an unknown scope rather than defaulting to keep', () => {
    // Fail-closed on volume: a new instrumentor added by a dependency upgrade
    // must not start billing us for spans nobody chose to collect. The cost of
    // being wrong here is a missing span, which the smoke test catches; the cost
    // of the opposite is silent ingestion growth, which nothing catches.
    expect(shouldExportSpan(span('some-future-instrumentor'))).toBe(false)
    expect(shouldExportSpan(span(''))).toBe(false)
  })

  it('matches the scope exactly, not by prefix', () => {
    // A prefix match would let `langfuse-sdk-something-else` through. Exactness
    // is what makes the allowlist an allowlist.
    expect(shouldExportSpan(span(`${LANGFUSE_TRACER_NAME}-other`))).toBe(false)
    expect(shouldExportSpan(span('ai.something'))).toBe(false)
    expect(shouldExportSpan(span('notai'))).toBe(false)
  })
})

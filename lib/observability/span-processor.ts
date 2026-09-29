import { LANGFUSE_TRACER_NAME } from '@langfuse/core'
import { LangfuseSpanProcessor } from '@langfuse/otel'

// The OpenTelemetry span processor that ships spans to Langfuse, plus the
// single source of truth for "is observability on".
//
// WHY THIS IS ITS OWN MODULE. Two callers need the SAME processor instance and
// neither can own it:
//   - `instrumentation.ts` registers it with the tracer provider at startup.
//   - `langfuse.ts` calls `forceFlush()` on it at the end of every agent run.
// A module-level lazy singleton is what makes those the same object. Importing
// the processor FROM `instrumentation.ts` would work on Vercel and break in
// any context where `register()` never runs.
//
// WHY LAZY. Constructing the processor at module load runs an SDK init in the
// test process, and `vi.mock` does not help because mocks intercept resolution,
// not transitive eager init (CLAUDE.md, "Module split for testability"). Same
// cached-singleton shape the v3 wrapper used for its client.

export interface LangfuseConfig {
  publicKey: string
  secretKey: string
  baseUrl: string
}

/**
 * Instrumentation scopes whose spans belong in the Langfuse trace stream.
 *
 * `langfuse-sdk` is every span this repo creates — `startObservation` is the
 * only way `lib/observability/langfuse.ts` makes one, so this is uniformly true
 * for our parents AND their children. `ai` is the Vercel AI SDK's scope, kept
 * so `experimental_telemetry` lands the day someone turns it on rather than
 * being silently dropped.
 *
 * DERIVED from the SDK constant, not a pasted literal: if Langfuse renames its
 * tracer, this follows and `span-processor.test.ts` proves the value still
 * matches what `startObservation` actually stamps.
 */
const EXPORTED_INSTRUMENTATION_SCOPES: readonly string[] = [LANGFUSE_TRACER_NAME, 'ai']

/**
 * Whether a finished span should be shipped to Langfuse.
 *
 * Exported for the test; `getLangfuseSpanProcessor` wires it in.
 */
export function shouldExportSpan({
  otelSpan,
}: {
  otelSpan: { instrumentationScope: { name: string } }
}): boolean {
  return EXPORTED_INSTRUMENTATION_SCOPES.includes(otelSpan.instrumentationScope.name)
}

/**
 * Read Langfuse config, or null when observability should be off.
 *
 * Off means: test environment, an explicit disable, or incomplete credentials.
 * Callers treat null as "run in no-op mode" — never as an error.
 */
export function readLangfuseConfig(): LangfuseConfig | null {
  if (process.env.NODE_ENV === 'test') return null
  if (process.env.LANGFUSE_ENABLED === 'false') return null
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim()
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim()
  // Accept LANGFUSE_HOST as a legacy alias for LANGFUSE_BASE_URL — Langfuse's
  // own docs and Vercel integration use HOST, but THE-200 originally landed on
  // BASE_URL (matches the SDK's `baseUrl` constructor field). BASE_URL takes
  // precedence when both are set; either alone works.
  // `||` (not `??`) so an empty string after .trim() falls through to the alias.
  const baseUrl =
    process.env.LANGFUSE_BASE_URL?.trim() || process.env.LANGFUSE_HOST?.trim()
  if (!publicKey || !secretKey || !baseUrl) return null
  return { publicKey, secretKey, baseUrl }
}

let cachedProcessor: LangfuseSpanProcessor | null | undefined
let initErrored = false

/**
 * The processor, or null when observability is off or construction threw.
 *
 * Never throws. A Langfuse outage or a malformed config must not stop the
 * process from booting — observability is diagnostic, not load-bearing.
 */
export function getLangfuseSpanProcessor(): LangfuseSpanProcessor | null {
  if (cachedProcessor !== undefined) return cachedProcessor
  const config = readLangfuseConfig()
  if (!config) {
    cachedProcessor = null
    return null
  }
  try {
    cachedProcessor = new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      // FILTER EXPLICITLY, by instrumentation scope. See shouldExportSpan above.
      //
      // This started life as `() => true`, on the reasoning that v5's default
      // filter drops spans SILENTLY and could break a trace tree by dropping a
      // parent while keeping its children. Reading the SDK showed that was
      // wrong: its `isLangfuseSpan` keys on the instrumentation scope, which is
      // uniform across everything `startObservation` creates, so it could never
      // split one of our trees.
      //
      // `() => true` was actively harmful, and the smoke test is what caught it.
      // `@vercel/otel` auto-instruments `fetch`, so exporting everything shipped
      // a span for every outbound HTTP call — Anthropic, Supabase, Voyage,
      // Sendblue — into the trace stream, with the full URL as the span NAME.
      // That is ingestion volume nobody asked for and a PII surface: a Supabase
      // REST URL carries table and filter values, so a guest id or phone number
      // would ride in a span name that `LANGFUSE_CAPTURE_CONTENT=false` does not
      // gate.
      //
      // Keep this scope-based. Widening it to a truthy default re-opens both
      // problems at once.
      shouldExportSpan,
    })
    return cachedProcessor
  } catch (e) {
    initErrored = true
    console.warn(
      '[observability] langfuse span processor init failed, falling back to no-op',
      e instanceof Error ? e.message : String(e),
    )
    cachedProcessor = null
    return null
  }
}

/** True when observability is configured and the processor was constructed. */
export function isObservabilityEnabled(): boolean {
  return getLangfuseSpanProcessor() !== null
}

export function langfuseInitFailed(): boolean {
  // Force construction so a caller asking before first use gets the real
  // answer rather than a stale `false`.
  getLangfuseSpanProcessor()
  return initErrored
}

/** Test seam: clear the cached processor so env changes take effect. */
export function _resetSpanProcessorForTest(): void {
  cachedProcessor = undefined
  initErrored = false
}

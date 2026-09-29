// Next.js instrumentation hook. Runs once per runtime at startup, before any
// request is served, which is the only place an OpenTelemetry tracer provider
// can be registered early enough to catch the first span.
//
// WHY THIS FILE EXISTS AT ALL (2026-09-29). Langfuse JS SDK v3 shipped traces
// over the legacy batch ingestion API, which Langfuse Cloud REMOVES on
// 2026-11-16. After that date a v3 client ingests nothing — silently, since
// the failure is server-side. SDK v5 is OpenTelemetry-native and needs an OTel
// setup, so this hook is a hard requirement of staying observable, not an
// architectural preference. See lib/observability/CLAUDE.md.
//
// NODE RUNTIME ONLY. `LangfuseSpanProcessor` depends on Node APIs and is not
// edge-safe. `register()` is invoked for every runtime Next builds, so the
// guard is what stops the edge bundle pulling in a Node-only dependency — a
// build failure, not a runtime one, and one that only appears when a middleware
// or edge route exists.
//
// DYNAMIC IMPORTS, not top-level. A static import runs the module graph in
// every runtime regardless of the guard below, which defeats it.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  try {
    const { registerOTel } = await import('@vercel/otel')
    const { getLangfuseSpanProcessor } = await import('./lib/observability/span-processor')

    const processor = getLangfuseSpanProcessor()
    // null means observability is deliberately off — no keys, LANGFUSE_ENABLED
    // false, or a test environment. Registering a provider with no processor
    // would create real spans with nowhere to go and a non-empty trace id,
    // which is worse than not registering: `messages.langfuse_trace_id` would
    // fill with ids that resolve to nothing.
    if (!processor) return

    registerOTel({
      serviceName: 'analog-guest',
      spanProcessors: [processor],
    })
  } catch (e) {
    // Never throw from here. A failure to set up observability must not stop
    // the app from booting — the wrapper degrades to no-op spans on its own.
    console.warn(
      '[observability] OTel registration failed, continuing without tracing',
      e instanceof Error ? e.message : String(e),
    )
  }
}

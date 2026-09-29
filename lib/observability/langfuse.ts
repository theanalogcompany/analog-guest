import { LangfuseClient } from '@langfuse/client'
import { LangfuseOtelSpanAttributes } from '@langfuse/core'
import {
  type LangfuseSpan as SdkObservation,
  startObservation,
} from '@langfuse/tracing'

import {
  _resetSpanProcessorForTest,
  getLangfuseSpanProcessor,
  langfuseInitFailed,
  readLangfuseConfig,
} from './span-processor'

// Thin wrapper around Langfuse so the agent code never touches the SDK
// directly — keeps lib/agent provider-agnostic and lets the rest of the
// codebase stay testable without mocking SDK internals.
//
// MIGRATED v3 -> v5 (OpenTelemetry-native) on 2026-09-29. The public
// AgentTrace / AgentSpan interfaces below are UNCHANGED from the v3 versions,
// which is the whole point: 20 consumer files across lib/agent, lib/voices,
// app/admin and scripts/measurement import these types and none of them
// changed. That was the payoff of having a wrapper at all.
//
// Why the migration was not optional: Langfuse Cloud removes the legacy batch
// ingestion API on 2026-11-16, after which a v3 client ingests nothing, with
// no client-side error. See lib/observability/CLAUDE.md.
//
// Three guarantees, unchanged from v3:
//   1. Every public method is no-op safe. If the SDK isn't configured (no
//      keys, NODE_ENV=test, LANGFUSE_ENABLED=false, init throws), wrapper
//      methods are silent no-ops and `trace.id === ''`. Agent code can
//      always call `trace.span(...).end(...)` without a guard.
//   2. The wrapper never throws. SDK exceptions are caught at the wrapper
//      boundary and swallowed (logged via console.warn). Observability is
//      diagnostic, not load-bearing — a Langfuse outage must not kill an
//      agent run.
//   3. Trace IDs are available synchronously the moment `startAgentTrace`
//      returns, so callers can write `trace.id` to messages.langfuse_trace_id
//      at insert time without waiting for a flush round-trip. In v5 this is
//      `observation.traceId`, a plain readonly field.

export interface AgentSpan {
  readonly id: string
  span(name: string, input?: unknown, content?: unknown): AgentSpan
  generation(name: string, input?: unknown, content?: unknown): AgentSpan
  update(body: AgentSpanUpdate): void
  end(body?: AgentSpanUpdate): void
}

export interface AgentTrace {
  /** Langfuse trace id, or '' when observability is disabled/no-op. */
  readonly id: string
  /**
   * True when LANGFUSE_CAPTURE_CONTENT !== 'false' (default-on per THE-216).
   * Agent code can read this to skip pre-computing heavy content payloads
   * that would just be dropped. Always false when the wrapper is no-op.
   */
  readonly captureContent: boolean
  span(name: string, input?: unknown, content?: unknown): AgentSpan
  /**
   * A model call sitting directly under the trace rather than nested in a span.
   * `classify` is one. Use this rather than `span()` for anything that calls a
   * model: Langfuse prices only GENERATION observations, so a model call
   * recorded as a plain span reports $0 whatever usage it carries.
   */
  generation(name: string, input?: unknown, content?: unknown): AgentSpan
  update(body: AgentTraceUpdate): void
  flushAsync(): Promise<void>
}

export interface AgentTraceUpdate {
  output?: unknown
  metadata?: Record<string, unknown>
  /**
   * Heavy content (full bodies, prompts, corpus chunk text). Captured only
   * when LANGFUSE_CAPTURE_CONTENT !== 'false'. Wrapper merges into the SDK
   * call's output payload as `output.content` when on; drops entirely when
   * off so capture-off shape matches THE-200 metadata-only exactly.
   */
  content?: unknown
}

export interface AgentSpanUpdate {
  output?: unknown
  metadata?: Record<string, unknown>
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR'
  statusMessage?: string
  /** See AgentTraceUpdate.content. */
  content?: unknown
  /**
   * Model id, e.g. `claude-haiku-4-5-20251001`. Only meaningful on a span
   * created with `generation()`. Langfuse needs it to price the call at all —
   * without it the observation costs $0 whatever usage says.
   */
  model?: string
  /**
   * Token usage, in Langfuse's NATIVE usage fields rather than stuffed into
   * `output`. This is what makes tokens, cost and prompt-cache hit rate
   * aggregable by the metrics API; an `output.cacheReadTokens` is readable only
   * by scraping individual observations.
   *
   * KEY NAMES ARE NOT FREE CHOICE. Use `AgentUsage` — they must match what the
   * AI SDK's own `experimental_telemetry` emits, or the two sources would
   * aggregate into different buckets and no dashboard could span the switchover.
   * Verified against a live probe on 2026-09-29.
   */
  usage?: AgentUsage
}

/**
 * Langfuse-native usage keys, matching the AI SDK telemetry mapping exactly.
 *
 * THE THREE INPUT BUCKETS ARE DISJOINT AND LANGFUSE SUMS THEM. Verified against
 * a live probe on 2026-09-29: 194 input + 128 cached + 64 cache-creation priced
 * as 194x base + 128x the cache-read rate + 64x the cache-write rate, added
 * together. So an `input` that still contains the cached tokens bills them
 * twice, at two different rates, and the error is invisible - it produces a
 * plausible cost that is simply too high.
 *
 * Build one with `toAgentUsage()` rather than by hand; it owns that arithmetic.
 */
export interface AgentUsage {
  /**
   * UNCACHED input tokens only. NOT the AI SDK's `usage.inputTokens`, which is
   * `noCache + cacheRead + cacheWrite` - see the note above.
   */
  input?: number
  output?: number
  /** Grand total across all four buckets. */
  total?: number
  /** Prompt-cache READ tokens (a hit). */
  input_cached_tokens?: number
  /** Prompt-cache WRITE tokens (populating the cache). */
  input_cache_creation?: number
}

/**
 * Map an AI SDK `usage` object to Langfuse's native keys.
 *
 * Pass the SDK's `usage` through as-is. The disjointness arithmetic lives HERE
 * rather than at the call sites because the trap is silent and the shape invites
 * it: `usage.inputTokens` reads like "the input tokens" and is actually the
 * total including both cache buckets, so every call site that spelled the
 * obvious mapping would inflate cost. One place to get it right.
 *
 * Omits zero/absent values rather than writing 0: a literal 0 and "this
 * provider does not report it" are different facts, and Langfuse charts the
 * former as a real data point.
 */
export function toAgentUsage(input: {
  /** `inputTokens.total` - includes both cache buckets. Used only as a fallback. */
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  cachedInputTokens?: number | null
  /** The SDK's provider-independent breakdown. Preferred over every fallback. */
  inputTokenDetails?: {
    noCacheTokens?: number | null
    cacheWriteTokens?: number | null
  } | null
  /**
   * Anthropic-only cache-creation count off `providerMetadata`. Kept as a
   * fallback for callers that already read it that way; `inputTokenDetails`
   * carries the same number provider-independently and wins when present.
   */
  cacheCreationInputTokens?: number | null
}): AgentUsage {
  const cacheRead = input.cachedInputTokens ?? 0
  const cacheWrite =
    input.inputTokenDetails?.cacheWriteTokens ??
    input.cacheCreationInputTokens ??
    0

  // Prefer the SDK's own breakdown. The subtraction is a fallback for a provider
  // that reports no details, and is clamped at 0 because a provider disagreeing
  // with itself must not produce a negative token count Langfuse would then
  // price - better to under-report input than to emit a nonsense figure.
  const uncachedInput =
    input.inputTokenDetails?.noCacheTokens ??
    (input.inputTokens != null
      ? Math.max(0, input.inputTokens - cacheRead - cacheWrite)
      : null)

  const usage: AgentUsage = {}
  if (uncachedInput) usage.input = uncachedInput
  if (input.outputTokens) usage.output = input.outputTokens
  if (input.totalTokens) usage.total = input.totalTokens
  if (cacheRead) usage.input_cached_tokens = cacheRead
  if (cacheWrite) usage.input_cache_creation = cacheWrite
  return usage
}

export interface StartAgentTraceOptions {
  /** Trace name. Use 'agent.inbound' or 'agent.followup'. */
  name: string
  /** Used as Langfuse session id for cross-stage correlation. */
  agentRunId: string
  metadata?: Record<string, unknown>
}

const NOOP_SPAN: AgentSpan = {
  id: '',
  span: () => NOOP_SPAN,
  generation: () => NOOP_SPAN,
  update: () => {},
  end: () => {},
}

const NOOP_TRACE: AgentTrace = {
  id: '',
  captureContent: false,
  span: () => NOOP_SPAN,
  generation: () => NOOP_SPAN,
  update: () => {},
  flushAsync: async () => {},
}

/**
 * Public no-op trace for callers that need a runtime that wires through
 * lib/agent without firing real telemetry — the Voices regen path is the
 * canonical consumer (regen runs 5-20x per session and would flood the
 * trace stream if every one started a real trace).
 */
export const noopAgentTrace: AgentTrace = NOOP_TRACE

export { langfuseInitFailed }

// THE-216: read at module init (deploy-time decision). Default-on; only the
// explicit string 'false' disables. Matches the LANGFUSE_ENABLED precedent.
function readCaptureContent(): boolean {
  return process.env.LANGFUSE_CAPTURE_CONTENT !== 'false'
}

// Build a span-creation `input` payload. When capture-content is on, content
// (when provided) is folded into the input object under a `content` key so it
// renders next to the metadata input in the Langfuse UI. When off, content is
// dropped.
function buildSpanInput(
  input: unknown,
  content: unknown,
  captureContent: boolean,
): unknown {
  if (!captureContent || content === undefined) return input
  if (input === undefined) return { content }
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return { ...(input as Record<string, unknown>), content }
  }
  // Non-object input (string/number/etc.) — wrap so we don't lose either side.
  return { input, content }
}

// Build the SDK update payload from an AgentSpanUpdate. The `content` field
// rides on `output.content` when on; dropped when off so the SDK call body is
// byte-for-byte THE-200's metadata-only shape.
function buildUpdateBody(
  body: AgentSpanUpdate | AgentTraceUpdate | undefined,
  captureContent: boolean,
): Record<string, unknown> {
  if (!body) return {}
  const { content, output, usage, ...rest } = body as AgentSpanUpdate
  const finalOutput =
    captureContent && content !== undefined
      ? typeof output === 'object' && output !== null && !Array.isArray(output)
        ? { ...(output as Record<string, unknown>), content }
        : output === undefined
          ? { content }
          : { output, content }
      : output
  const built: Record<string, unknown> = { ...rest }
  if (finalOutput !== undefined) built.output = finalOutput
  // `usage` -> `usageDetails` is the SDK's field name, renamed at this boundary
  // so ~20 call sites say the ordinary word. An EMPTY object is dropped rather
  // than sent: Langfuse treats a present-but-empty usageDetails as a priced
  // observation with zero tokens, which charts as a real $0 data point and is
  // indistinguishable from a genuinely free call.
  //
  // NOT gated on captureContent. Token counts are metadata, not content — they
  // carry no guest text, and turning content capture off must not blind the
  // cost dashboards.
  if (usage && Object.keys(usage).length > 0) built.usageDetails = usage
  return built
}

function wrapSpan(
  observation: SdkObservation,
  captureContent: boolean,
): AgentSpan {
  return {
    get id() {
      return observation.id
    },
    span(name, input, content) {
      try {
        return wrapSpan(
          observation.startObservation(name, {
            input: buildSpanInput(input, content, captureContent),
          }),
          captureContent,
        )
      } catch (e) {
        console.warn(
          '[observability] span.span failed',
          e instanceof Error ? e.message : e,
        )
        return NOOP_SPAN
      }
    },
    generation(name, input, content) {
      try {
        // `asType: 'generation'` is v5's replacement for v3's `.generation()`.
        // Returns a LangfuseGeneration, which extends the same base class, so
        // it satisfies everything wrapSpan touches.
        return wrapSpan(
          observation.startObservation(
            name,
            { input: buildSpanInput(input, content, captureContent) },
            { asType: 'generation' },
          ) as unknown as SdkObservation,
          captureContent,
        )
      } catch (e) {
        console.warn(
          '[observability] span.generation failed',
          e instanceof Error ? e.message : e,
        )
        return NOOP_SPAN
      }
    },
    update(body) {
      try {
        observation.update(buildUpdateBody(body, captureContent))
      } catch (e) {
        console.warn(
          '[observability] span.update failed',
          e instanceof Error ? e.message : e,
        )
      }
    },
    end(body) {
      try {
        // v3's `end(body)` did both in one call. v5 splits them: attributes
        // land via update(), then end() closes the span. ORDER MATTERS —
        // attributes set after end() are dropped.
        if (body) observation.update(buildUpdateBody(body, captureContent))
        observation.end()
      } catch (e) {
        console.warn(
          '[observability] span.end failed',
          e instanceof Error ? e.message : e,
        )
      }
    },
  }
}

// v5 renamed the read-API trace type. Aliased to the v3 name so the admin
// trace panel and select-trace-stages.ts keep their imports unchanged.
export type { TraceWithFullDetails as ApiTraceWithFullDetails } from '@langfuse/core'
import type { TraceWithFullDetails } from '@langfuse/core'

let cachedClient: LangfuseClient | null | undefined

// Separate from the span processor on purpose: the processor is the WRITE
// path and is registered once at startup by instrumentation.ts, while this is
// the READ path used only by the admin trace panel. Sharing one object would
// mean the admin surface could not work without tracing being registered.
function getReadClient(): LangfuseClient | null {
  if (cachedClient !== undefined) return cachedClient
  const config = readLangfuseConfig()
  if (!config) {
    cachedClient = null
    return null
  }
  try {
    cachedClient = new LangfuseClient({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
    })
    return cachedClient
  } catch (e) {
    console.warn(
      '[observability] langfuse read client init failed',
      e instanceof Error ? e.message : String(e),
    )
    cachedClient = null
    return null
  }
}

// Test seam: clear cached client and processor. Lets the langfuse env-presence
// check on /admin/health probe the current state of process.env without
// restarting.
export function _resetLangfuseClientForTest(): void {
  cachedClient = undefined
  _resetSpanProcessorForTest()
}

/**
 * Server-only. Fetch a single trace by ID from Langfuse Cloud's read API.
 * Used by the conversation viewer admin route (THE-201) to render the
 * agent's reasoning inline next to its outbound message.
 *
 * Returns null on:
 *   - empty/blank traceId (don't bother calling the SDK)
 *   - wrapper in no-op mode (no client configured)
 *   - SDK throw (network failure, 404, auth failure, anything)
 *
 * Same never-throw discipline as the rest of the wrapper. Callers render
 * "trace unavailable" UI on null. No retry — the API route handler issues
 * fresh fetches per click, so transient failures self-heal on user retry.
 */
export async function fetchTrace(
  traceId: string,
): Promise<TraceWithFullDetails | null> {
  const trimmed = traceId.trim()
  if (!trimmed) return null
  const client = getReadClient()
  if (!client) return null
  try {
    return await client.fetchTrace(trimmed)
  } catch (e) {
    console.warn(
      '[observability] fetchTrace failed',
      e instanceof Error ? e.message : String(e),
    )
    return null
  }
}

export function startAgentTrace(opts: StartAgentTraceOptions): AgentTrace {
  const processor = getLangfuseSpanProcessor()
  // No processor means no-op mode. Checked EXPLICITLY rather than relying on
  // OTel's no-op tracer, because a no-op tracer still yields a (zero-filled)
  // trace id and the contract here is `trace.id === ''`. That id is written to
  // `messages.langfuse_trace_id`, so the difference is a column full of ids
  // that resolve to nothing versus a column of nulls.
  if (!processor) return NOOP_TRACE

  // Read once per trace. A redeploy is required to flip the toggle; per-call
  // env reads buy nothing for what is fundamentally a deploy-time decision.
  const captureContent = readCaptureContent()

  let root: SdkObservation
  try {
    root = startObservation(opts.name, {
      metadata: { agentRunId: opts.agentRunId, ...opts.metadata },
    })
    // Session id is how a run is found in the Langfuse UI and how stages
    // correlate. v5 exposes it as an OTel attribute rather than a constructor
    // field — `propagateAttributes` is the documented path but it is
    // callback-scoped, and this API hands a trace object back to straight-line
    // code across ~20 call sites. Setting the attribute directly is what keeps
    // the interface unchanged.
    root.otelSpan.setAttribute(
      LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
      opts.agentRunId,
    )
    root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, opts.name)
  } catch (e) {
    console.warn(
      '[observability] trace creation failed, falling back to no-op',
      e instanceof Error ? e.message : e,
    )
    return NOOP_TRACE
  }

  // The root is a real span in v5 and has to be closed, or `agent.inbound`
  // gets no duration — which is the end-to-end number the latency baseline is
  // built on. AgentTrace has no `end()` and adding one would touch every
  // consumer, so the root is ended inside flushAsync().
  //
  // That is sound rather than convenient: every handler already awaits
  // `trace.flushAsync()` in its `finally`, so flush IS the "this run is over"
  // signal. Guarded by `ended` because a second flush must not end it twice.
  let ended = false

  return {
    get id() {
      return root.traceId
    },
    captureContent,
    span(name, input, content) {
      try {
        return wrapSpan(
          root.startObservation(name, {
            input: buildSpanInput(input, content, captureContent),
          }),
          captureContent,
        )
      } catch (e) {
        console.warn(
          '[observability] trace.span failed',
          e instanceof Error ? e.message : e,
        )
        return NOOP_SPAN
      }
    },
    generation(name, input, content) {
      try {
        // Same as span() but `asType: 'generation'`, which is what makes Langfuse
        // price the observation. See AgentTrace.generation.
        return wrapSpan(
          root.startObservation(
            name,
            { input: buildSpanInput(input, content, captureContent) },
            { asType: 'generation' },
          ) as unknown as SdkObservation,
          captureContent,
        )
      } catch (e) {
        console.warn(
          '[observability] trace.generation failed',
          e instanceof Error ? e.message : e,
        )
        return NOOP_SPAN
      }
    },
    update(body) {
      try {
        root.update(buildUpdateBody(body, captureContent))
      } catch (e) {
        console.warn(
          '[observability] trace.update failed',
          e instanceof Error ? e.message : e,
        )
      }
    },
    async flushAsync() {
      try {
        if (!ended) {
          ended = true
          root.end()
        }
        await processor.forceFlush()
      } catch (e) {
        console.warn(
          '[observability] flushAsync failed',
          e instanceof Error ? e.message : e,
        )
      }
    },
  }
}

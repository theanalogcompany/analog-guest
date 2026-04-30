import { type ApiTraceWithFullDetails, Langfuse } from 'langfuse'

// Thin wrapper around the langfuse SDK so the agent code never touches the
// SDK directly — keeps lib/agent provider-agnostic and lets the rest of the
// codebase stay testable without mocking Langfuse internals.
//
// Three guarantees:
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
//      at insert time without waiting for a flush round-trip.

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
  update: () => {},
  flushAsync: async () => {},
}

interface LangfuseConfig {
  publicKey: string
  secretKey: string
  baseUrl: string
}

function readConfig(): LangfuseConfig | null {
  if (process.env.NODE_ENV === 'test') return null
  if (process.env.LANGFUSE_ENABLED === 'false') return null
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim()
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim()
  // Accept LANGFUSE_HOST as a legacy alias for LANGFUSE_BASE_URL — Langfuse's
  // own docs and Vercel integration use HOST, but THE-200 originally landed
  // on BASE_URL (matches the SDK's `baseUrl` constructor field). BASE_URL
  // takes precedence when both are set; either alone works. Slated for
  // removal post-pilot once everyone has migrated to BASE_URL.
  // `||` (not `??`) so an empty-string after .trim() falls through to the alias.
  const baseUrl =
    process.env.LANGFUSE_BASE_URL?.trim() || process.env.LANGFUSE_HOST?.trim()
  if (!publicKey || !secretKey || !baseUrl) return null
  return { publicKey, secretKey, baseUrl }
}

// THE-216: read at module init (deploy-time decision). Default-on; only the
// explicit string 'false' disables. Matches the LANGFUSE_ENABLED precedent.
function readCaptureContent(): boolean {
  return process.env.LANGFUSE_CAPTURE_CONTENT !== 'false'
}

let cachedClient: Langfuse | null | undefined
let cachedClientInitErrored = false

function getClient(): Langfuse | null {
  if (cachedClient !== undefined) return cachedClient
  const config = readConfig()
  if (!config) {
    cachedClient = null
    return null
  }
  try {
    cachedClient = new Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
    })
    return cachedClient
  } catch (e) {
    cachedClientInitErrored = true
    console.warn(
      '[observability] langfuse init failed, falling back to no-op',
      e instanceof Error ? e.message : String(e),
    )
    cachedClient = null
    return null
  }
}

// Test seam: clear cached client. Lets the langfuse env-presence check on
// /admin/health probe the current state of process.env without restarting.
export function _resetLangfuseClientForTest(): void {
  cachedClient = undefined
  cachedClientInitErrored = false
}

export function langfuseInitFailed(): boolean {
  return cachedClientInitErrored
}

// Internal: typed shape we actually use from the SDK. Subset of
// LangfuseSpanClient — kept narrow so mocks in tests don't have to fake the
// rest of the API surface.
interface SdkSpanLike {
  id: string
  span: (body: { name: string; input?: unknown }) => SdkSpanLike
  generation: (body: { name: string; input?: unknown }) => SdkSpanLike
  update: (body: Record<string, unknown>) => unknown
  end: (body?: Record<string, unknown>) => unknown
}

interface SdkTraceLike {
  id: string
  span: (body: { name: string; input?: unknown }) => SdkSpanLike
  update: (body: Record<string, unknown>) => unknown
}

// Build a span-creation `input` payload. When capture-content is on, content
// (when provided) is folded into the input object under a `content` key so it
// renders next to the metadata input in the Langfuse UI. When off, content is
// dropped.
function buildSpanInput(input: unknown, content: unknown, captureContent: boolean): unknown {
  if (!captureContent || content === undefined) return input
  if (input === undefined) return { content }
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return { ...(input as Record<string, unknown>), content }
  }
  // Non-object input (string/number/etc.) — wrap so we don't lose either side.
  return { input, content }
}

// Build the SDK update/end payload from an AgentSpanUpdate. The `content` field
// rides on `output.content` when on; dropped when off so the SDK call body is
// byte-for-byte THE-200's metadata-only shape.
function buildUpdateBody(
  body: AgentSpanUpdate | AgentTraceUpdate | undefined,
  captureContent: boolean,
): Record<string, unknown> {
  if (!body) return {}
  const { content, output, ...rest } = body as AgentSpanUpdate
  const finalOutput =
    captureContent && content !== undefined
      ? typeof output === 'object' && output !== null && !Array.isArray(output)
        ? { ...(output as Record<string, unknown>), content }
        : output === undefined
          ? { content }
          : { output, content }
      : output
  if (finalOutput === undefined) return { ...rest }
  return { ...rest, output: finalOutput }
}

function wrapSpan(span: SdkSpanLike, captureContent: boolean): AgentSpan {
  return {
    get id() {
      return span.id
    },
    span(name, input, content) {
      try {
        return wrapSpan(
          span.span({ name, input: buildSpanInput(input, content, captureContent) }),
          captureContent,
        )
      } catch (e) {
        console.warn('[observability] span.span failed', e instanceof Error ? e.message : e)
        return NOOP_SPAN
      }
    },
    generation(name, input, content) {
      try {
        return wrapSpan(
          span.generation({ name, input: buildSpanInput(input, content, captureContent) }),
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
        span.update(buildUpdateBody(body, captureContent))
      } catch (e) {
        console.warn('[observability] span.update failed', e instanceof Error ? e.message : e)
      }
    },
    end(body) {
      try {
        span.end(buildUpdateBody(body, captureContent))
      } catch (e) {
        console.warn('[observability] span.end failed', e instanceof Error ? e.message : e)
      }
    },
  }
}

export type { ApiTraceWithFullDetails } from 'langfuse'

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
export async function fetchTrace(traceId: string): Promise<ApiTraceWithFullDetails | null> {
  const trimmed = traceId.trim()
  if (!trimmed) return null
  const client = getClient()
  if (!client) return null
  try {
    return await client.api.traceGet(trimmed)
  } catch (e) {
    console.warn(
      '[observability] fetchTrace failed',
      e instanceof Error ? e.message : String(e),
    )
    return null
  }
}

export function startAgentTrace(opts: StartAgentTraceOptions): AgentTrace {
  const client = getClient()
  if (!client) return NOOP_TRACE

  // Read once per trace. A redeploy is required to flip the toggle; per-call
  // env reads buy nothing for what is fundamentally a deploy-time decision.
  const captureContent = readCaptureContent()

  let trace: SdkTraceLike
  try {
    trace = client.trace({
      name: opts.name,
      sessionId: opts.agentRunId,
      metadata: { agentRunId: opts.agentRunId, ...opts.metadata },
    }) as unknown as SdkTraceLike
  } catch (e) {
    console.warn(
      '[observability] trace creation failed, falling back to no-op',
      e instanceof Error ? e.message : e,
    )
    return NOOP_TRACE
  }

  return {
    get id() {
      return trace.id
    },
    captureContent,
    span(name, input, content) {
      try {
        return wrapSpan(
          trace.span({ name, input: buildSpanInput(input, content, captureContent) }),
          captureContent,
        )
      } catch (e) {
        console.warn('[observability] trace.span failed', e instanceof Error ? e.message : e)
        return NOOP_SPAN
      }
    },
    update(body) {
      try {
        trace.update(buildUpdateBody(body, captureContent))
      } catch (e) {
        console.warn('[observability] trace.update failed', e instanceof Error ? e.message : e)
      }
    },
    async flushAsync() {
      try {
        await client.flushAsync()
      } catch (e) {
        console.warn('[observability] flushAsync failed', e instanceof Error ? e.message : e)
      }
    },
  }
}

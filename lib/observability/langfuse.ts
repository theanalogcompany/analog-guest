import { Langfuse } from 'langfuse'

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
  span(name: string, input?: unknown): AgentSpan
  generation(name: string, input?: unknown): AgentSpan
  update(body: AgentSpanUpdate): void
  end(body?: AgentSpanUpdate): void
}

export interface AgentTrace {
  /** Langfuse trace id, or '' when observability is disabled/no-op. */
  readonly id: string
  span(name: string, input?: unknown): AgentSpan
  update(body: { output?: unknown; metadata?: Record<string, unknown> }): void
  flushAsync(): Promise<void>
}

export interface AgentSpanUpdate {
  output?: unknown
  metadata?: Record<string, unknown>
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR'
  statusMessage?: string
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
  const baseUrl = process.env.LANGFUSE_BASE_URL?.trim()
  if (!publicKey || !secretKey || !baseUrl) return null
  return { publicKey, secretKey, baseUrl }
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
  update: (body: AgentSpanUpdate) => unknown
  end: (body?: AgentSpanUpdate) => unknown
}

interface SdkTraceLike {
  id: string
  span: (body: { name: string; input?: unknown }) => SdkSpanLike
  update: (body: { output?: unknown; metadata?: Record<string, unknown> }) => unknown
}

function wrapSpan(span: SdkSpanLike): AgentSpan {
  return {
    get id() {
      return span.id
    },
    span(name, input) {
      try {
        return wrapSpan(span.span({ name, input }))
      } catch (e) {
        console.warn('[observability] span.span failed', e instanceof Error ? e.message : e)
        return NOOP_SPAN
      }
    },
    generation(name, input) {
      try {
        return wrapSpan(span.generation({ name, input }))
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
        span.update(body)
      } catch (e) {
        console.warn('[observability] span.update failed', e instanceof Error ? e.message : e)
      }
    },
    end(body) {
      try {
        span.end(body)
      } catch (e) {
        console.warn('[observability] span.end failed', e instanceof Error ? e.message : e)
      }
    },
  }
}

export function startAgentTrace(opts: StartAgentTraceOptions): AgentTrace {
  const client = getClient()
  if (!client) return NOOP_TRACE

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
    span(name, input) {
      try {
        return wrapSpan(trace.span({ name, input }))
      } catch (e) {
        console.warn('[observability] trace.span failed', e instanceof Error ? e.message : e)
        return NOOP_SPAN
      }
    },
    update(body) {
      try {
        trace.update(body)
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

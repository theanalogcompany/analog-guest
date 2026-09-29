import { LANGFUSE_TRACER_NAME, LangfuseOtelSpanAttributes } from '@langfuse/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mocks for the Langfuse v5 packages. The v3 version of this file
// mocked the single `langfuse` package; v5 splits write (@langfuse/otel +
// @langfuse/tracing) from read (@langfuse/client), so there are three.
//
// `@langfuse/core` is deliberately NOT mocked. The wrapper reads
// `LangfuseOtelSpanAttributes` from it for the session-id attribute key, and a
// mock would let this file assert a key it invented against a key it invented
// — proving nothing about the real constant. Importing it real is what makes
// the sessionId assertion below a binding test.

const processorCtor = vi.fn()
const forceFlush = vi.fn().mockResolvedValue(undefined)

vi.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: class MockProcessor {
    forceFlush = forceFlush
    constructor(opts: unknown) {
      processorCtor(opts)
    }
  },
}))

interface FakeObservation {
  id: string
  traceId: string
  otelSpan: { setAttribute: ReturnType<typeof vi.fn> }
  startObservation: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

let lastRoot: FakeObservation | null = null

function makeFakeObservation(id: string, traceId: string): FakeObservation {
  const obs: FakeObservation = {
    id,
    traceId,
    otelSpan: { setAttribute: vi.fn() },
    startObservation: vi.fn((childName: string) =>
      makeFakeObservation(`${id}.${childName}`, traceId),
    ),
    update: vi.fn(),
    end: vi.fn(),
  }
  return obs
}

// Rest-tuple param, not two named ones: the fake ignores the attributes but the
// mock must still RECORD them, because the metadata payload is what the
// trace-creation test asserts on.
const startObservationMock = vi.fn((...args: [name: string, attrs?: unknown]) => {
  const root = makeFakeObservation(args[0], `trace-id-${args[0]}`)
  lastRoot = root
  return root
})

vi.mock('@langfuse/tracing', () => ({
  startObservation: (name: string, attrs?: unknown) => startObservationMock(name, attrs),
}))

const clientCtor = vi.fn()
const fetchTraceMock = vi.fn()

vi.mock('@langfuse/client', () => ({
  LangfuseClient: class MockClient {
    fetchTrace = fetchTraceMock
    constructor(opts: unknown) {
      clientCtor(opts)
    }
  },
}))

beforeEach(() => {
  processorCtor.mockReset()
  clientCtor.mockReset()
  forceFlush.mockClear()
  fetchTraceMock.mockReset()
  startObservationMock.mockClear()
  lastRoot = null
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Env for a configured, enabled wrapper. */
function stubLiveEnv(): void {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-test')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-test')
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://us.cloud.langfuse.com')
  vi.stubEnv('LANGFUSE_ENABLED', '')
  // Pinned rather than inherited: capture-content is read per trace, and a value
  // in the operator's real env would otherwise decide what these tests assert.
  vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '')
}

describe('startAgentTrace — no-op cases', () => {
  it('returns a no-op trace when NODE_ENV=test', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://us.cloud.langfuse.com')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-1' })
    expect(trace.id).toBe('')
    expect(processorCtor).not.toHaveBeenCalled()

    // Span tree calls must succeed silently and return id=''
    const span = trace.span('classify', { foo: 1 })
    span.end({ output: { ok: true } })
    expect(span.id).toBe('')
    await expect(trace.flushAsync()).resolves.toBeUndefined()
  })

  it('returns a no-op trace when LANGFUSE_ENABLED=false', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('LANGFUSE_ENABLED', 'false')
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://us.cloud.langfuse.com')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-2' })
    expect(trace.id).toBe('')
    expect(processorCtor).not.toHaveBeenCalled()
  })

  it('returns a no-op trace when keys are missing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', '')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://us.cloud.langfuse.com')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-3' })
    expect(trace.id).toBe('')
    expect(processorCtor).not.toHaveBeenCalled()
  })

  it('creates NO root observation in no-op mode', async () => {
    // Distinct from the id==='' assertions above: those would still pass if the
    // wrapper built a real span and threw the id away, which would leak an
    // unclosed span per turn. This pins that the SDK is never reached at all.
    vi.stubEnv('NODE_ENV', 'test')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-noop' })
    expect(startObservationMock).not.toHaveBeenCalled()
  })
})

describe('startAgentTrace — live mode', () => {
  beforeEach(stubLiveEnv)

  it('initialises the span processor with config and returns a real trace id', async () => {
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({
      name: 'agent.inbound',
      agentRunId: 'run-A',
      metadata: { venueId: 'v1' },
    })
    expect(processorCtor).toHaveBeenCalledOnce()
    expect(processorCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: 'pk-test',
        secretKey: 'sk-test',
        baseUrl: 'https://us.cloud.langfuse.com',
      }),
    )
    expect(trace.id).toBe('trace-id-agent.inbound')
    expect(startObservationMock).toHaveBeenCalledWith('agent.inbound', {
      metadata: { agentRunId: 'run-A', venueId: 'v1' },
    })
  })

  it('passes the scope-based shouldExportSpan, not a truthy default', async () => {
    // v5 filters spans by default and the filter drops them SILENTLY, so the
    // predicate is passed explicitly. It must be the scope-based one:
    // `() => true` also exports every auto-instrumented `fetch` span, which is
    // ingestion volume nobody chose plus a URL-shaped PII surface.
    //
    // Asserts BEHAVIOUR on both sides, not the key's presence: `objectContaining`
    // on the key alone is satisfied by any function at all, including the two
    // wrong ones (always-true and always-false).
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-filter' })
    const opts = processorCtor.mock.calls[0]?.[0] as {
      shouldExportSpan?: (arg: unknown) => boolean
    }
    expect(opts.shouldExportSpan).toBeTypeOf('function')
    const keeps = opts.shouldExportSpan!({
      otelSpan: { instrumentationScope: { name: LANGFUSE_TRACER_NAME } },
    })
    const drops = opts.shouldExportSpan!({
      otelSpan: { instrumentationScope: { name: '@vercel/otel' } },
    })
    expect(keeps).toBe(true)
    expect(drops).toBe(false)
  })

  it('sets the session id on the root span under the real Langfuse attribute key', async () => {
    // Binding test: the key comes from @langfuse/core (unmocked), so a v5
    // rename of TRACE_SESSION_ID fails here instead of silently producing
    // traces that cannot be found by agentRunId in the Langfuse UI.
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-session' })
    expect(lastRoot!.otelSpan.setAttribute).toHaveBeenCalledWith(
      LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
      'run-session',
    )
  })

  it('span / span / generation tree forwards through the SDK', async () => {
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.followup', agentRunId: 'run-B' })
    const generate = trace.span('generate', { foo: 'bar' })
    const attempt = generate.span('generate.attempt_1', { i: 1 })
    const llm = attempt.generation('llm.call', { prompt: 'hi' })
    expect(generate.id).toBe('agent.followup.generate')
    expect(attempt.id).toBe('agent.followup.generate.generate.attempt_1')
    expect(llm.id).toBe('agent.followup.generate.generate.attempt_1.llm.call')

    generate.update({ metadata: { strongCount: 3 } })
    expect(lastRoot!.startObservation).toHaveBeenCalledWith('generate', {
      input: { foo: 'bar' },
    })
  })

  it('generation() asks the SDK for asType generation', async () => {
    // v3 had a dedicated .generation() method; v5 discriminates on an option.
    // Without asType the observation records as a plain span and Langfuse
    // stops treating it as a model call — no token or cost rollup, silently.
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-gen' })
    const span = trace.span('generate')
    const child = lastRoot!.startObservation.mock.results[0]!.value as FakeObservation
    span.generation('llm.call', { prompt: 'hi' })
    expect(child.startObservation).toHaveBeenCalledWith(
      'llm.call',
      { input: { prompt: 'hi' } },
      { asType: 'generation' },
    )
  })

  it('span.end applies attributes BEFORE ending the span', async () => {
    // v3's end(body) did both at once. v5 splits update() from end(), and
    // attributes set after end() are dropped — so a wrong order here loses
    // every span output in the trace with nothing failing.
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-order' })
    const span = trace.span('classify')
    const child = lastRoot!.startObservation.mock.results[0]!.value as FakeObservation
    span.end({ output: { category: 'reply' } })
    expect(child.update).toHaveBeenCalledWith({ output: { category: 'reply' } })
    expect(child.end).toHaveBeenCalledOnce()
    const updateOrder = child.update.mock.invocationCallOrder[0]!
    const endOrder = child.end.mock.invocationCallOrder[0]!
    expect(updateOrder).toBeLessThan(endOrder)
  })

  it('flushAsync ends the root span and force-flushes the processor', async () => {
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-C' })
    await trace.flushAsync()
    expect(lastRoot!.end).toHaveBeenCalledOnce()
    expect(forceFlush).toHaveBeenCalledOnce()
  })

  it('ends the root span exactly once across repeated flushes', async () => {
    // handle-inbound awaits flushAsync in a `finally`, and the extension path
    // can re-enter. Ending a span twice is an SDK-level error.
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-twice' })
    await trace.flushAsync()
    await trace.flushAsync()
    expect(lastRoot!.end).toHaveBeenCalledOnce()
    expect(forceFlush).toHaveBeenCalledTimes(2)
  })

  it('swallows SDK errors and returns no-op spans', async () => {
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-D' })
    lastRoot!.startObservation.mockImplementationOnce(() => {
      throw new Error('network down')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const span = trace.span('classify')
    expect(span.id).toBe('')
    span.end({ output: 'ok' })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('caches the processor across calls (single construction)', async () => {
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-E1' })
    startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-E2' })
    startAgentTrace({ name: 'agent.followup', agentRunId: 'run-E3' })
    expect(processorCtor).toHaveBeenCalledOnce()
  })
})

describe('startAgentTrace — host env aliasing', () => {
  // Verifies LANGFUSE_HOST is accepted as a legacy alias for LANGFUSE_BASE_URL,
  // and BASE_URL wins when both are set. See readLangfuseConfig() in
  // span-processor.ts.
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-test')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-test')
    vi.stubEnv('LANGFUSE_ENABLED', '')
  })

  it('reads LANGFUSE_BASE_URL when only BASE_URL is set', async () => {
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://us.cloud.langfuse.com')
    vi.stubEnv('LANGFUSE_HOST', '')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-h1' })
    expect(processorCtor).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://us.cloud.langfuse.com' }),
    )
  })

  it('reads LANGFUSE_HOST when only HOST is set (legacy alias)', async () => {
    vi.stubEnv('LANGFUSE_BASE_URL', '')
    vi.stubEnv('LANGFUSE_HOST', 'https://cloud.langfuse.com')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-h2' })
    expect(processorCtor).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://cloud.langfuse.com' }),
    )
  })

  it('prefers LANGFUSE_BASE_URL when both are set', async () => {
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://us.cloud.langfuse.com')
    vi.stubEnv('LANGFUSE_HOST', 'https://cloud.langfuse.com')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-h3' })
    expect(processorCtor).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://us.cloud.langfuse.com' }),
    )
  })

  it('no-ops when neither BASE_URL nor HOST is set', async () => {
    vi.stubEnv('LANGFUSE_BASE_URL', '')
    vi.stubEnv('LANGFUSE_HOST', '')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-h4' })
    expect(trace.id).toBe('')
    expect(processorCtor).not.toHaveBeenCalled()
  })
})

describe('startAgentTrace — content capture (THE-216)', () => {
  // Verifies the LANGFUSE_CAPTURE_CONTENT flag wires through to
  // trace.captureContent and that span.end({ output, content }) writes to SDK
  // output.content when on, and drops content entirely when off (THE-200
  // metadata-only parity).
  beforeEach(stubLiveEnv)

  it('defaults captureContent to true when LANGFUSE_CAPTURE_CONTENT is unset', async () => {
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'cc-1' })
    expect(trace.captureContent).toBe(true)
  })

  it('treats LANGFUSE_CAPTURE_CONTENT=true as on (any non-false value)', async () => {
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', 'true')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'cc-2' })
    expect(trace.captureContent).toBe(true)
  })

  it('treats arbitrary values like "yes" as on (only "false" disables)', async () => {
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', 'yes')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'cc-3' })
    expect(trace.captureContent).toBe(true)
  })

  it('disables when LANGFUSE_CAPTURE_CONTENT=false', async () => {
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', 'false')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'cc-4' })
    expect(trace.captureContent).toBe(false)
  })

  it('with capture-on, span.end folds content into output.content', async () => {
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'cc-5' })
    const span = trace.span('classify', { length: 10 }, { fullBody: 'hi there' })
    const child = lastRoot!.startObservation.mock.results[0]!.value as FakeObservation
    span.end({ output: { category: 'reply' }, content: { reasoning: 'short greeting' } })

    // Content folds into the span-creation input...
    expect(lastRoot!.startObservation).toHaveBeenCalledWith('classify', {
      input: { length: 10, content: { fullBody: 'hi there' } },
    })
    // ...and into the end payload's output.
    expect(child.update).toHaveBeenCalledWith({
      output: { category: 'reply', content: { reasoning: 'short greeting' } },
    })
  })

  it('with capture-off, span.end drops content entirely (metadata-only parity)', async () => {
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', 'false')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'cc-6' })
    const span = trace.span('classify', { length: 10 }, { fullBody: 'hi there' })
    const child = lastRoot!.startObservation.mock.results[0]!.value as FakeObservation
    span.end({ output: { category: 'reply' }, content: { reasoning: 'short greeting' } })

    // toEqual, not toMatchObject: the subject IS which fields move, and a
    // partial match passes while content silently rides along.
    expect(lastRoot!.startObservation).toHaveBeenCalledWith('classify', {
      input: { length: 10 },
    })
    expect(child.update).toHaveBeenCalledWith({ output: { category: 'reply' } })
  })

  it('with capture-off, trace.update drops content from the SDK call', async () => {
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', 'false')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'cc-7' })
    trace.update({ output: { status: 'sent' }, content: { body: 'secret' } })
    expect(lastRoot!.update).toHaveBeenCalledWith({ output: { status: 'sent' } })
  })
})

describe('fetchTrace (THE-201)', () => {
  beforeEach(stubLiveEnv)

  it('calls the SDK read client and returns the result', async () => {
    const { fetchTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    // Deliberately NOT the value the assertion could produce by accident — a
    // mock resolving the same shape the caller defaults to cannot tell "the
    // read ran" from "the read was skipped".
    fetchTraceMock.mockResolvedValueOnce({ id: 'tr_1', name: 'agent.inbound' })
    const result = await fetchTrace('tr_1')
    expect(fetchTraceMock).toHaveBeenCalledWith('tr_1')
    expect(result).toEqual({ id: 'tr_1', name: 'agent.inbound' })
  })

  it('returns null on empty trace ID without calling the SDK', async () => {
    const { fetchTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    expect(await fetchTrace('')).toBeNull()
    expect(await fetchTrace('   ')).toBeNull()
    expect(fetchTraceMock).not.toHaveBeenCalled()
  })

  it('returns null when the SDK throws (404, network, etc.)', async () => {
    const { fetchTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    fetchTraceMock.mockRejectedValueOnce(new Error('not found'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await fetchTrace('tr_missing')
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns null when the wrapper is in no-op mode', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    const { fetchTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    expect(await fetchTrace('tr_1')).toBeNull()
    expect(clientCtor).not.toHaveBeenCalled()
  })

  it('reads without requiring the write path to be registered', async () => {
    // The read client is a separate cached singleton from the span processor.
    // If they were shared, the admin trace panel would go blank whenever
    // tracing was disabled — which is exactly when someone wants to look.
    const { fetchTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    fetchTraceMock.mockResolvedValueOnce({ id: 'tr_2' })
    await fetchTrace('tr_2')
    expect(clientCtor).toHaveBeenCalledOnce()
    expect(processorCtor).not.toHaveBeenCalled()
  })
})

describe('usage and model: native Langfuse fields, not output JSON', () => {
  // WHY THIS EXISTS. Measured 2026-09-29: Langfuse reported $0.0003 of cost
  // across 1,448 traces, because every model call was recorded as a plain span
  // with no model and no usage. Cost and token dashboards were empty. These
  // assertions are what keep them populated.
  beforeEach(stubLiveEnv)

  it('sends usage as usageDetails, NOT inside output', async () => {
    // The rename is the point: Langfuse aggregates `usageDetails` and ignores an
    // unknown `usage` key entirely, so a passthrough would look correct in the
    // wrapper and produce nothing on any dashboard.
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'u-1' })
    const gen = trace.generation('classify')
    const child = lastRoot!.startObservation.mock.results[0]!.value as FakeObservation
    gen.end({
      output: { category: 'reply' },
      model: 'claude-haiku-4-5-20251001',
      usage: { input: 194, output: 13, total: 207 },
    })
    expect(child.update).toHaveBeenCalledWith({
      output: { category: 'reply' },
      model: 'claude-haiku-4-5-20251001',
      usageDetails: { input: 194, output: 13, total: 207 },
    })
    // toEqual above, not toMatchObject: the subject IS which key the numbers
    // land under, so a partial match that tolerated a stray `usage` key would
    // defeat the test.
  })

  it('creates the observation as a generation, so Langfuse will price it', async () => {
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'u-2' })
    trace.generation('classify', { inboundLength: 12 })
    expect(lastRoot!.startObservation).toHaveBeenCalledWith(
      'classify',
      { input: { inboundLength: 12 } },
      { asType: 'generation' },
    )
  })

  it('omits usageDetails entirely when usage is empty', async () => {
    // A present-but-empty usageDetails makes Langfuse treat the call as priced
    // at zero tokens, which charts as a real $0 point and is indistinguishable
    // from a genuinely free call. Absent must stay absent.
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'u-3' })
    const gen = trace.generation('classify')
    const child = lastRoot!.startObservation.mock.results[0]!.value as FakeObservation
    gen.end({ output: { ok: true }, usage: {} })
    expect(child.update).toHaveBeenCalledWith({ output: { ok: true } })
  })

  it('sends usage even when content capture is OFF', async () => {
    // Token counts are metadata, not content — they carry no guest text. If the
    // content gate blinded them, turning capture off for a venue would silently
    // zero that venue's cost reporting.
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', 'false')
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'u-4' })
    const gen = trace.generation('classify')
    const child = lastRoot!.startObservation.mock.results[0]!.value as FakeObservation
    gen.end({
      output: { ok: true },
      content: { secret: 'guest text' },
      model: 'm-1',
      usage: { input: 10 },
    })
    expect(child.update).toHaveBeenCalledWith({
      output: { ok: true },
      model: 'm-1',
      usageDetails: { input: 10 },
    })
  })
})

describe('toAgentUsage', () => {
  // A REALISTIC Anthropic reading, and the arithmetic is the point: the SDK's
  // inputTokens is noCache + cacheRead + cacheWrite, so 10_240 = 1_200 + 8_900 + 140.
  // The previous fixture here read `inputTokens: 194` alongside
  // `cachedInputTokens: 9000` - impossible, and the impossibility is exactly why
  // it could not catch the double-billing bug it was written over.
  const SDK_USAGE = {
    inputTokens: 10_240,
    outputTokens: 310,
    totalTokens: 10_550,
    cachedInputTokens: 8_900,
    inputTokenDetails: { noCacheTokens: 1_200, cacheWriteTokens: 140 },
  }

  it('reports UNCACHED input, so the three input buckets reconcile to the SDK total', async () => {
    // THE BUG THIS EXISTS FOR. Langfuse's input buckets are disjoint and it SUMS
    // them for cost (verified live 2026-09-29). Mapping the SDK's `inputTokens`
    // straight to `input` bills the 8_900 cached tokens twice, at two different
    // rates, and produces a plausible cost that is simply too high - nothing
    // errors and no chart looks broken.
    //
    // Asserted as a reconciliation rather than as five literals, because a
    // literal restates the mapping and cannot disagree with it. This can.
    const { toAgentUsage } = await import('./langfuse')
    const usage = toAgentUsage(SDK_USAGE)

    expect(usage.input).toBe(1_200)
    expect(
      (usage.input ?? 0) + (usage.input_cached_tokens ?? 0) + (usage.input_cache_creation ?? 0),
    ).toBe(SDK_USAGE.inputTokens)
    expect((usage.input ?? 0) + (usage.input_cached_tokens ?? 0)).not.toBe(SDK_USAGE.inputTokens)
  })

  it('maps every bucket to the key the AI SDK telemetry itself emits', async () => {
    const { toAgentUsage } = await import('./langfuse')
    expect(toAgentUsage(SDK_USAGE)).toEqual({
      input: 1_200,
      output: 310,
      total: 10_550,
      input_cached_tokens: 8_900,
      input_cache_creation: 140,
    })
  })

  it('derives uncached input by subtraction when the provider reports no breakdown', async () => {
    // A non-Anthropic provider, or an older one, sends no inputTokenDetails.
    // Subtraction is the fallback and must reconcile identically.
    const { toAgentUsage } = await import('./langfuse')
    expect(
      toAgentUsage({
        inputTokens: 10_240,
        outputTokens: 310,
        cachedInputTokens: 8_900,
        cacheCreationInputTokens: 140,
      }),
    ).toEqual({
      input: 1_200,
      output: 310,
      input_cached_tokens: 8_900,
      input_cache_creation: 140,
    })
  })

  it('prefers the SDK breakdown over the Anthropic providerMetadata fallback', async () => {
    // Both carry cache-creation. They must not be added together, and the
    // provider-independent one wins. Distinct values so a sum or the wrong pick
    // is visible rather than coincidentally equal.
    const { toAgentUsage } = await import('./langfuse')
    const usage = toAgentUsage({
      inputTokens: 1_000,
      cachedInputTokens: 500,
      cacheCreationInputTokens: 99,
      inputTokenDetails: { cacheWriteTokens: 300 },
    })
    expect(usage.input_cache_creation).toBe(300)
    expect(usage.input).toBe(200)
  })

  it('clamps rather than emitting a negative token count', async () => {
    // A provider disagreeing with itself must not produce a negative figure that
    // Langfuse would then price. Under-reporting input is recoverable; a
    // negative cost line is not, and it would be charted.
    const { toAgentUsage } = await import('./langfuse')
    expect(toAgentUsage({ inputTokens: 100, cachedInputTokens: 900 }).input).toBeUndefined()
  })

  it('omits absent and zero values rather than writing 0', async () => {
    // "This provider does not report cache tokens" and "the cache was not read"
    // are different facts. Writing 0 for the first makes a provider that cannot
    // report caching look like a 0% hit rate.
    const { toAgentUsage } = await import('./langfuse')
    expect(toAgentUsage({ inputTokens: 5 })).toEqual({ input: 5 })
    expect(toAgentUsage({ inputTokens: 5, cachedInputTokens: 0 })).toEqual({ input: 5 })
    expect(toAgentUsage({})).toEqual({})
    expect(toAgentUsage({ inputTokens: null, outputTokens: undefined })).toEqual({})
  })
})

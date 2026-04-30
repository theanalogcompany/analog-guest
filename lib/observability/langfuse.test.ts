import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted Langfuse mock. Each test spy is reset via vi.resetAllMocks in
// afterEach. The constructor mock lets us assert the exact shape of the
// init params the wrapper passes through.
const langfuseCtor = vi.fn()

vi.mock('langfuse', () => ({
  Langfuse: class MockLangfuse {
    trace: ReturnType<typeof vi.fn>
    flushAsync: ReturnType<typeof vi.fn>
    constructor(opts: unknown) {
      langfuseCtor(opts)
      const fake = makeFakeClient()
      this.trace = fake.trace
      this.flushAsync = fake.flushAsync
    }
  },
}))

interface FakeSpan {
  id: string
  span: ReturnType<typeof vi.fn>
  generation: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

interface FakeClient {
  trace: ReturnType<typeof vi.fn>
  flushAsync: ReturnType<typeof vi.fn>
}

let lastClient: FakeClient | null = null
let lastTrace: { id: string; spans: FakeSpan[] } | null = null

function makeFakeSpan(id: string): FakeSpan {
  const span: FakeSpan = {
    id,
    span: vi.fn(() => makeFakeSpan(`${id}.s`)),
    generation: vi.fn(() => makeFakeSpan(`${id}.g`)),
    update: vi.fn(),
    end: vi.fn(),
  }
  return span
}

function makeFakeClient(): FakeClient {
  const trace = vi.fn((body) => {
    const id = `trace-id-${body?.name ?? 'unnamed'}`
    const spans: FakeSpan[] = []
    const t = {
      id,
      span: vi.fn((spanBody) => {
        const s = makeFakeSpan(`${id}.${spanBody.name}`)
        spans.push(s)
        return s
      }),
      update: vi.fn(),
    }
    lastTrace = { id, spans }
    return t
  })
  const client = {
    trace,
    flushAsync: vi.fn().mockResolvedValue(undefined),
  }
  lastClient = client
  return client
}

beforeEach(() => {
  // Each test starts from a clean env + fresh module state. Reset the cached
  // singleton so config changes take effect.
  langfuseCtor.mockReset()
  lastClient = null
  lastTrace = null
})

afterEach(() => {
  vi.unstubAllEnvs()
})

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
    expect(langfuseCtor).not.toHaveBeenCalled()

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
    expect(langfuseCtor).not.toHaveBeenCalled()
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
    expect(langfuseCtor).not.toHaveBeenCalled()
  })
})

describe('startAgentTrace — live mode', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-test')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-test')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://us.cloud.langfuse.com')
    vi.stubEnv('LANGFUSE_ENABLED', '')
  })

  it('initialises Langfuse with config and returns a real trace id', async () => {
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({
      name: 'agent.inbound',
      agentRunId: 'run-A',
      metadata: { venueId: 'v1' },
    })
    expect(langfuseCtor).toHaveBeenCalledOnce()
    expect(langfuseCtor).toHaveBeenCalledWith({
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'https://us.cloud.langfuse.com',
    })
    expect(trace.id).toBe('trace-id-agent.inbound')
    expect(lastClient!.trace).toHaveBeenCalledWith({
      name: 'agent.inbound',
      sessionId: 'run-A',
      metadata: { agentRunId: 'run-A', venueId: 'v1' },
    })
  })

  it('span / span / generation tree forwards through the SDK', async () => {
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.followup', agentRunId: 'run-B' })
    const generate = trace.span('generate', { foo: 'bar' })
    const attempt = generate.span('generate.attempt_1', { i: 1 })
    const llm = attempt.generation('llm.call', { prompt: 'hi' })
    expect(generate.id).toBe('trace-id-agent.followup.generate')
    expect(attempt.id).toBe('trace-id-agent.followup.generate.s')
    expect(llm.id).toBe('trace-id-agent.followup.generate.s.g')

    generate.update({ metadata: { strongCount: 3 } })
    attempt.end({ output: { score: 0.5 } })
    llm.end({ output: { tokens: 42 } })

    expect(lastTrace!.spans[0].update).toHaveBeenCalledWith({ metadata: { strongCount: 3 } })
    expect(lastTrace!.spans[0].span).toHaveBeenCalledWith({
      name: 'generate.attempt_1',
      input: { i: 1 },
    })
  })

  it('flushAsync delegates to the SDK client', async () => {
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-C' })
    await trace.flushAsync()
    expect(lastClient!.flushAsync).toHaveBeenCalledOnce()
  })

  it('swallows SDK errors and returns no-op spans', async () => {
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    const trace = startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-D' })
    // Force the next span call to throw — wrapper should swallow + return NOOP_SPAN.
    expect(lastTrace).not.toBeNull()
    const sdkTraceMock = lastClient!.trace.mock.results[0]?.value
    sdkTraceMock.span.mockImplementationOnce(() => {
      throw new Error('network down')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const span = trace.span('classify')
    expect(span.id).toBe('')
    span.end({ output: 'ok' })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('caches the client across calls (single Langfuse construction)', async () => {
    const { startAgentTrace, _resetLangfuseClientForTest } = await import('./langfuse')
    _resetLangfuseClientForTest()
    startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-E1' })
    startAgentTrace({ name: 'agent.inbound', agentRunId: 'run-E2' })
    startAgentTrace({ name: 'agent.followup', agentRunId: 'run-E3' })
    expect(langfuseCtor).toHaveBeenCalledOnce()
  })
})

/**
 * mock-providers.ts - answer every model provider from canned payloads so a
 * flow can be tested without spending a cent.
 *
 * WHY THIS EXISTS. Wiring work - does the route dispatch, does the shape come
 * back, does the write land, does the component render - needs no model at
 * all, but every path here reaches one, so the obvious way to test it is to
 * run it for real. That is how a dozen verification runs became a real
 * Anthropic bill for questions a canned string would have answered. The
 * generated TEXT is the only thing a live model is needed for, and wiring is
 * never about the text.
 *
 * THE GUARANTEE IS THE THROW, not the stubs. `installProviderMocks` replaces
 * `global.fetch` and refuses any request to a host it does not recognize as a
 * provider it can answer - so a path that reaches a NEW provider fails loudly
 * instead of quietly billing. A mock that silently passes unknown hosts
 * through would be worse than none: it would read as "free" right up until
 * the invoice. Non-provider hosts (Supabase) pass through untouched, because
 * the database is not what costs money and the flow being tested is mostly
 * database work.
 *
 * WHAT IT DOES NOT DO: tell you anything about reply quality. A canned reply
 * proves the wiring carried it, nothing more. Quality questions need the real
 * models and should be run deliberately, once, not as a side effect of
 * checking that a column renders.
 *
 *   import { installProviderMocks } from './lib/mock-providers'
 *   installProviderMocks({ generationText: 'canned reply' })
 */

/** Hosts this module can answer. Anything else provider-shaped must throw. */
const ANTHROPIC_HOST = 'api.anthropic.com'
const VOYAGE_HOST = 'api.voyageai.com'
const KIMI_HOSTS = ['api.moonshot.ai', 'api.moonshot.cn']
const JEV_HOST = 'api.typesafe.ai'

/**
 * Hosts that cost money and that we must therefore never let through. Kept as
 * a separate list from the answerable ones ON PURPOSE: a provider added to
 * the codebase and not to this file lands here as "billable, unstubbed" and
 * the mock throws, which is the loud failure. If the two lists were one, a
 * new provider would just fall through to the pass-through branch.
 */
const BILLABLE_HOST_MARKERS = [
  'anthropic',
  'voyage',
  'moonshot',
  'typesafe',
  'openai',
  'googleapis',
  'cohere',
  'mistral',
]

export interface ProviderMockOptions {
  /** What the generation model "writes". */
  generationText?: string
  /** The classifier's category. */
  category?: string
  /** Embedding dimensionality; voyage-3-large is 1024. */
  embeddingDimensions?: number
}

export interface ProviderMockHandle {
  /** Calls intercepted, by provider, so a test can assert what ran. */
  readonly calls: Record<string, number>
  /** Restore the real fetch. */
  restore: () => void
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A minimal valid instance of a JSON Schema.
 *
 * DERIVED FROM THE REQUEST rather than hand-written per call site, and that is
 * what keeps this file from going stale. The alternative - a canned object per
 * schema - has to be updated every time someone adds a field, and until it is,
 * the mock fails with "response did not match schema", which reads like a bug
 * in the code under test. Walking the schema means a new field is satisfied
 * the moment it appears.
 *
 * `overrides` wins over the generated value, so a caller can pin the one or
 * two fields a test actually asserts on (the reply text, the category) and
 * let the rest be filler.
 */
function instanceFromSchema(
  schema: Record<string, unknown>,
  overrides: Record<string, unknown>,
): unknown {
  const type = schema.type as string | undefined
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return schema.enum[0]

  if (type === 'object' || schema.properties !== undefined) {
    const props = (schema.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >
    // `required` only: filling optional fields too would make every mocked
    // reply carry an intention question, a review ask and a commitment, which
    // is the opposite of a neutral default.
    const required = (schema.required as string[] | undefined) ?? []
    const out: Record<string, unknown> = {}
    for (const key of required) {
      if (key in overrides) out[key] = overrides[key]
      else if (props[key]) out[key] = instanceFromSchema(props[key], overrides)
    }
    // An override naming a field the schema does not require is still applied
    // - the generation schema makes `body` required but a future one might
    // not, and silently dropping the text would leave an empty bubble.
    for (const [k, v] of Object.entries(overrides)) {
      if (k in props) out[k] = v
    }
    return out
  }
  if (type === 'array') return []
  if (type === 'number' || type === 'integer') return 0
  if (type === 'boolean') return false
  if (type === 'null') return null
  return 'mock'
}

/**
 * The output schema the SDK asked for.
 *
 * Path verified by probe, not assumed: `output_config.format.schema`, where
 * `format.type` is `json_schema`. It is NOT `output_config.schema` - that was
 * the first guess and it made every mocked call throw.
 */
function schemaFromRequest(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as {
      output_config?: { format?: { schema?: Record<string, unknown> } }
    }
    return parsed.output_config?.format?.schema ?? null
  } catch {
    return null
  }
}

/**
 * An Anthropic /v1/messages response carrying the object as a TEXT block.
 *
 * Verified against what the SDK actually sends rather than assumed: this
 * version of the AI SDK asks for structured output via `output_config` and
 * sends NO `tools`, so the object comes back as JSON in a plain text block.
 * The first version returned a `tool_use` block and produced "No object
 * generated", which reads like a schema failure and was entirely a mock
 * failure.
 *
 * If an SDK upgrade switches back to tool mode this breaks the same way -
 * re-probe rather than guess. A probe costs nothing: intercept fetch, print
 * the body keys, exit before sending.
 */
function anthropicObject(input: unknown): Response {
  return json({
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: 'mock',
    content: [{ type: 'text', text: JSON.stringify(input) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

export function installProviderMocks(
  options: ProviderMockOptions = {},
): ProviderMockHandle {
  const generationText = options.generationText ?? 'mock reply from the venue'
  const category = options.category ?? 'new_question'
  const dims = options.embeddingDimensions ?? 1024

  const calls: Record<string, number> = {}
  const bump = (k: string): void => {
    calls[k] = (calls[k] ?? 0) + 1
  }

  const realFetch = global.fetch

  global.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const host = (() => {
      try {
        return new URL(url).hostname
      } catch {
        return ''
      }
    })()

    if (host === ANTHROPIC_HOST) {
      // Classification and generation share a host and a shape, so they are
      // told apart by the body: the classifier's schema asks for `category`.
      const body = typeof init?.body === 'string' ? init.body : ''
      const schema = schemaFromRequest(body)
      if (schema === null)
        throw new Error(
          'mock-providers: Anthropic request carried no output_config.schema. ' +
            'The SDK changed how it asks for structured output - re-probe the request shape.',
        )
      // Told apart by the schema, not by the prompt text: the classifier's
      // schema has a `category` property and generation's does not.
      const props = (schema.properties ?? {}) as Record<string, unknown>
      const isClassify = 'category' in props
      bump(isClassify ? 'anthropic.classify' : 'anthropic.generate')
      return anthropicObject(
        instanceFromSchema(
          schema,
          isClassify ? { category } : { body: generationText },
        ),
      )
    }

    if (host === VOYAGE_HOST) {
      bump('voyage.embed')
      return json({
        object: 'list',
        data: [
          { object: 'embedding', index: 0, embedding: new Array(dims).fill(0) },
        ],
        model: 'mock',
        usage: { total_tokens: 1 },
      })
    }

    if (KIMI_HOSTS.includes(host)) {
      bump('kimi.judge')
      return json({
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      })
    }

    if (host === JEV_HOST) {
      bump('jev.semantic')
      return json({ results: [] })
    }

    // THE GUARANTEE. A billable host nobody taught this file about must not
    // reach the network just because it is unrecognized.
    if (BILLABLE_HOST_MARKERS.some((m) => host.includes(m))) {
      throw new Error(
        `mock-providers: refusing a live call to ${host}. It looks billable and this file has no canned response for it. ` +
          `Add one before running this flow, or the "free" test is not free.`,
      )
    }

    bump(`passthrough:${host}`)
    return realFetch(input, init)
  }) as typeof global.fetch

  return {
    calls,
    restore: () => {
      global.fetch = realFetch
    },
  }
}

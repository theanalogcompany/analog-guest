import { z } from 'zod'
import type { AIResult } from './types'
import { checkKimiEnv, DEFAULT_KIMI_BASE_URL } from './kimi-env'

// Structured-output calls against Kimi (Moonshot), over plain fetch.
//
// WHY NOT AN AI SDK PROVIDER: @ai-sdk/openai-compatible is published against
// provider spec v4 on every version in its 3.x line, while `ai@6` and
// @ai-sdk/anthropic are on spec v3 - the model object does not typecheck, and
// the only way through is a major `ai` upgrade across every call site in the
// repo. Jev is already integrated this way (lib/policy/semantic-check.ts,
// lib/ai/classify-message-jev.ts), so plain fetch is the house pattern for a
// non-Anthropic model rather than a shortcut. Follows those modules in every
// mechanical particular: env check first, AbortSignal.timeout, distinct error
// codes, deps injection, never throws.
//
// The request schema is DERIVED from the Zod schema via z.toJSONSchema, so the
// shape asked for and the shape validated cannot drift. A hand-written
// json_schema beside a Zod parser is two sources of truth, and the one that
// silently wins is whichever the model happens to satisfy.

export const KIMI_TIMEOUT_MS = 120_000

// MEASURED against this account, not read off a doc: published tier tables
// contradict each other, tier depends on cumulative top-up, and no
// X-RateLimit-* headers come back on chat/completions, so there is nothing to
// read dynamically. Re-measure after any top-up - that is a one-command ramp
// of concurrent requests at max_tokens=1.
//
// 2026-10-06, pre-top-up: burst of 2 -> 200,429; burst of 3 -> 429,200,429;
// sequential singles -> 200,200,200,429,429. Tier 0: concurrency 1, 3 RPM.
// 2026-10-06, after a $20 top-up: 8/8, 16/16 and 32/32 all clean, then 40 of
// 48 at n=48. Exactly 8 rejected = 48-40, so the binding limit is CONCURRENCY
// 40 and not RPM (an RPM-100 ceiling would have rejected 4 of the 104 sent).
// That is the published Tier 2 row, whose RPM is 100 - inferred from the tier
// match rather than measured directly, which is why RPM is the softer of the
// two numbers here.
const MEASURED_MAX_CONCURRENCY = 40
const MEASURED_RPM = 100

/** 80% of the measured ceiling, floored at 1 - the harness's own convention. */
export const KIMI_MAX_CONCURRENCY = Math.max(
  1,
  Math.floor(
    Number(process.env.KIMI_MAX_CONCURRENCY ?? MEASURED_MAX_CONCURRENCY) * 0.8,
  ),
)

/** Spacing to stay under 80% of RPM, applied across all callers. */
export const KIMI_MIN_INTERVAL_MS = Math.ceil(
  60_000 / (Number(process.env.KIMI_RPM ?? MEASURED_RPM) * 0.8),
)

export const KIMI_MAX_ATTEMPTS = 5

// Process-wide gate. The limit is an ACCOUNT limit, shared across every key
// and model, so it belongs here rather than in each caller - and the harness
// runs samples at its own concurrency (64) with no idea Kimi exists.
let inFlight = 0
let nextSlotAt = 0
const waiting: Array<() => void> = []

async function acquire(): Promise<void> {
  if (inFlight >= KIMI_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  inFlight += 1
  const now = Date.now()
  const wait = Math.max(0, nextSlotAt - now)
  nextSlotAt = Math.max(now, nextSlotAt) + KIMI_MIN_INTERVAL_MS
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

function release(): void {
  inFlight -= 1
  waiting.shift()?.()
}

/** Exponential backoff with jitter, which is what Moonshot's 429 guidance asks for. */
function backoffMs(attempt: number): number {
  return Math.min(30_000, 2 ** attempt * 1_000) * (0.5 + Math.random())
}

type EnvLike = Record<string, string | undefined>

export interface KimiDeps {
  env?: EnvLike
  fetchImpl?: typeof fetch
}

export interface KimiObjectRequest<T> {
  model: string
  system: string
  user: string
  schema: z.ZodType<T>
  schemaName: string
  maxOutputTokens: number
  temperature?: number
}

/** `finish_reason` is read, not ignored: see KIMI_TRUNCATED_ERROR_CODE. */
const ResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
})

/**
 * Truncation is a DISTINCT failure from a malformed object, because the fix is
 * a token budget and not a prompt (lib/ai/CLAUDE.md). Detected off the
 * provider's own `finish_reason`, never by pattern-matching the error text -
 * the same rule the Anthropic path follows via NoObjectGeneratedError.
 * Load-bearing here: the judge declares explanation and evidence BEFORE each
 * score, so a truncated judgment loses the scores and keeps the prose, and
 * without this it would surface as unparseable JSON of unknown cause.
 */
export const KIMI_TRUNCATED_ERROR_CODE = 'kimi_truncated'

/**
 * One chat completion constrained to `schema`, parsed and validated.
 *
 * Failure direction is the CALLER's business - this returns `{ok: false}` for
 * every failure mode with a distinct errorCode and never throws. The judge's
 * callers already treat a failed judgment as a null slot rather than a hold,
 * because the judge observes and never gates a send.
 */
export async function generateKimiObject<T>(
  req: KimiObjectRequest<T>,
  deps: KimiDeps = {},
): Promise<AIResult<T>> {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch

  const envCheck = checkKimiEnv(env)
  if (!envCheck.ok)
    return {
      ok: false,
      error: envCheck.problems.join('; '),
      errorCode: 'kimi_env_missing',
    }

  // Zod stamps `$schema`, which the OpenAI-compatible strict validator
  // rejects as an unknown key at the root.
  const jsonSchema = {
    ...z.toJSONSchema(req.schema, { io: 'output' }),
  } as Record<string, unknown>
  delete jsonSchema.$schema

  const base = env.KIMI_BASE_URL?.trim() || DEFAULT_KIMI_BASE_URL
  const body = JSON.stringify({
    model: req.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    max_tokens: req.maxOutputTokens,
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    response_format: {
      type: 'json_schema',
      json_schema: { name: req.schemaName, strict: true, schema: jsonSchema },
    },
  })

  // RETRY is load-bearing here, not belt-and-braces. The regression harness
  // treats a failed judgment as a voided cell that prints but does NOT
  // disqualify the sample, so an unretried 429 silently shrinks n on the axis
  // means rather than failing loudly - a quiet loss of evidence, which is the
  // failure mode this repo keeps paying for. Only 429 and 5xx retry: a 400
  // (bad schema, bad temperature) is deterministic and retrying it just burns
  // the rate limit.
  let response: Response | null = null
  let lastError = ''
  let lastCode = 'kimi_network'
  for (let attempt = 0; attempt < KIMI_MAX_ATTEMPTS; attempt += 1) {
    await acquire()
    try {
      response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.KIMI_API_KEY!.trim()}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(KIMI_TIMEOUT_MS),
        body,
      })
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      lastError = `kimi fetch failed: ${e instanceof Error ? e.message : String(e)}`
      lastCode =
        name === 'TimeoutError' || name === 'AbortError'
          ? 'kimi_timeout'
          : 'kimi_network'
      response = null
    } finally {
      release()
    }

    if (response !== null && response.ok) break

    if (response !== null) {
      const retryable = response.status === 429 || response.status >= 500
      const detail = await response.text().catch(() => '')
      lastError = `kimi http ${response.status}: ${detail.slice(0, 300)}`
      lastCode = `kimi_http_${response.status}`
      if (!retryable)
        return { ok: false, error: lastError, errorCode: lastCode }
      response = null
    }

    if (attempt < KIMI_MAX_ATTEMPTS - 1)
      await new Promise((r) => setTimeout(r, backoffMs(attempt)))
  }

  if (response === null)
    return {
      ok: false,
      error: `${lastError} (after ${KIMI_MAX_ATTEMPTS} attempts)`,
      errorCode: lastCode,
    }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (e) {
    return {
      ok: false,
      error: `kimi body unreadable: ${e instanceof Error ? e.message : String(e)}`,
      errorCode: 'kimi_bad_response',
    }
  }

  const envelope = ResponseSchema.safeParse(payload)
  if (!envelope.success)
    return {
      ok: false,
      error: `kimi response shape: ${envelope.error.message}`,
      errorCode: 'kimi_bad_response',
    }

  const choice = envelope.data.choices[0]
  if (choice.finish_reason === 'length')
    return {
      ok: false,
      error: `kimi output truncated at ${req.maxOutputTokens} tokens`,
      errorCode: KIMI_TRUNCATED_ERROR_CODE,
    }

  const content = choice.message.content
  if (content === null || content.trim() === '')
    return {
      ok: false,
      error: 'kimi returned empty content',
      errorCode: 'kimi_empty',
    }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (e) {
    // A truncated object is the common cause and is a DISTINCT failure from a
    // malformed one - the fix is a token budget, not a prompt (the
    // *_TRUNCATED_ERROR_CODE lesson in lib/ai/CLAUDE.md).
    return {
      ok: false,
      error: `kimi content not JSON: ${e instanceof Error ? e.message : String(e)}`,
      errorCode: 'kimi_unparseable',
    }
  }

  const validated = req.schema.safeParse(parsed)
  if (!validated.success)
    return {
      ok: false,
      error: `kimi object shape: ${validated.error.message}`,
      errorCode: 'kimi_bad_object',
    }

  return { ok: true, data: validated.data }
}

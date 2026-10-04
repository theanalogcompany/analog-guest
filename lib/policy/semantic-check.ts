import { z } from 'zod'
import {
  JEV_MODEL,
  TYPESAFE_SYSTEMONE_URL,
} from '@/lib/ai/classify-message-jev'
import { checkTypesafeEnv } from '@/lib/ai/typesafe-env'
import { semanticPolicies, type PolicySet } from './schema'

// The semantic lane of the policy gate: one Jev systemOne request, one Noul
// per semantic policy row, questions evaluated in parallel so latency is
// flat in policy count. Follows classify-message-jev.ts in every mechanical
// particular (env check first-call, AbortSignal.timeout, distinct error
// codes, deps injection, never throws); read that module's header for the
// Jev background.
//
// THIS MODULE RETURNS PROBABILITIES, NOT VERDICTS. Thresholding and the
// failure direction are the gate's job (gate.ts), because both are policy
// data, and because the raw nouls must reach the trace and eval_judgments
// unthresholded - threshold tuning later has to be a query over recorded
// numbers, not re-inference.
//
// Provider stays behind this interface per the swappable-vendor rule; no
// caller may import the TypeSafe URL or request shape.

export const SEMANTIC_CHECK_VERSION = 'policy-jev-v1.0.0'

/** Same budget reasoning as JEV_TIMEOUT_MS: ~10x Jev's measured median. */
export const SEMANTIC_CHECK_TIMEOUT_MS = 1_500

/**
 * Named state fields, per TypeSafe guidance; policy instructions reference
 * them by backticked path. `declared_actions` is serialized JSON of the
 * generation's actions so the discrepancy questions have the exonerating
 * context in view.
 */
export interface SemanticCheckState {
  draft_messages: string[]
  declared_actions: string
  /** Links the composer actually supplied this turn; unverified_link judges against it. */
  provided_links: string[]
  recent_conversation?: string
}

export type SemanticCheckOutcome =
  | {
      ok: true
      /** P(yes) per semantic policy key, unthresholded. */
      probabilities: Record<string, number>
      version: string
    }
  | { ok: false; error: string; errorCode: string }

const NoulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number() })
const ResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), NoulAnswerSchema),
})

type FetchLike = typeof fetch

export interface SemanticCheckDeps {
  env?: Record<string, string | undefined>
  fetchImpl?: FetchLike
}

/**
 * Ask every semantic policy's Noul in one request. A policy set with no
 * semantic rows short-circuits to `{ok: true, probabilities: {}}` - no
 * request, no latency.
 */
export async function runSemanticCheck(
  state: SemanticCheckState,
  policySet: PolicySet,
  deps: SemanticCheckDeps = {},
): Promise<SemanticCheckOutcome> {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch

  const rows = semanticPolicies(policySet)
  if (rows.length === 0)
    return { ok: true, probabilities: {}, version: SEMANTIC_CHECK_VERSION }

  const envCheck = checkTypesafeEnv(env)
  if (!envCheck.ok)
    return {
      ok: false,
      error: envCheck.problems.join('; '),
      errorCode: 'jev_env_missing',
    }

  const questions: Record<
    string,
    {
      type: 'noul'
      instructions: string
      criteria?: { true: string; false: string }
    }
  > = {}
  for (const row of rows) {
    questions[row.key] = {
      type: 'noul',
      instructions: row.detection.instructions,
      ...(row.detection.criteria ? { criteria: row.detection.criteria } : {}),
    }
  }

  let response: Response
  try {
    response = await fetchImpl(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.JEV_API_KEY!.trim()}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(SEMANTIC_CHECK_TIMEOUT_MS),
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    })
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    return {
      ok: false,
      error: `jev fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      errorCode:
        name === 'TimeoutError' || name === 'AbortError'
          ? 'jev_timeout'
          : 'jev_network',
    }
  }

  if (!response.ok)
    return {
      ok: false,
      error: `jev http ${response.status}`,
      errorCode: `jev_http_${response.status}`,
    }

  let body: unknown
  try {
    body = await response.json()
  } catch (e) {
    return {
      ok: false,
      error: `jev body unreadable: ${e instanceof Error ? e.message : String(e)}`,
      errorCode: 'jev_bad_response',
    }
  }

  const parsed = ResponseSchema.safeParse(body)
  if (!parsed.success)
    return {
      ok: false,
      error: `jev response shape: ${parsed.error.message}`,
      errorCode: 'jev_bad_response',
    }

  // Every asked question must be answered; a partial answer set is a contract
  // violation and the gate must treat the whole check as unavailable rather
  // than silently passing the missing policies.
  const probabilities: Record<string, number> = {}
  for (const row of rows) {
    const answer = parsed.data.answers[row.key]
    if (answer === undefined)
      return {
        ok: false,
        error: `jev answer missing for policy "${row.key}"`,
        errorCode: 'jev_bad_response',
      }
    probabilities[row.key] = answer.noul
  }

  return { ok: true, probabilities, version: SEMANTIC_CHECK_VERSION }
}

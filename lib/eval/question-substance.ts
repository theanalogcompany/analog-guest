import { z } from 'zod'
import {
  JEV_MODEL,
  TYPESAFE_SYSTEMONE_URL,
} from '@/lib/ai/classify-message-jev'
import { checkTypesafeEnv } from '@/lib/ai/typesafe-env'

// Is a question in a drafted reply SUBSTANTIVE, or a social check-in?
//
// Owner-ruled 2026-10-06 on the order-after-name breach: "Alex, nice to meet
// you. how was this morning? what did you get?" is technically two questions
// and meaningfully one, and the two-questions ceiling should count the
// meaningful ones. String matching cannot draw that line - the ruling is
// semantic. A pattern list was drafted and rejected: every form that excused
// "how was this morning?" also excused "how was the croissant?", which is a
// real question about an order, and none of them caught "you settling in
// okay?" at all. So the split is deterministic extraction, semantic
// classification.
//
// The division of labour matters for the harness's Layer A contract, which
// says a ceiling hit fails the scenario whatever the rate. Finding the
// question clauses stays exact code (splitting on "?" is not the part that
// needs judgment); only the substantive-vs-phatic call is a probability, and
// its threshold is a named constant rather than a regex nobody can argue
// with.
//
// Follows lib/policy/semantic-check.ts in every mechanical particular - env
// check first, AbortSignal.timeout, distinct error codes, deps injection,
// never throws - and keeps the provider behind this interface per the
// swappable-vendor rule.
//
// FAILURE DIRECTION: neither open nor closed - UNAVAILABLE. The caller
// disqualifies the sample, because the harness's own rule is that a failure
// is never a zero. Counting zero substantive questions on an outage would
// pass a stacked reply vacuously; counting them all would invent a breach.

export const QUESTION_SUBSTANCE_VERSION = 'question-substance-jev-v1.0.0'

/** Same budget reasoning as SEMANTIC_CHECK_TIMEOUT_MS: ~10x Jev's median. */
export const QUESTION_SUBSTANCE_TIMEOUT_MS = 1_500

/**
 * PLACEHOLDER, not a calibration - there is no run to derive it from yet, and
 * a bare number here would otherwise read as measured (the
 * KNOWLEDGE_RELEVANCE_FLOOR lesson). Tune it off recorded probabilities on the
 * first n=6 run that stores them, never by re-inference.
 */
export const SUBSTANTIVE_QUESTION_THRESHOLD = 0.5

/** Guard against a pathological reply turning into a giant request. */
const MAX_CANDIDATES = 12

const INSTRUCTIONS =
  'Is this question substantive - does it ask the guest for information the venue does not already have, or for a decision from them?'

const CRITERIA = {
  true: 'The question seeks real information or a choice: what they ordered, their name, when they are coming, which of two things they want. The guest has to think before answering, and the answer tells the venue something it did not know.',
  false:
    'A social check-in or pleasantry that invites acknowledgement rather than information - "how is it going?", "how was this morning?", "you settling in okay?". The guest could answer "good" and nothing would be lost.',
} as const

export type QuestionSubstanceOutcome =
  | {
      ok: true
      /** P(substantive) per candidate, same order as the input. Unthresholded. */
      probabilities: number[]
      version: string
    }
  | { ok: false; error: string; errorCode: string }

const NoulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number() })
const ResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), NoulAnswerSchema),
})

export interface QuestionSubstanceDeps {
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
}

/**
 * One request, one Noul per candidate question. Questions evaluate in
 * parallel, so latency is flat in question count.
 *
 * `reply` is passed as state so each judgment sees the bubble its question
 * came from: "how was this morning?" reads differently after "was in this
 * morning actually" than it would standing alone.
 */
export async function scoreQuestionSubstance(
  candidates: string[],
  reply: string[],
  deps: QuestionSubstanceDeps = {},
): Promise<QuestionSubstanceOutcome> {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch

  const asked = candidates.slice(0, MAX_CANDIDATES)
  if (asked.length === 0)
    return { ok: true, probabilities: [], version: QUESTION_SUBSTANCE_VERSION }

  const envCheck = checkTypesafeEnv(env)
  if (!envCheck.ok)
    return {
      ok: false,
      error: envCheck.problems.join('; '),
      errorCode: 'jev_env_missing',
    }

  const state = { reply_bubbles: reply, candidate_questions: asked }
  const questions: Record<
    string,
    {
      type: 'noul'
      instructions: string
      criteria: { true: string; false: string }
    }
  > = {}
  asked.forEach((_, i) => {
    questions[`q${i}`] = {
      type: 'noul',
      instructions: `${INSTRUCTIONS} The question is \`candidate_questions[${i}]\`, asked inside \`reply_bubbles\`.`,
      criteria: CRITERIA,
    }
  })

  let response: Response
  try {
    response = await fetchImpl(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.JEV_API_KEY!.trim()}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(QUESTION_SUBSTANCE_TIMEOUT_MS),
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

  // A partial answer set is a contract violation, not a pass: the caller must
  // see the whole check as unavailable rather than silently scoring the
  // missing clauses as phatic.
  const probabilities: number[] = []
  for (let i = 0; i < asked.length; i += 1) {
    const answer = parsed.data.answers[`q${i}`]
    if (answer === undefined)
      return {
        ok: false,
        error: `jev answer missing for candidate q${i}`,
        errorCode: 'jev_bad_response',
      }
    probabilities.push(answer.noul)
  }

  return { ok: true, probabilities, version: QUESTION_SUBSTANCE_VERSION }
}

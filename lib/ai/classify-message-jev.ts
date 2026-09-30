/**
 * Inbound classification via TypeSafe's Jev, a non-generative "System One"
 * decision model, as an alternative to the Haiku `generateObject` call in
 * `classify-message.ts`.
 *
 * WHY. Classification is the measured 2.5s p50 / 3.6s p90 of the inbound hot
 * path, and it is a pure decision task: a 13-way category pick and two
 * booleans. Jev answers typed questions with calibrated probabilities in one
 * parallel pass (~150-250ms measured from this codebase's network), and its
 * confidence is trained calibration rather than a model's self-report - which
 * is what the 0.3/0.7 confidence routing in `lib/ai/CLAUDE.md` actually wants.
 *
 * FAILS OPEN TO HAIKU, always. Any failure here - missing env, timeout,
 * non-200, an unparseable body, an out-of-enum category - returns
 * `{ok: false}` and `classifyMessage` falls through to the unchanged Haiku
 * path. The worst case of this module is therefore today's exact behaviour
 * plus the timeout. That direction is deliberate: classification blocks a
 * guest's reply, and a new vendor must not be able to silence one.
 *
 * THE FLAG IS ON (2026-09-29). It shipped false until the replay eval
 * (`scripts/measurement/jev-classify-eval.ts`) compared Jev against Haiku on
 * 30 days of real inbound: 247 units, zero call failures on either arm, zero
 * crisis false negatives against the pre-registered ceiling, 80.2% category
 * agreement with the disagreements reviewed and accepted by the operator.
 * Rollback is this one line back to `false` (`INBOUND_COALESCING_ENABLED`
 * precedent). In an environment without `JEV_API_KEY` the fail-open path
 * makes the flag a no-op: every turn falls back to Haiku with a
 * `jev_classification_fallback` warn.
 *
 * THE QUESTION SET IS A PARALLEL COPY of the Haiku prompt's semantics, worded
 * for Jev's criteria format - it is NOT extracted from `CLASSIFY_SYSTEM_PROMPT`,
 * because that string must stay byte-identical (a change there is a
 * `PROMPT_VERSION` bump and a repo-wide sweep). The drift guard is
 * `classify-message-jev.test.ts`, which asserts this module's category keys
 * exactly equal the Haiku schema's enum options. Versioned independently as
 * `CLASSIFY_JEV_PROMPT_VERSION` per the sibling-version rule in
 * `lib/ai/CLAUDE.md`; `ClassifyMessageResult.promptVersion` has no consumer
 * today (verified 2026-09-29 - `classifyStage` drops it), so carrying the Jev
 * version there is honest observability with no behavioural surface.
 *
 * THE NOUL THRESHOLDS ENCODE THE PROMPT'S ASYMMETRIES. Jev returns P(yes),
 * not a boolean, so "when genuinely ambiguous prefer true" (crisis) becomes a
 * LOW threshold and "when genuinely unsure prefer false" (correctsPending)
 * becomes a HIGH one. Both are provisional until the replay eval measures the
 * actual noul distributions; move them on its evidence, not on argument.
 */

import { z } from 'zod'
import type { AIResult, ClassifyMessageResult } from './types'
import { checkTypesafeEnv } from './typesafe-env'

export const JEV_CLASSIFICATION_ENABLED = true

// jev-v1.1.0: crisis question gained explicit true/false criteria carrying
// the prefer-true-on-ambiguity asymmetry. v1.0.0 scored an ambiguous "I want
// to end it soon" at p(yes)=0.06 - it read "end it" as ending the
// conversation - and the fixture eval's zero-false-negative ceiling caught it.
export const CLASSIFY_JEV_PROMPT_VERSION = 'jev-v1.1.0'

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'

/**
 * 10x Jev's measured median and still well under Haiku's p50, so the
 * worst-case fallback turn (timeout + full Haiku call) stays comparable to
 * today's classify stage rather than doubling it.
 */
export const JEV_TIMEOUT_MS = 1_500

/**
 * P(yes) at or above this flags crisisSafety. Low on purpose: the prompt rule
 * it replaces says a false positive costs one unnecessary safety message, a
 * false negative costs missing a guest who needs help.
 */
export const JEV_CRISIS_THRESHOLD = 0.2

/**
 * P(yes) at or above this sets correctsPendingReply. High on purpose: a
 * wrongly-true value rewrites a reply the guest was waiting for, a
 * wrongly-false one only means a second, separate reply.
 */
export const JEV_CORRECTS_PENDING_THRESHOLD = 0.75

/** The classifier's 13 inbound categories. Must match the Haiku enum exactly. */
export const CLASSIFIER_CATEGORIES = [
  'reply',
  'new_question',
  'opt_out',
  'manual',
  'acknowledgment',
  'comp_complaint',
  'mechanic_request',
  'recommendation_request',
  'casual_chatter',
  'personal_history_question',
  'perk_inquiry',
  'event_question',
  'unknown',
] as const

export type ClassifierCategory = (typeof CLASSIFIER_CATEGORIES)[number]

/**
 * One description per category, mirroring CLASSIFY_SYSTEM_PROMPT's semantics.
 * `satisfies` makes a missing or extra key a tsc error; the test pins the key
 * set against the Haiku schema so the two cannot drift apart silently.
 */
export const JEV_CATEGORY_CRITERIA = {
  reply:
    'A conversational reply to something the venue sent, without a specific question, complaint, request, or other intent below.',
  new_question:
    'The guest is asking the venue a factual question (hours, menu, location, etc.).',
  opt_out: 'The guest is asking to stop receiving messages.',
  acknowledgment:
    'The guest is acknowledging, signing off, or otherwise closing a thread without a question or request (e.g., "thanks", "ok cool", "got it", "see you tomorrow").',
  comp_complaint:
    'The guest is reporting a quality issue or unsatisfactory experience with something they received from the venue (e.g., "muffin was stale", "had a bad experience today", "waited 20 minutes"). A complaint about service is comp_complaint even if phrased as a reply.',
  mechanic_request:
    'The guest is asking about, invoking, or requesting a perk, hold, event slot, or other venue mechanic (e.g., "can you hold the couch", "is the tea on the house", "can i get on the open mic list").',
  recommendation_request:
    'The guest is asking the venue for a recommendation on what to order, try, or pair (e.g., "what\'s good here", "what do you pair with the latte", "anything worth trying"). Opinion-shaped questions belong here, not in new_question, which is factual.',
  casual_chatter:
    'The guest is making small talk or an unprompted casual comment without asking a question or invoking a service (e.g., "this neighborhood is wild", "love this couch", "hope you have a good day"). Distinct from reply, which is in conversational response to something the venue sent.',
  personal_history_question:
    'The guest is asking about their own past interactions with the venue: what they ordered, when they visited, whether they have been here before, or anything about their own history (e.g., "what did I get last time", "do you remember me", "have I been here before"). Never route these to manual or new_question.',
  perk_inquiry:
    'The guest is asking ABOUT perks, recognition, what they unlock, or whether they qualify for something (e.g., "do I get any free drinks?", "do I unlock anything if I keep coming?"). Distinct from mechanic_request, which is invoking or requesting a specific mechanic.',
  event_question:
    'The guest is asking about the venue\'s events, when they are, or what is coming up (e.g., "when\'s the next open mic?", "what\'s happening this weekend?", "do you have anything Friday?").',
  manual:
    'The message contains content that genuinely needs an operator\'s eyes before a real reply can be written (sensitive complaints, complex situations, custom requests that cannot be answered from documented venue facts). Not a fallback for ambiguous classification.',
  unknown:
    'The message does not fit any other category cleanly and the agent has no confident grounding to respond. Only when it genuinely fits nothing else.',
} as const satisfies Record<ClassifierCategory, string>

const CATEGORY_INSTRUCTIONS =
  'Classify `inbound_message`, sent by a guest to a hospitality venue (cafe, bakery, restaurant), into exactly one category. ' +
  'When a message could fit multiple categories, prefer the more specific one. ' +
  'If the message looks like a response to an event invite or perk offer, choose reply (or event_question / perk_inquiry if the guest is asking ABOUT an event or perk). ' +
  'If a first contact looks like an opening pleasantry, choose casual_chatter or new_question depending on what the guest is saying.'

const CRISIS_INSTRUCTIONS =
  'Does `inbound_message` express either (a) self-harm or suicidal ideation - the guest indicates they may hurt themselves, wants to die, does not see the point of continuing, or similar - or (b) an immediate medical emergency or physical danger, such as a severe allergic reaction, difficulty breathing, chest pain, choking, or an injury in progress? ' +
  'If `inbound_message_full_for_crisis_check` is present, judge against that fuller text.'

/**
 * The noul's own true/false criteria carry the asymmetry the Haiku prompt
 * states as "when genuinely ambiguous, prefer true": a phrase that admits a
 * self-harm reading alongside an innocuous one ("I want to end it", a
 * farewell-toned sign-off with no referent) belongs to TRUE, while only
 * clearly innocuous uses - including the hyperbole idioms - belong to FALSE.
 * This is the jev-v1.1.0 change; without it, jev-1.13.0 measured that exact
 * ambiguous phrasing at p(yes)=0.06 and the eval ceiling failed the run.
 */
const CRISIS_CRITERIA = {
  true:
    'The message states a crisis signal, OR is genuinely ambiguous between an innocuous meaning and a self-harm or emergency reading - e.g. "I want to end it" with no clear object, a goodbye-toned message thanking people with finality, or distress language whose target is unclear. A false positive costs one unnecessary safety check-in.',
  false:
    'The message is clearly innocuous, including hyperbole and idiom that merely borrow this language ("this coffee is to die for", "dying to try this place", "I\'m dying laughing", "a matter of life and death" about something trivial). A false negative misses a guest who needs help, so only choose false when the innocuous reading is the only plausible one.',
} as const

const CORRECTS_PENDING_INSTRUCTIONS =
  'In `recent_conversation`, a venue line may be marked NOT SENT - a reply the venue drafted but has not approved; that marker also appears on replies the venue decided not to send, so judge only against one that is waiting for approval, and only the most recent such line. ' +
  'Does `inbound_message` clearly correct, amend, or change the question that NOT SENT reply is answering ("actually make that oat milk", "wait, I meant tomorrow")? ' +
  'A new unrelated question, an acknowledgement, a reaction, or small talk does not. If there is no NOT SENT line at all, the answer is no.'

/**
 * The state block, assembled by `classifyMessage` from the same serialized
 * text the Haiku prompt uses, so the two arms judge identical inputs. Named
 * fields per TypeSafe's guidance; questions reference them by backticked path.
 */
export interface JevClassifyState {
  venue_context?: string
  recent_conversation?: string
  guest_relationship?: string
  inbound_message: string
  /** Present only when `inbound_message` was truncated; capped separately. */
  inbound_message_full_for_crisis_check?: string
}

const NoulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number() })

const ChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
})

const SystemOneResponseSchema = z.object({
  model: z.string(),
  answers: z.object({
    category: ChoiceAnswerSchema,
    crisis: NoulAnswerSchema,
    corrects_pending: NoulAnswerSchema,
  }),
})

type FetchLike = typeof fetch

export interface JevDeps {
  env?: Record<string, string | undefined>
  fetchImpl?: FetchLike
}

function isClassifierCategory(value: string): value is ClassifierCategory {
  return (CLASSIFIER_CATEGORIES as readonly string[]).includes(value)
}

/** `jev-1.13.0: category=reply(0.87), runner-up new_question(0.11); ...` */
function serializeReasoning(
  model: string,
  choice: string,
  probabilities: Record<string, number>,
  crisis: number,
  correctsPending: number,
): string {
  const runnerUp = Object.entries(probabilities)
    .filter(([category]) => category !== choice)
    .sort((a, b) => b[1] - a[1])[0]
  const runnerUpText = runnerUp ? `, runner-up ${runnerUp[0]}(${runnerUp[1].toFixed(2)})` : ''
  const chosen = probabilities[choice]
  return (
    `${model}: category=${choice}(${(chosen ?? 0).toFixed(2)})${runnerUpText}; ` +
    `crisis p(yes)=${crisis.toFixed(2)}; corrects_pending p(yes)=${correctsPending.toFixed(2)}`
  )
}

/**
 * One request, three parallel judgments. Every failure path returns
 * `{ok: false}` with a distinct `errorCode` so the fallback event can say
 * which way it failed; none of them throws.
 */
export async function classifyMessageViaJev(
  state: JevClassifyState,
  deps: JevDeps = {},
): Promise<AIResult<ClassifyMessageResult>> {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch

  // First-call enforcement, per the credential rule. Never at module load.
  const envCheck = checkTypesafeEnv(env)
  if (!envCheck.ok) {
    return { ok: false, error: envCheck.problems.join('; '), errorCode: 'jev_env_missing' }
  }

  let response: Response
  try {
    response = await fetchImpl(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.JEV_API_KEY!.trim()}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      body: JSON.stringify({
        model: JEV_MODEL,
        state,
        questions: {
          category: {
            type: 'choice',
            instructions: CATEGORY_INSTRUCTIONS,
            criteria: JEV_CATEGORY_CRITERIA,
          },
          crisis: { type: 'noul', instructions: CRISIS_INSTRUCTIONS, criteria: CRISIS_CRITERIA },
          corrects_pending: { type: 'noul', instructions: CORRECTS_PENDING_INSTRUCTIONS },
        },
      }),
    })
  } catch (e) {
    // Same classification as instagram/graph.ts: the runtime raises
    // TimeoutError from AbortSignal.timeout, AbortError from manual aborts.
    const name = e instanceof Error ? e.name : ''
    const errorCode = name === 'TimeoutError' || name === 'AbortError' ? 'jev_timeout' : 'jev_network'
    return {
      ok: false,
      error: `jev fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      errorCode,
    }
  }

  if (!response.ok) {
    return { ok: false, error: `jev http ${response.status}`, errorCode: `jev_http_${response.status}` }
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

  const parsed = SystemOneResponseSchema.safeParse(body)
  if (!parsed.success) {
    return { ok: false, error: `jev response shape: ${parsed.error.message}`, errorCode: 'jev_bad_response' }
  }

  const { category, crisis, corrects_pending: correctsPending } = parsed.data.answers
  if (!isClassifierCategory(category.choice)) {
    // The API cannot choose an option we did not offer, so this is a contract
    // violation, not a judgment - and it must not become an `unknown` reply.
    return { ok: false, error: `jev chose unknown category: shape violation`, errorCode: 'jev_bad_category' }
  }

  return {
    ok: true,
    data: {
      category: category.choice,
      classifierConfidence: category.confidence,
      reasoning: serializeReasoning(
        parsed.data.model,
        category.choice,
        category.probabilities,
        crisis.noul,
        correctsPending.noul,
      ),
      promptVersion: CLASSIFY_JEV_PROMPT_VERSION,
      crisisSafety: crisis.noul >= JEV_CRISIS_THRESHOLD,
      correctsPendingReply: correctsPending.noul >= JEV_CORRECTS_PENDING_THRESHOLD,
      // TAC-386 KNOWN GAP: the Jev unit (v1.13.0) has no followUpWorthy
      // question, so a Jev-classified turn never arms an inquiry follow-up.
      // False is the cheap direction by TAC-386's own posture (a missed
      // follow-up, never a broken turn). Adding the question to the Jev unit
      // is the v-next work item; do NOT derive it from category here - the
      // 2026-09-30 ruling drew the line on what the answer helps the guest DO,
      // which a category cannot express.
      followUpWorthy: false,
    },
  }
}

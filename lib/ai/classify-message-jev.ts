/**
 * Inbound classification via TypeSafe's Jev, a non-generative "System One"
 * decision model, as an alternative to the Haiku `generateObject` call in
 * `classify-message.ts`.
 *
 * WHY. Classification is the measured 2.5s p50 / 3.6s p90 of the inbound hot
 * path, and it is a pure decision task: a 13-way category pick and four
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
 * `PROMPT_VERSION` bump and a repo-wide sweep). This module's category keys
 * must exactly equal the Haiku schema's enum options. Versioned independently as
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

// jev-v1.5.0: a short answer to our own question is read as that answer.
// "how do i brew your beans" got a reply that left the guest a choice of bean,
// the guest wrote "budan", and the category came back new_question 0.30
// against unknown 0.29: a confidence of 0.24, under the 0.3 floor, so the turn
// ran as `unknown` and was held (phone test, 2026-10-07; "the karak chai" two
// days earlier was the same shape). The conversation WAS being read: with
// `recent_conversation` removed the same message is unknown at 0.50, and "what's
// your name?" / "jaipal" goes from reply 0.72 to unknown 0.57. What was missing
// is a rule for the tie, which the last two sentences of CATEGORY_INSTRUCTIONS
// now give. Wording approved 2026-10-07; the Haiku prompt carries the same
// sentence under PROMPT_VERSION v1.104.0. Check:
// `npm run measure-answer-to-our-question`, whose control cell is the same
// word with no conversation in front of it.
// jev-v1.4.0 (TAC-386): a `follow_up_worthy` noul. This arm had returned
// `followUpWorthy: false` unconditionally since it went live on 2026-09-29, 40
// minutes after the inquiry follow-up shipped, so `inquiry_followups` never
// held a row: the scheduler's first gate reads this field. The question set is
// built here and sent with every request, so asking it is a change to this
// file and nothing else (ruled 2026-10-06: no Haiku sidecar).
//
// Adding a question must not move the other four answers. Check that on the
// replay (jev-classify-eval.ts) by comparing category per message id against a
// run on the previous wording, not by reading the agreement rate. The bar
// (ruled 2026-10-06) is NO MORE FLIPS THAN A REPEAT RUN OF THE SAME WORDING
// SHOWS, not zero: Jev is not deterministic, and two runs on identical wording
// moved 10 low-confidence categories of 297.
//
// The first draft of the criteria missed every real public-events question
// (0.58 to 0.72 against 0.75) and fired on six pure facts ("show me the menu",
// "what is <item>", which beans a drink uses, an off-topic shopping question).
// Hence the events sentence in TRUE and the menu, what-is and unrelated
// clauses in FALSE. The threshold was ruled to stay; no threshold separates
// the events questions from "what's the wifi password" on the first draft.
// jev-v1.3.0 (TAC-574): `mechanic_request` says ordering from the menu is NOT
// one, and `new_question` says ordering and availability questions belong to
// it. "can i get a flat white" and "can i order ahead" had both been classed
// mechanic_request, which always holds the reply for approval. Ruled
// 2026-10-06; the Haiku prompt carries the same wording under PROMPT_VERSION
// v1.85.0.
//
// THE WORDING IS NARROW ON PURPOSE, and two wider drafts are why. Both passed
// the seven-phrase harness (scripts/measurement/classifier-mechanic.ts) and
// both moved real traffic the wrong way on the 30-day replay
// (jev-classify-eval.ts, 297 units, each compared with main's wording):
//   - defining mechanic_request as "something the venue has to arrange or
//     grant, ... a comp or something on the house" pulled "what's the wifi
//     password", "do you have a bathroom code" and a cold-latte complaint
//     asking for a free one INTO mechanic_request. Net 15 -> 20 on this arm.
//   - leaving the factual examples off new_question while adding the ordering
//     ones left the wifi and bathroom questions there, and moved "can you set
//     aside a blossom tonic for me tomorrow" OUT, which is a hold.
// Hence the wifi and set-aside examples below. Change either definition only
// with the replay beside the phrase harness: the phrases are quoted in the
// definitions, so they pass almost whatever else the wording does.
// jev-v1.2.0: added the `praise` noul behind the once-ever Google review ask.
// jev-v1.1.0: crisis question gained explicit true/false criteria carrying
// the prefer-true-on-ambiguity asymmetry. v1.0.0 scored an ambiguous "I want
// to end it soon" at p(yes)=0.06 - it read "end it" as ending the
// conversation - and the fixture eval's zero-false-negative ceiling caught it.
export const CLASSIFY_JEV_PROMPT_VERSION = 'jev-v1.5.0'

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

/**
 * P(yes) at or above this sets praisedExperience. High on purpose, the same
 * posture as correctsPending: a wrongly-true value spends the once-ever
 * review ask on a lukewarm message, a wrongly-false one just waits for the
 * guest's next praise. Provisional until the replay eval measures the praise
 * noul's distribution (`scripts/measurement/jev-classify-eval.ts`); move it
 * on that evidence, not on argument.
 */
export const JEV_PRAISE_THRESHOLD = 0.75

/**
 * P(yes) at or above this sets followUpWorthy. High on purpose, the same
 * posture as correctsPending and praise: a wrongly-true value sends a guest an
 * unprompted message they did not need, a wrongly-false one costs one missed
 * check-in. Provisional (ruled 2026-10-06) until real volume says otherwise;
 * move it on the replay's p(yes) distribution
 * (`scripts/measurement/jev-classify-eval.ts`) and the fixture bars
 * (`scripts/measurement/follow-up-worthy.ts`), not on argument.
 */
export const JEV_FOLLOW_UP_WORTHY_THRESHOLD = 0.75

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
 * `satisfies` makes a missing or extra key a tsc error.
 */
export const JEV_CATEGORY_CRITERIA = {
  reply:
    'A conversational reply to something the venue sent, without a specific question, complaint, request, or other intent below.',
  new_question:
    'The guest is asking the venue a factual question (hours, menu, location, wifi, etc.) or asking whether they can order something or whether it is available (e.g., "what time do you close", "what\'s the wifi password", "can i get a flat white", "can i order ahead", "do you do pre-orders", "can i get oat milk in that").',
  opt_out: 'The guest is asking to stop receiving messages.',
  acknowledgment:
    'The guest is acknowledging, signing off, or otherwise closing a thread without a question or request (e.g., "thanks", "ok cool", "got it", "see you tomorrow").',
  comp_complaint:
    'The guest is reporting a quality issue or unsatisfactory experience with something they received from the venue (e.g., "muffin was stale", "had a bad experience today", "waited 20 minutes"). A complaint about service is comp_complaint even if phrased as a reply.',
  mechanic_request:
    'The guest is asking about, invoking, or requesting a perk, hold, event slot, or other venue mechanic (e.g., "can you hold the couch", "can you set one aside for me tomorrow", "is the tea on the house", "can i get on the open mic list"). Ordering from the menu or asking whether an item or option is available is NOT mechanic_request, even when phrased "can i get"; that is new_question.',
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
    "The message contains content that genuinely needs an operator's eyes before a real reply can be written (sensitive complaints, complex situations, custom requests that cannot be answered from documented venue facts). Not a fallback for ambiguous classification.",
  unknown:
    'The message does not fit any other category cleanly and the agent has no confident grounding to respond. Only when it genuinely fits nothing else.',
} as const satisfies Record<ClassifierCategory, string>

const CATEGORY_INSTRUCTIONS =
  'Classify `inbound_message`, sent by a guest to a hospitality venue (cafe, bakery, restaurant), into exactly one category. ' +
  'When a message could fit multiple categories, prefer the more specific one. ' +
  'A guest ordering from the menu or asking whether something is available is new_question, not mechanic_request. ' +
  'If the message looks like a response to an event invite or perk offer, choose reply (or event_question / perk_inquiry if the guest is asking ABOUT an event or perk). ' +
  'If a first contact looks like an opening pleasantry, choose casual_chatter or new_question depending on what the guest is saying. ' +
  "When the venue's last message in `recent_conversation` asked the guest something or left them a choice, and `inbound_message` is a short answer to it (a name, an item, yes or no, a day), read it as that answer: new_question when it continues a question the guest had asked, reply otherwise. " +
  "A short answer to the venue's own question is never unknown."

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
  true: 'The message states a crisis signal, OR is genuinely ambiguous between an innocuous meaning and a self-harm or emergency reading - e.g. "I want to end it" with no clear object, a goodbye-toned message thanking people with finality, or distress language whose target is unclear. A false positive costs one unnecessary safety check-in.',
  false:
    'The message is clearly innocuous, including hyperbole and idiom that merely borrow this language ("this coffee is to die for", "dying to try this place", "I\'m dying laughing", "a matter of life and death" about something trivial). A false negative misses a guest who needs help, so only choose false when the innocuous reading is the only plausible one.',
} as const

const PRAISE_INSTRUCTIONS =
  'Does `inbound_message` express genuine, specific enthusiasm about something the guest got or experienced at the venue: an item they ordered ("that croissant was unreal", "best latte I have had in ages"), a visit ("we had such a great time today"), or the service or space itself ("you guys are the best", "love this place")?'

/**
 * The noul's true/false criteria carry the Haiku paragraph's prefer-false
 * asymmetry (the inverse of CRISIS_CRITERIA's prefer-true): the ask this flag
 * arms is once per guest ever, so an unclear signal belongs to FALSE.
 */
const PRAISE_CRITERIA = {
  true: 'The message contains genuine, specific enthusiasm about something the guest received or experienced at the venue: food, drink, service, the space, or a visit. A wrongly-missed signal costs nothing; the guest will praise again.',
  false:
    'Bare thanks or sign-offs ("thanks", "thanks so much", "ok great", "got it"); politeness attached to a question or request; anticipation about something that has not happened yet ("cannot wait to try it"); compliments about this conversation or about texting with the venue rather than about the venue itself; any message that also reports a problem, disappointment, or complaint, even when it contains praise too; and any genuinely unclear case - a wrongly-true answer spends a moment that only comes once.',
} as const

const FOLLOW_UP_WORTHY_INSTRUCTIONS =
  "Would the venue's answer to `inbound_message` help the guest do something afterwards, so that checking later whether it worked out would be natural? " +
  'Judge `inbound_message` itself; `recent_conversation` is only context.'

/**
 * A parallel copy of the Haiku prompt's followUpWorthy paragraphs
 * (`classify-message.ts`), reshaped into true/false criteria. The line it
 * draws is ruled (2026-09-30): what the answer helps the guest DO, which is
 * why this is its own question and never derived from category.
 *
 * TWO OF THE EXCLUSIONS HAVE NOTHING BEHIND THEM BUT THIS TEXT. Complaints,
 * operator-held messages and crisis are also refused structurally by
 * `lib/agent/schedule-inquiry-followup.ts`. Bookings and "on my way" are not:
 * no category means either, and the 2026-09-30 ruling kept `event_question`
 * and `mechanic_request` off the scheduler's deny-list. So the FALSE criteria
 * are the only gate on those two, and the A4 and A5 arms of
 * `scripts/measurement/follow-up-worthy.ts` are what holds them at zero.
 */
const FOLLOW_UP_WORTHY_CRITERIA = {
  true: 'The answer is something the guest then goes and does: where to park or how to find the place; which beans or bag to buy; how to brew something at home; whether they can bring a dog; what to order or try. Asking whether the venue has public events coming up, or what is on, also qualifies, because the guest may then go to one ("do you have any events coming up", "anything happening in November"). A question can be factual and still qualify when the guest acts on the answer: asking how to get there qualifies, asking when you close does not.',
  false:
    'There is nothing to have worked out: a pure fact with no action behind it ("what time do you close", "are you open Monday", "do you have wifi"), which includes asking to see the menu or prices, asking what an item is or what is in it, and asking which beans or ingredients the venue uses; a question about something unrelated to the venue, such as where to buy a thing the venue does not sell; small talk, thanks or a passing comment; a complaint or a report that something was wrong; anything involving someone\'s safety or an emergency; anything an operator arranges rather than the venue simply answering (catering, a PRIVATE event or renting the space, taking a booking or reservation, wholesale, press, hiring or partnership enquiries), which is different from asking about public events; a guest saying they are arriving or on their way ("omw", "walking over", "heading in now", "can you get my order ready"); and any genuinely unclear case. A wrongly-false answer costs one missed check-in; a wrongly-true one sends a guest a message they did not need.',
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
    praise: NoulAnswerSchema,
    follow_up_worthy: NoulAnswerSchema,
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

/** The second-highest scored category, or undefined when only one was scored. */
function runnerUpOf(
  choice: string,
  probabilities: Record<string, number>,
): [string, number] | undefined {
  return Object.entries(probabilities)
    .filter(([category]) => category !== choice)
    .sort((a, b) => b[1] - a[1])[0]
}

/** `jev-1.13.0: category=reply(0.87), runner-up new_question(0.11); ...` */
function serializeReasoning(
  model: string,
  choice: string,
  probabilities: Record<string, number>,
  crisis: number,
  correctsPending: number,
  praise: number,
  followUpWorthy: number,
): string {
  const runnerUp = runnerUpOf(choice, probabilities)
  const runnerUpText = runnerUp
    ? `, runner-up ${runnerUp[0]}(${runnerUp[1].toFixed(2)})`
    : ''
  const chosen = probabilities[choice]
  return (
    `${model}: category=${choice}(${(chosen ?? 0).toFixed(2)})${runnerUpText}; ` +
    `crisis p(yes)=${crisis.toFixed(2)}; corrects_pending p(yes)=${correctsPending.toFixed(2)}; ` +
    `praise p(yes)=${praise.toFixed(2)}; follow_up_worthy p(yes)=${followUpWorthy.toFixed(2)}`
  )
}

/**
 * One request, five parallel judgments. Every failure path returns
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
    return {
      ok: false,
      error: envCheck.problems.join('; '),
      errorCode: 'jev_env_missing',
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
          crisis: {
            type: 'noul',
            instructions: CRISIS_INSTRUCTIONS,
            criteria: CRISIS_CRITERIA,
          },
          corrects_pending: {
            type: 'noul',
            instructions: CORRECTS_PENDING_INSTRUCTIONS,
          },
          praise: {
            type: 'noul',
            instructions: PRAISE_INSTRUCTIONS,
            criteria: PRAISE_CRITERIA,
          },
          follow_up_worthy: {
            type: 'noul',
            instructions: FOLLOW_UP_WORTHY_INSTRUCTIONS,
            criteria: FOLLOW_UP_WORTHY_CRITERIA,
          },
        },
      }),
    })
  } catch (e) {
    // Same classification as instagram/graph.ts: the runtime raises
    // TimeoutError from AbortSignal.timeout, AbortError from manual aborts.
    const name = e instanceof Error ? e.name : ''
    const errorCode =
      name === 'TimeoutError' || name === 'AbortError'
        ? 'jev_timeout'
        : 'jev_network'
    return {
      ok: false,
      error: `jev fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      errorCode,
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `jev http ${response.status}`,
      errorCode: `jev_http_${response.status}`,
    }
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
    return {
      ok: false,
      error: `jev response shape: ${parsed.error.message}`,
      errorCode: 'jev_bad_response',
    }
  }

  const {
    category,
    crisis,
    corrects_pending: correctsPending,
    praise,
    follow_up_worthy: followUpWorthy,
  } = parsed.data.answers
  if (!isClassifierCategory(category.choice)) {
    // The API cannot choose an option we did not offer, so this is a contract
    // violation, not a judgment - and it must not become an `unknown` reply.
    return {
      ok: false,
      error: `jev chose unknown category: shape violation`,
      errorCode: 'jev_bad_category',
    }
  }

  const runnerUp = runnerUpOf(category.choice, category.probabilities)?.[0]
  return {
    ok: true,
    data: {
      category: category.choice,
      classifierConfidence: category.confidence,
      ...(runnerUp !== undefined && isClassifierCategory(runnerUp)
        ? { runnerUpCategory: runnerUp }
        : {}),
      reasoning: serializeReasoning(
        parsed.data.model,
        category.choice,
        category.probabilities,
        crisis.noul,
        correctsPending.noul,
        praise.noul,
        followUpWorthy.noul,
      ),
      promptVersion: CLASSIFY_JEV_PROMPT_VERSION,
      crisisSafety: crisis.noul >= JEV_CRISIS_THRESHOLD,
      correctsPendingReply:
        correctsPending.noul >= JEV_CORRECTS_PENDING_THRESHOLD,
      praisedExperience: praise.noul >= JEV_PRAISE_THRESHOLD,
      followUpWorthy: followUpWorthy.noul >= JEV_FOLLOW_UP_WORTHY_THRESHOLD,
    },
  }
}

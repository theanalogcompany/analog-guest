import type { MessageCategory } from '@/lib/ai'
import { looksLikeQuestion } from '@/lib/agent/looks-like-question'
import {
  INTENTION_DEFINITION_BY_KEY,
  type IntentionKey,
  type IntentionSatisfactionFacts,
  resolveIntentionKey,
} from './definitions'
import type { PromptedIntentionRow } from './load'

// When a getting-to-know-you question may be asked. Ruled 2026-10-07, after a
// phone test: the name question went unanswered, and a few messages later "do
// you live or work nearby?" went out in the same reply as the menu link.
//
// Pure: no DB access. Three rules, all on top of the reply counts in
// definitions.ts, which stay as the minimum. They apply to the intentions whose
// definition says `pacing: 'conversation'` and to nothing else.
//
//   1. ONE OPEN QUESTION AT A TIME. While the last one asked in this
//      conversation is unanswered, none is raised. An ignored question ends the
//      asking for that conversation.
//   2. ONLY ON A RELAXED TURN. Never in a reply that answers a question, sends
//      a link or makes a recommendation.
//   3. A CEILING PER CONVERSATION. Two, or three for a guest who is engaged.
//
// Rules 1 and 3 are decided in deriveOpenIntentions from recorded state. Rule 2
// needs this turn's classification and then the draft itself, so it is decided
// in two later places: isRelaxedCategory in renderableIntentions, and the
// task-draft drop at the compose seam in lib/ai/generate-message.ts (which
// lives there because lib/ai imports nothing from lib/agent).
//
// NOTHING HERE WRITES OR CLOSES ANYTHING. A held intention keeps its row and
// its window, exactly as under the brake, and is open again once the hold
// lifts.
//
// "THIS CONVERSATION" is the conversation window every other reader uses
// (followup_rules.recent_conversation_hours, TAC-380 ruling 1): a question
// asked within it of now is part of this conversation. Ruled 2026-10-07 rather
// than a shorter "sitting", which would have been a second definition.

/** Questions per conversation for a guest who is not engaged. Ruled 2026-10-07. */
export const PACED_QUESTIONS_PER_CONVERSATION = 2

/** The hard ceiling, engaged or not. Ruled 2026-10-07. */
export const PACED_QUESTIONS_PER_CONVERSATION_ENGAGED = 3

/**
 * The median length, in words, of an engaged guest's messages. A FIRST GUESS,
 * approved as one: nothing was measured to pick it. The verdict and both of its
 * signals are logged on every turn so it can be set from real threads.
 */
export const ENGAGED_MEDIAN_WORDS = 6

/**
 * The turns a getting-to-know-you question may ride on: small talk, thanks, a
 * reaction to something we said. Every other category is the guest in the
 * middle of something (asking, ordering, requesting, complaining), and the
 * reply to it is an answer.
 *
 * `reply` is included by ruling (2026-10-07): without it "haha yes" after a
 * message of ours never qualifies. It is also what a guest ANSWERING our
 * question is classified as, and that turn is kept clear by rule 1 instead: the
 * answer is not on file until the turn has run.
 */
const RELAXED_CATEGORIES: ReadonlySet<MessageCategory> = new Set([
  'casual_chatter',
  'acknowledgment',
  'reply',
])

/**
 * Rule 2, the half that is known before the reply is written.
 *
 * A null category (nothing classified) is NOT relaxed. Fails closed: a missed
 * question costs a turn, and a question on a turn nobody classified is the
 * failure this rule exists to stop.
 */
export function isRelaxedCategory(category: MessageCategory | null): boolean {
  return category !== null && RELAXED_CATEGORIES.has(category)
}

/** Why the paced intentions are held this turn, or `'none'`. */
export type PacingHold =
  /** Not held. */
  | 'none'
  /** Rule 1: the last question asked in this conversation has no answer on file. */
  | 'open_question'
  /** Rule 3: two asked in this conversation, and the guest is not engaged. */
  | 'conversation_cap'
  /** Rule 3: three asked in this conversation. Nothing lifts this one. */
  | 'engaged_cap'

export interface PacingVerdict {
  hold: PacingHold
  /** Sent messages in this conversation that asked a paced question. */
  askedThisConversation: number
  /** The intentions the newest of those messages raised. */
  lastAskedKeys: IntentionKey[]
  /** Null when nothing was asked in this conversation. */
  lastAskedAnswered: boolean | null
  /**
   * Null when nothing was asked in this conversation: engagement is judged on
   * what the guest wrote after our first question, so there is nothing to
   * judge. Logged every turn (ruled 2026-10-07) so the thresholds can be
   * calibrated, including on turns where it changes nothing.
   */
  engaged: boolean | null
  /** The parts of `engaged`, logged beside it. */
  engagedSignals: {
    /** Every paced question asked in this conversation has an answer on file. */
    allAnswered: boolean
    /** The guest asked us something after our first question. */
    askedUsSomething: boolean
    /** Median words per message after our first question, or null with none. */
    medianWords: number | null
  } | null
}

export const NO_PACING_HOLD: PacingVerdict = {
  hold: 'none',
  askedThisConversation: 0,
  lastAskedKeys: [],
  lastAskedAnswered: null,
  engaged: null,
  engagedSignals: null,
}

/** True when this intention is held to the pacing rules. Reads the definition, never the key. */
export function isConversationPaced(key: IntentionKey): boolean {
  return INTENTION_DEFINITION_BY_KEY[key].pacing === 'conversation'
}

function wordCount(body: string): number {
  const trimmed = body.trim()
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Rules 1 and 3 for one turn.
 *
 * WHAT "ASKED" READS. The prompted rows of the paced intentions, inside this
 * conversation. One per SENT MESSAGE, the brake's own counting and for its
 * reason: a single send can raise two intentions and is still one question to
 * the guest. A pessimistic closure is not counted: the classifier failed twice
 * and nothing may have been asked (also the brake's rule).
 *
 * WHAT "ANSWERED" READS. The asked intention's own `isSatisfied`: the name,
 * the home base or their history here is on file. That is the only record of
 * an answer there is, and it has two consequences worth stating:
 *
 *   - The turn that carries the answer still reads unanswered, because the
 *     context write happens inside that turn, after this runs. So no question
 *     rides on the reply to an answer; the next relaxed turn may carry one.
 *   - their_rhythm and why_theyre_here store no answer (`isSatisfied` is
 *     `() => false`). Once either is asked, it reads unanswered for the rest of
 *     the conversation and nothing follows it. The closed direction, and they
 *     are the last two in line.
 *
 * KNOWN LIMIT. A prompted row is written after the send, by a classifier call.
 * A guest who replies inside that gap is derived against no row, so rule 1
 * does not see the question yet. Prompted-once closure has the same gap.
 *
 * ENGAGED, approved 2026-10-07: every question asked so far has its answer on
 * file, AND the guest has either asked us something or writes at length
 * (ENGAGED_MEDIAN_WORDS), judged on their messages since our first question in
 * this conversation. Being engaged lifts the ceiling from two to three and
 * lifts nothing else: rule 1 is checked first.
 */
export function derivePacing(input: {
  prompted: readonly PromptedIntentionRow[]
  facts: IntentionSatisfactionFacts
  /** The guest's messages in the loaded history, including the current one. */
  inboundMessages: readonly { at: Date; body: string | null }[]
  now: Date
  conversationWindowMs: number
}): PacingVerdict {
  const now = input.now.getTime()
  const conversationStart = now - input.conversationWindowMs

  // One entry per sent message that asked a paced question in this conversation.
  const asks = new Map<string, { at: number; keys: IntentionKey[] }>()
  for (const row of input.prompted) {
    if (row.promptSource === 'pessimistic') continue
    const key = resolveIntentionKey(row.intentionKey)
    if (key === null || !isConversationPaced(key)) continue
    const at = row.promptedAt.getTime()
    if (!Number.isFinite(at) || at < conversationStart || at > now) continue
    const messageKey =
      row.messageId ?? `prompted-at:${row.promptedAt.toISOString()}`
    const ask = asks.get(messageKey)
    if (ask === undefined) asks.set(messageKey, { at, keys: [key] })
    else {
      ask.at = Math.min(ask.at, at)
      ask.keys.push(key)
    }
  }
  if (asks.size === 0) return NO_PACING_HOLD

  const ordered = [...asks.values()].sort((a, b) => a.at - b.at)
  const last = ordered[ordered.length - 1]
  const isAnswered = (key: IntentionKey): boolean =>
    INTENTION_DEFINITION_BY_KEY[key].isSatisfied(input.facts)
  const lastAskedAnswered = last.keys.every(isAnswered)
  const allAnswered = ordered.every((ask) => ask.keys.every(isAnswered))

  const sinceFirstAsk = input.inboundMessages
    .filter((m) => m.at.getTime() > ordered[0].at)
    .map((m) => m.body ?? '')
  const askedUsSomething = sinceFirstAsk.some(looksLikeQuestion)
  const medianWords = median(sinceFirstAsk.map(wordCount))
  const engaged =
    allAnswered &&
    (askedUsSomething ||
      (medianWords !== null && medianWords >= ENGAGED_MEDIAN_WORDS))

  let hold: PacingHold = 'none'
  if (!lastAskedAnswered) hold = 'open_question'
  else if (asks.size >= PACED_QUESTIONS_PER_CONVERSATION_ENGAGED)
    hold = 'engaged_cap'
  else if (asks.size >= PACED_QUESTIONS_PER_CONVERSATION && !engaged)
    hold = 'conversation_cap'

  return {
    hold,
    askedThisConversation: asks.size,
    lastAskedKeys: last.keys,
    lastAskedAnswered,
    engaged,
    engagedSignals: { allAnswered, askedUsSomething, medianWords },
  }
}

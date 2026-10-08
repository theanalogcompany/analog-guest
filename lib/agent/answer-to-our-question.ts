/**
 * A short answer to something we said is read against what we said.
 *
 * THE INCIDENT (phone test, 2026-10-07). "how do i brew your beans" got a
 * reply that left the guest a choice of bean, the guest wrote "budan", and
 * the turn was classified `unknown`, held, and drafted as a product link.
 * "the karak chai", answering "what did you try there?" two days earlier, was
 * the same shape. A one-word answer carries no meaning of its own: all of it
 * is in the exchange it answers.
 *
 * Two pure decisions live here, one per stage that read the word alone. Both
 * apply to the same turn: a message of at most SHORT_ANSWER_MAX_WORDS words
 * that does not read as a question, arriving when the last thing said was
 * ours. A second message in the same burst is not that turn (the first one is
 * then the last thing said), and both decisions stand aside.
 *
 * 1. THE CLASSIFIER'S TIE (`resolveAnswerTie`). The classifier prompt now
 *    says how to read such an answer (jev-v1.5.0), and that moved `unknown`
 *    out of the running. What it left is a split between the two categories
 *    the sentence names: reply 0.36 against new_question 0.34 is a confidence
 *    of about 0.3, and the confidence floor turns anything under 0.3 into
 *    `unknown`. So the floor was rerouting a classifier that knew what the
 *    message was and could not choose between two names for it. Under the
 *    floor, when the pick is `reply` or `new_question` and the runner-up is
 *    conversational too, the turn keeps out of `unknown`. It runs as
 *    `new_question` when that is either of the two, because the only reason
 *    that category is in the running for a message with no question in it is
 *    that it continues one; otherwise as the classifier's own `reply`.
 *    Everything else under the floor is `unknown`, as before.
 *
 *    Measured with the new wording and no rule: the real thread 1 in 5
 *    `unknown`, "chikka" after "Which beans do you have?" 5 in 5. With a rule
 *    for reply against new_question only, the second was still 1 in 10: reply
 *    0.31 against casual_chatter 0.24. Hence the wider runner-up set.
 *
 * 2. THE RETRIEVAL QUERY (`answerQuery`). Knowledge retrieval searched with
 *    the bare message and with the last two turns in front of it. "budan"
 *    alone fetched what Budan tastes like and what a bag costs, and the
 *    contextual arm, which carries our whole reply, ranked the Malenad row
 *    first because the reply quoted it nearly word for word. On this turn a
 *    third arm searches with what the guest had asked, the question we put
 *    back if we put one, then their answer. With it the Budan brewing row is
 *    in the slate on the real thread and first on the three constructed ones.
 *
 *    THE GUEST'S OWN QUESTION IS IN IT. The ruling (2026-10-07) was "our
 *    question and their answer", and the real thread's reply left a choice
 *    without a question mark ("Depends on which beans"), so there was no
 *    question of ours to combine.
 *
 *    IT IS ADDED TO THE BARE ARM, NOT PUT IN ITS PLACE, which the same ruling
 *    asked for ("not the bare word") and which was built first. A short
 *    message after a reply of ours is not always an answer: with the bare arm
 *    replaced, "whats the wifi password" lost the Wi-Fi row and "just got a
 *    cortado" lost every cortado row, each to four rows about brewing beans.
 *    Nothing here can tell those from "budan" (`looksLikeQuestion` catches
 *    "do you have decaf" and misses "whats"), so the bare arm stays first and
 *    its top two survive the interleave, as lib/agent/CLAUDE.md requires. The
 *    cost is one slot: the contextual arm keeps its first result only.
 *
 * Pure: no DB, no model call. Check: `npm run measure-answer-to-our-question`.
 */
import type { MessageCategory } from '@/lib/ai/types'
import { looksLikeQuestion } from './looks-like-question'
import { contextTurns, MAX_CONTEXT_BODY_CHARS } from './retrieval-context'
import type { RuntimeContext } from './types'

/**
 * The longest message still read as "a short answer". A name, an item, a day,
 * "yes" or "the second one" all fit; a sentence of the guest's own does not,
 * and searches well enough by itself. A choice, stated here rather than
 * measured.
 */
export const SHORT_ANSWER_MAX_WORDS = 4

/**
 * A few words that do not read as a question. Guests here drop the question
 * mark as often as not ("do you have decaf"), so the mark alone would call a
 * short new question an answer; `looksLikeQuestion` also reads the opener.
 */
function isShortAnswer(body: string): boolean {
  const answer = body.trim()
  if (answer.length === 0 || looksLikeQuestion(answer)) return false
  return answer.split(/\s+/).length <= SHORT_ANSWER_MAX_WORDS
}

/** The last two things said in this conversation, when the newest was ours. */
function exchangeBeforeThisMessage(
  ctx: RuntimeContext,
): { theirs: string | null; ours: string } | null {
  const turns = contextTurns(ctx, 2)
  const last = turns[turns.length - 1]
  if (last === undefined || last.direction !== 'outbound') return null
  const before = turns.length === 2 ? turns[0] : undefined
  return {
    theirs: before?.direction === 'inbound' ? before.body : null,
    ours: last.body,
  }
}

/**
 * The last question in a reply of ours, or null when it asked nothing.
 *
 * Read sentence by sentence, so a link with a query string is not a question
 * and "$4.50" does not cut one in half. A question of one or two words
 * ("Which one?", or the "5?" left when "No. 5?" splits) is returned with the
 * sentence in front of it, because by itself it says nothing to search with.
 */
function lastQuestionIn(body: string): string | null {
  const sentences = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i]!
    if (!/[a-z0-9][^a-z0-9]*\?+$/i.test(sentence)) continue
    const short = sentence.split(/\s+/).length < 3
    return short && i > 0 ? `${sentences[i - 1]} ${sentence}` : sentence
  }
  return null
}

const capped = (body: string) =>
  body
    .replace(/\s*\n\s*/g, ' ')
    .trim()
    .slice(0, MAX_CONTEXT_BODY_CHARS)

/**
 * The first retrieval arm's query for a short message that follows a reply of
 * ours: what they had asked, the question we put back if we put one, then
 * their answer. Returns '' when this is not that turn, and the caller
 * searches with the message as it always has.
 */
export function answerQuery(ctx: RuntimeContext): string {
  const answer = ctx.currentMessage?.body.trim() ?? ''
  if (!isShortAnswer(answer)) return ''
  const exchange = exchangeBeforeThisMessage(ctx)
  if (exchange === null) return ''
  const question = lastQuestionIn(exchange.ours)
  if (exchange.theirs === null && question === null) return ''
  return [exchange.theirs, question, answer]
    .filter((part): part is string => part !== null)
    .map(capped)
    .join('\n')
}

const ANSWER_CATEGORIES: readonly MessageCategory[] = ['reply', 'new_question']

/** What an answer can also look like to a classifier that half-reads it. */
const CONVERSATIONAL_CATEGORIES: readonly MessageCategory[] = [
  ...ANSWER_CATEGORIES,
  'casual_chatter',
  'acknowledgment',
]

/**
 * The category a turn under the confidence floor runs as when the classifier
 * is torn over an answer rather than lost, or null when the floor applies as
 * it always has. See the header, decision 1.
 *
 * Null whenever the runner-up is not known, which is every Haiku fallback
 * turn: that arm reports one category and a self-scored confidence.
 */
export function resolveAnswerTie(
  ctx: RuntimeContext,
  category: MessageCategory,
  runnerUpCategory: MessageCategory | undefined,
): MessageCategory | null {
  if (runnerUpCategory === undefined) return null
  if (!ANSWER_CATEGORIES.includes(category)) return null
  if (!CONVERSATIONAL_CATEGORIES.includes(runnerUpCategory)) return null
  if (!isShortAnswer(ctx.currentMessage?.body ?? '')) return null
  if (exchangeBeforeThisMessage(ctx) === null) return null
  return category === 'new_question' || runnerUpCategory === 'new_question'
    ? 'new_question'
    : category
}

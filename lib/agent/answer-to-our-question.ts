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
 * with no question in it, arriving when the last thing said was ours.
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
 * 2. THE RETRIEVAL QUERY (`answerQuery`). Knowledge retrieval's first arm
 *    searched with the bare message, so "budan" fetched what Budan tastes
 *    like and what a bag costs. On this turn that arm searches with what the
 *    guest had asked, the question we put back if we put one, then their
 *    answer (ruled 2026-10-07: "combines our question and their answer, not
 *    the bare word"). The contextual arm is untouched.
 *
 *    THE GUEST'S OWN QUESTION IS IN IT, which the ruling did not ask for, and
 *    the real thread is why. Its reply left a choice without a question mark
 *    ("Depends on which beans"), so there was no question of ours to combine;
 *    and the contextual arm, which carries that whole reply, ranked the
 *    Malenad row first because the reply quoted it nearly word for word. With
 *    "how do i brew your beans" then "budan", the Budan brewing row is first
 *    on that thread and on the three constructed ones.
 *
 *    A thanks or an "ok" is a short message after a reply of ours too. There
 *    the arm searches with what they had asked, which the contextual arm
 *    already does, in place of a bare "thanks" that matches nothing.
 *
 * Pure: no DB, no model call. Check: `npm run measure-answer-to-our-question`.
 */
import type { MessageCategory } from '@/lib/ai/types'
import { contextTurns, MAX_CONTEXT_BODY_CHARS } from './retrieval-context'
import type { RuntimeContext } from './types'

/**
 * The longest message still read as "a short answer". A name, an item, a day,
 * "yes" or "the second one" all fit; a sentence of the guest's own does not,
 * and searches well enough by itself. A choice, stated here rather than
 * measured.
 */
export const SHORT_ANSWER_MAX_WORDS = 4

/** A few words with no question in them. */
function isShortAnswer(body: string): boolean {
  const answer = body.trim()
  if (answer.length === 0 || answer.includes('?')) return false
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

/** The last question in a reply of ours, or null when it asked nothing. */
function lastQuestionIn(body: string): string | null {
  const questions = body.match(/[^.!?\n]*\?/g)
  const last = questions?.[questions.length - 1]?.trim()
  return last === undefined || last.length <= 1 ? null : last
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

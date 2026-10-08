/**
 * The length check on an answer to a simple question. A BACKSTOP, not the
 * thing that keeps replies short.
 *
 * WHY IT EXISTS. The owner of the pilot venue read the live replies on
 * 2026-10-07 and would not go live on them: "what's filter coffee?" came back
 * as 56 words of definition. The length guide said "two sentences at most" and
 * every one of those replies obeyed it, with the facts strung along commas. A
 * prompt cannot count the words in its own output, so the count is taken here.
 *
 * WHY IT IS ONLY A BACKSTOP (ruled 2026-10-07, after the first measurement).
 * Set at the team's p75 it fired on a third of question turns, and one retry
 * dropped a step from brewing instructions. "No cutting for the sake of
 * cutting": the prompt and the venue's measured profile do the shortening,
 * and this catches only an answer longer than nine in ten of the team's own.
 *
 * WHAT IT DOES. When an answer to a simple question runs past the venue's
 * ceiling, generateMessage asks once more for the same answer in fewer words.
 * The retry ships only if it is shorter AND kept every fact (keepsTheFacts);
 * otherwise the first answer ships as written. Nothing is ever trimmed.
 *
 * IT NEVER FIRES WHEN THE GUEST NEEDS A FULLER ANSWER: a how-to, an event or
 * catering or wholesale inquiry, several questions at once, a follow-up on the
 * same topic, or a guest who asked for more. See needsFullerAnswer.
 *
 * NO NUMBER IN THIS FILE. How long a venue's replies run is that venue's
 * style, measured from the replies its team actually sent. A venue with no
 * profile has no ceiling and the check does nothing.
 *
 * Pure, no I/O. Imported by path, like emoji-cadence.ts.
 */

import type { BrandPersona } from '@/lib/schemas'
import type { MessageCategory } from './types'

/** A venue's chosen reply lengths, in words, from its measured profile. */
export interface ReplyLengthProfile {
  /** Past this an answer to a simple question is asked for again. */
  maxWords: number
  /** How long the team's replies usually are. Rendered in the prompt. */
  typicalWords: number
}

/**
 * The venue's figures, as stored on its measured profile. Null when the venue
 * has no profile, or one with no length check chosen.
 */
export function replyLengthProfileOf(
  persona: Pick<BrandPersona, 'voiceProfile'>,
): ReplyLengthProfile | null {
  return persona.voiceProfile?.replyLength ?? null
}

/** Sticky for the rest of the call, so worded as a standing rule. */
export function shorterReplyConstraint(profile: ReplyLengthProfile): string {
  return `Constraint: this reply says the same thing in fewer words, ${profile.maxWords} at the very most, which is as long as this venue's own replies get. Every fact, name, number, link and step stays. Tighten the wording only.`
}

/**
 * Did the retry keep what the first answer said? Read off the text, with no
 * model call: every number, every link, and every named thing in the first
 * answer has to be in the retry.
 *
 * A named thing is a capitalised word that is not opening a sentence, which
 * is how a product, a place or a person shows up in a reply. That misses a
 * fact carried by ordinary lowercase words, so this is a floor on "kept every
 * fact" and not the whole of it. It errs toward shipping the first answer,
 * which is the direction the ruling asks for.
 */
export function keepsTheFacts(first: string, retry: string): boolean {
  const kept = retry.toLowerCase()
  const numbers = first.match(/\$?\d[\d.,:]*\d|\d/g) ?? []
  const links = first.match(/\b[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/g) ?? []
  const named: string[] = []
  for (const sentence of first.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.split(/\s+/).slice(1)
    for (const word of words) {
      const bare = word.replace(/^[^\p{L}]+|[^\p{L}\p{N}'’-]+$/gu, '')
      if (/^\p{Lu}/u.test(bare) && bare.length > 1) named.push(bare)
    }
  }
  return [...numbers, ...links, ...named].every((piece) =>
    kept.includes(piece.toLowerCase().replace(/[.,:]+$/, '')),
  )
}

/**
 * The turns where the guest asked the venue something. A complaint, a thanks,
 * small talk and a guest answering our own question are not here: on those the
 * length belongs to recognition, an apology or the conversation, and the rules
 * for each already say how long.
 */
const QUESTION_CATEGORIES: ReadonlySet<MessageCategory> = new Set([
  'new_question',
  'recommendation_request',
  'personal_history_question',
  'perk_inquiry',
  'event_question',
])

/** The exchange before this message: what the guest wrote and what we said. */
export interface PreviousExchange {
  guest: string
  reply: string
}

const fold = (text: string): string => text.toLowerCase().replace(/[‘’]/g, "'")

// The guest said so in words.
const ASKS_FOR_MORE =
  /\b(tell me (more|about|everything)|more about|more info|explain|in detail|details?|the story|history|background|walk me through|step by step|what (all |else )?do you (have|sell|serve|offer|carry)|what (kinds? of |sort of )?\w+ do you (have|sell|serve|offer|carry)|what's (on )?the menu|what is (on )?the menu|list|options|everything|difference between|compare)\b/

// A question about doing something: the answer is steps, not a fact.
const HOW_TO =
  /\b(how (do|can|could|should|would|does|did) (i|we|you|one|it|they)|how to|how is it (made|brewed)|how are (they|these|those) (made|brewed)|what's the (best )?way to|what is the (best )?way to|what do i need to|where do i (start|sign|book|order)|steps?|instructions?|recipe|ratio)\b/

// Arranging something with the venue: there are specifics to ask for and give.
const ARRANGING =
  /\b(cater\w*|wholesale|bulk|partner\w*|collab\w*|sponsor\w*|pop-?up|private (event|party|booking)|book(ing)? (the|a|your)|host (a|an|our|my)|rent (the|your)|event for|for \d+ (people|guests|ppl))\b/

const INTERROGATIVE =
  /\b(what|when|where|which|who|why|how|do you|does|is there|are there|are you|can i|can you|could you|will you)\b/g

/** Two or more things asked in one message. */
function asksSeveralThings(inbound: string): boolean {
  if ((inbound.match(/\?/g) ?? []).length >= 2) return true
  // One question mark, or none, but two askings joined: "do you have oat milk
  // and is there parking".
  const parts = inbound.split(/\b(?:and|also|plus)\b|[,;.!?]/)
  return parts.filter((p) => p.search(INTERROGATIVE) !== -1).length >= 2
}

const STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'been',
  'does',
  'from',
  'have',
  'here',
  'just',
  'like',
  'much',
  'some',
  'that',
  'them',
  'then',
  'there',
  'they',
  'this',
  'what',
  'when',
  'where',
  'which',
  'will',
  'with',
  'would',
  'your',
  'yours',
])

function contentWords(text: string): Set<string> {
  return new Set(
    (text.match(/[\p{L}]{4,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w)),
  )
}

/**
 * The guest is digging in: another question on what the last exchange was
 * about. Read two ways, because a follow-up rarely repeats its subject: it
 * shares a content word with what the guest asked or what we answered, or it
 * leans on that exchange for its subject ("and how long does it keep?").
 */
function digsIn(inbound: string, previous: PreviousExchange | null): boolean {
  if (previous === null) return false
  // Only after a real question and answer. A greeting and a welcome is not a
  // topic to dig into.
  if (
    !previous.guest.includes('?') &&
    previous.guest.search(INTERROGATIVE) === -1
  )
    return false
  const asked = inbound.includes('?') || inbound.search(INTERROGATIVE) !== -1
  if (!asked) return false
  const before = new Set([
    ...contentWords(previous.guest),
    ...contentWords(previous.reply),
  ])
  const shares = [...contentWords(inbound)].some((w) => before.has(w))
  const leans =
    /^(and|so|but|ok(ay)?[, ]+(and|so)?|what about|how about|why)\b/.test(
      inbound.trim(),
    ) || /\b(it|that|those|these|them|this one|that one)\b/.test(inbound)
  return shares || leans
}

export type FullerAnswerReason =
  'asked_for_more' | 'how_to' | 'arranging' | 'several_questions' | 'digging_in'

/**
 * Does this guest need more than the venue's usual line? Ruled 2026-10-07: a
 * how-to, an event, catering, partnership or wholesale inquiry, a message
 * asking two or more things, and a follow-up on the same topic all do, whether
 * or not the guest says "tell me more".
 *
 * Decided from the turn's category AND the message, never from a phrase list
 * alone: an `event_question` is one by its category whatever its wording, and
 * the message is read for the rest. Null means the usual ceiling applies.
 *
 * WRONG IN THE CHEAP DIRECTION when it is wrong. A false yes leaves a long
 * reply alone, which is what happened before this file existed. A false no
 * asks once for tighter wording and ships it only if no fact went missing.
 */
export function needsFullerAnswer(input: {
  category: MessageCategory
  inbound: string
  previous: PreviousExchange | null
}): FullerAnswerReason | null {
  const text = fold(input.inbound)
  if (ASKS_FOR_MORE.test(text)) return 'asked_for_more'
  if (input.category === 'event_question' || ARRANGING.test(text)) {
    return 'arranging'
  }
  if (HOW_TO.test(text)) return 'how_to'
  if (asksSeveralThings(text)) return 'several_questions'
  if (
    digsIn(
      text,
      input.previous && {
        guest: fold(input.previous.guest),
        reply: fold(input.previous.reply),
      },
    )
  ) {
    return 'digging_in'
  }
  return null
}

/**
 * Words the guest reads. A link is not counted: it is one thing to tap however
 * long it is, and an answer that is a line and a link is a short answer.
 */
export function countReplyWords(body: string): number {
  return body
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

/**
 * What the check did on one generateMessage call.
 *
 *   none                within the venue's length, or not a turn it reads
 *   shortened           asked again; the second is inside the ceiling and
 *                       kept the facts, so it ships
 *   shorter_still_long  the same, but still past the ceiling
 *   kept_first          asked again; the second was no shorter, the first ships
 *   kept_first_content  asked again; the second lost a fact, the first ships
 *   no_attempt_left     ran long on the call's last attempt, shipped as written
 */
export type ReplyLengthRetry =
  | 'none'
  | 'shortened'
  | 'shorter_still_long'
  | 'kept_first'
  | 'kept_first_content'
  | 'no_attempt_left'

export interface ReplyLengthInput {
  /** The answer alone: no getting-to-know-you question, review ask or offer line. */
  answer: string
  category: MessageCategory
  /** The guest's message this turn. Null on a turn nobody wrote in to. */
  inbound: string | null
  /** The exchange before it in this conversation, when there was one. */
  previous: PreviousExchange | null
  /** A gap draft is written for an operator, who needs the whole guess. */
  knowledgeGap: boolean
}

export type ReplyLengthVerdict =
  | 'no_profile'
  | 'not_a_question'
  | 'knowledge_gap'
  | 'needs_fuller_answer'
  | 'within_length'
  | 'too_long'

export function checkReplyLength(
  input: ReplyLengthInput,
  profile: ReplyLengthProfile | null,
): {
  verdict: ReplyLengthVerdict
  words: number
  /** Why this guest's answer is not checked, when that is the reason. */
  fuller: FullerAnswerReason | null
} {
  const words = countReplyWords(input.answer)
  if (profile === null) return { verdict: 'no_profile', words, fuller: null }
  if (input.inbound === null || !QUESTION_CATEGORIES.has(input.category)) {
    return { verdict: 'not_a_question', words, fuller: null }
  }
  if (input.knowledgeGap) {
    return { verdict: 'knowledge_gap', words, fuller: null }
  }
  const fuller = needsFullerAnswer({
    category: input.category,
    inbound: input.inbound,
    previous: input.previous,
  })
  if (fuller !== null) return { verdict: 'needs_fuller_answer', words, fuller }
  return {
    verdict: words > profile.maxWords ? 'too_long' : 'within_length',
    words,
    fuller: null,
  }
}

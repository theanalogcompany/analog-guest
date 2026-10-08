/**
 * A guest's message that closes an exchange and asks for nothing: "ok",
 * "thanks", a thumbs up. Not every one needs a reply.
 *
 * Ruled 2026-10-07, from the pilot venue's own Instagram history: after a
 * message of the team's, a guest sent one of these and the team mostly let it
 * go (the count is on the venue, `voiceProfile.closes`, and in the PR). The
 * agent answered every one, and "ok" got "Great." or the opening hours. So
 * for a venue whose team mostly lets these go, the agent now sends nothing.
 *
 * SILENCE IS THE EXPENSIVE DIRECTION, so every doubt replies as normal, and
 * the list of doubts is most of this file. A guest who gets a short reply
 * they did not need has lost nothing; a guest who said "sure" to an offer
 * and heard nothing has.
 *
 * WHAT IS A CLOSE IS NARROW ON PURPOSE.
 *   - "yes", "sure", "perfect", "great" are NOT closes. They are answers and
 *     reactions: to an offer, to "how is it so far?", to a recommendation.
 *   - An emoji counts only if it is one of a few that mean "got it" or
 *     "thanks". A thumbs down, a crying face or a wave is not a close.
 *   - One more word, a question mark in any script, or an unhappy face on
 *     the end, and it is not a close.
 *
 * IT STANDS DOWN WHERE A TIMER IS WAITING ON OUR REPLY. The warm close and
 * the visit check-back both fire only when OUR message is the newest in the
 * thread. A silenced "thanks" leaves the guest's message newest, which would
 * cancel a sign-off, a review invitation or a check-back armed by an earlier
 * turn. So a guest in their first conversation, and a guest with a visit
 * check-in today, are replied to as before. Lifting that needs the two timers
 * to see past a silenced close, which is its own change and its own ruling.
 *
 * WHAT THE HISTORY DOES NOT SHOW. A reaction (a heart on the message) is not
 * in the import, so "unanswered" includes messages the team reacted to. And
 * three kinds the ruling named had too few cases to measure and are NOT
 * skipped: "see you tomorrow", "haha", and a lone emoji.
 *
 * `pureCloseKind` is shared with scripts/lib/voice-profile.ts, which counts
 * the team's habit. The count there is of closes by their wording after a
 * message of the team's that asked nothing; the further doubts below (an open
 * promise, a check-in, a first conversation) are not knowable from an import,
 * so the stored share describes the kind of message, not every skip.
 *
 * Pure, no I/O.
 */

export type PureCloseKind = 'ok' | 'thanks' | 'emoji_only'

const OK =
  /^(ok|okay|okk+|k|kk|cool|got it|gotcha|(that )?sounds (good|great)|alright|noted|ok cool|ok great|ok thanks|okay thanks|ok thank you)$/
const THANKS =
  /^(thanks|thank you|thankyou|thx|ty|tysm|thank u|many thanks|thanks again)( guys| team| so much| a lot)?$/

/** The emoji that say "got it" or "thanks" and nothing else. */
const CLOSING_EMOJI = /^(?:👍|🙏|❤️?|🧡|💛|💚|💙|💜|🤍|🫶|🙌|👌|😊|☺️?|✅|🤝)$/u

/** Emoji with their modifiers, one match per emoji as typed. */
const EMOJI =
  /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic})*/gu

/** A question mark in any script, or a typed unhappy face. */
const NOT_A_CLOSE = /[?？؟¿]|[:;]-?[(/\\|]|>:|:'\(/

/**
 * Which kind of pure close this message is, or null when it is anything else.
 * The whole message has to be the close.
 */
export function pureCloseKind(body: string): PureCloseKind | null {
  const text = body.trim()
  if (text === '' || NOT_A_CLOSE.test(text)) return null
  const emoji = text.match(EMOJI) ?? []
  // Every emoji in it has to be a closing one: "ok" with an angry face on the
  // end is not "ok".
  if (!emoji.every((e) => CLOSING_EMOJI.test(e))) return null
  const words = text
    .replace(EMOJI, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (words === '') {
    // Nothing but closing emoji. Punctuation alone ("...", "!") is not one.
    return emoji.length > 0 && emoji.length <= 3 ? 'emoji_only' : null
  }
  if (OK.test(words)) return 'ok'
  if (THANKS.test(words)) return 'thanks'
  return null
}

/** At or past this share of closes left unanswered, the team's habit is silence. */
const MOSTLY = 0.5
/** Fewer closes than this in the history is not a habit anyone can read. */
const ENOUGH_TO_READ = 20

export type PureCloseDecision =
  | { reply: true; why: PureCloseReplyReason }
  | { reply: false; kind: PureCloseKind }

export type PureCloseReplyReason =
  | 'no_measured_habit'
  | 'team_usually_replies'
  | 'not_an_acknowledgment'
  | 'crisis'
  | 'praise'
  | 'carries_media'
  | 'not_a_pure_close'
  | 'nothing_of_ours_before_it'
  | 'answering_us'
  | 'open_commitment'
  | 'visit_checkin_today'
  | 'first_conversation'
  | 'kind_not_measured'

export function decidePureClose(input: {
  /** The turn's category. Only an acknowledgment can be skipped. */
  category: string
  crisisSafety: boolean
  /** The classifier read the message as praise for the visit. */
  praisedExperience: boolean
  body: string
  /** The guest also sent a photo or other attachment, or that could not be read. */
  hasMedia: boolean
  /**
   * The newest message in the thread before this one, when it is ours, reached
   * the guest, and is part of the current conversation. Null otherwise.
   */
  ourLastMessage: string | null
  /**
   * Our last message asked or offered something, so "ok" may be an answer.
   * The caller reads it with the repo's own two tests (looksLikeQuestion,
   * previousReplyOffered) rather than this file growing a third.
   */
  ourLastMessageAskedOrOffered: boolean
  /** A promise is open, or the read failed: "ok" may be confirming a visit. */
  hasOpenCommitment: boolean
  /** A visit check-in exists today: an answer and a check-back hang off it. */
  hasVisitCheckinToday: boolean
  /** The guest's first conversation: a warm close is owed after our reply. */
  firstConversation: boolean
  /** What the venue's team did with such closes, when it has been measured. */
  teamHabit: { seen: number; unansweredShare: number } | undefined
}): PureCloseDecision {
  const reply = (why: PureCloseReplyReason): PureCloseDecision => ({
    reply: true,
    why,
  })
  const habit = input.teamHabit
  if (habit === undefined || habit.seen < ENOUGH_TO_READ) {
    return reply('no_measured_habit')
  }
  if (habit.unansweredShare < MOSTLY) return reply('team_usually_replies')
  if (input.crisisSafety) return reply('crisis')
  if (input.category !== 'acknowledgment') return reply('not_an_acknowledgment')
  if (input.praisedExperience) return reply('praise')
  if (input.hasMedia) return reply('carries_media')
  const kind = pureCloseKind(input.body)
  if (kind === null) return reply('not_a_pure_close')
  // A lone emoji is recognised and counted, and not skipped yet: under this
  // definition the pilot venue's history has no case of one after a message
  // of the team's that asked nothing, so there is no habit to follow.
  if (kind === 'emoji_only') return reply('kind_not_measured')
  if (input.ourLastMessage === null) return reply('nothing_of_ours_before_it')
  if (input.ourLastMessageAskedOrOffered) return reply('answering_us')
  if (input.hasOpenCommitment) return reply('open_commitment')
  if (input.hasVisitCheckinToday) return reply('visit_checkin_today')
  if (input.firstConversation) return reply('first_conversation')
  return { reply: false, kind }
}

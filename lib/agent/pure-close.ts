/**
 * A guest's message that closes an exchange and asks for nothing: "ok",
 * "thanks", a lone emoji. Not every one needs a reply.
 *
 * Ruled 2026-10-07, from the pilot venue's own Instagram history. After a
 * message of the team's, a guest sent one of these 73 times; the team let 56
 * go unanswered, and answered 10 within a day. The agent answered every one,
 * and "ok" got "Great." or the opening hours. So for a venue whose team
 * mostly lets these go, the agent now sends nothing.
 *
 * ONE DEFINITION, USED TWICE. `pureCloseKind` and `isAnsweringUs` are what
 * scripts/lib/voice-profile.ts counts the team's habit with AND what the
 * inbound turn decides with, so the share stored on the venue describes
 * exactly the messages this skips.
 *
 * SILENCE IS THE EXPENSIVE DIRECTION, so every doubt replies as normal: a
 * question mark, anything beyond the bare words, a message that answers a
 * question of ours, an open promise the guest may be confirming, a turn the
 * classifier did not call an acknowledgment, a venue with no measured habit.
 * A guest who gets a short reply they did not need has lost nothing.
 *
 * WHAT THE HISTORY DOES NOT SHOW. A reaction (a heart on the message) is not
 * in the import, so "unanswered" here includes messages the team reacted to.
 * And two kinds the ruling named had too few cases to measure, so they are
 * NOT skipped: "see you tomorrow" (two in the history, neither after a
 * message of the team's) and "haha" (none).
 *
 * Pure, no I/O.
 */

export type PureCloseKind = 'ok' | 'thanks' | 'emoji_only'

const OK =
  /^(ok|okay|okk+|k|kk|cool|got it|gotcha|(that )?sounds (good|great)|perfect|great|awesome|nice|alright|sure|yes|yep|yeah|yup|done|will do|noted|ok cool|ok great|ok thanks|okay thanks|ok thank you)$/
const THANKS =
  /^(thanks|thank you|thankyou|thx|ty|tysm|thank u|many thanks|thanks again)( guys| team| so much| a lot)?$/

/**
 * Which kind of pure close this message is, or null when it is anything else.
 * The whole message has to be the close: one more word and it is not one.
 */
export function pureCloseKind(body: string): PureCloseKind | null {
  if (body.includes('?')) return null
  const text = body.trim()
  if (text === '') return null
  if (!/[\p{L}\p{N}]/u.test(text)) {
    // Nothing but emoji or punctuation, and short: a thumbs up, a heart.
    return [...text].length <= 12 ? 'emoji_only' : null
  }
  const words = text
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}️‍]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (OK.test(words)) return 'ok'
  if (THANKS.test(words)) return 'thanks'
  return null
}

/**
 * Is the guest answering something we asked? "yes" after "was it cold when
 * you picked it up?" is an answer, not a close. Read off our last message.
 */
export function isAnsweringUs(ourLastMessage: string): boolean {
  return ourLastMessage.includes('?')
}

/** At or past this share of closes left unanswered, the team's habit is silence. */
const MOSTLY = 0.5

export type PureCloseDecision =
  | { reply: true; why: PureCloseReplyReason }
  | { reply: false; kind: PureCloseKind }

export type PureCloseReplyReason =
  | 'no_measured_habit'
  | 'team_usually_replies'
  | 'not_an_acknowledgment'
  | 'crisis'
  | 'carries_media'
  | 'not_a_pure_close'
  | 'nothing_of_ours_before_it'
  | 'answering_our_question'
  | 'open_commitment'

export function decidePureClose(input: {
  /** The turn's category. Only an acknowledgment can be skipped. */
  category: string
  crisisSafety: boolean
  body: string
  /** The guest also sent a photo or other attachment. */
  hasMedia: boolean
  /**
   * The newest message in the thread before this one, when it is ours and
   * reached the guest. Null when there is none, or the guest wrote last.
   */
  ourLastMessage: string | null
  /** A promise is open, and "ok" may be the guest confirming they are coming. */
  hasOpenCommitment: boolean
  /** The share of such closes the venue's team left unanswered. */
  teamUnansweredShare: number | undefined
}): PureCloseDecision {
  const reply = (why: PureCloseReplyReason): PureCloseDecision => ({
    reply: true,
    why,
  })
  if (input.teamUnansweredShare === undefined) return reply('no_measured_habit')
  if (input.teamUnansweredShare < MOSTLY) return reply('team_usually_replies')
  if (input.crisisSafety) return reply('crisis')
  if (input.category !== 'acknowledgment') return reply('not_an_acknowledgment')
  if (input.hasMedia) return reply('carries_media')
  const kind = pureCloseKind(input.body)
  if (kind === null) return reply('not_a_pure_close')
  if (input.ourLastMessage === null) return reply('nothing_of_ours_before_it')
  if (isAnsweringUs(input.ourLastMessage))
    return reply('answering_our_question')
  if (input.hasOpenCommitment) return reply('open_commitment')
  return { reply: false, kind }
}

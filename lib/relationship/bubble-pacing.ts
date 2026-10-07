// Bubble cadence: how long each message of one v2 reply waits before it lands.
//
// v2 generation emits `messages: string[]` and every one of them is ready at
// the same instant, so with no pacing a three-bubble reply arrives as a single
// block. Three bubbles landing together is not what a person texting looks
// like, and bubble quality is something the judge scores per response - so the
// cadence has to be a rule, not an accident of when the model returned.
//
// NO IMPORTS, deliberately, same posture as lib/agent/split-message.ts. This is
// read by a 'use client' component in the playground today and by phase 6's
// dispatch when it lands (lib/relationship/CLAUDE.md), so it must carry no SDK
// init and nothing server-only. ONE definition of the cadence for both: two
// copies is the drift lib/agent/CLAUDE.md already pays for on the
// intention-question gate.
//
// WHY THE SCALE IS COMPRESSED. Real phone typing runs about 38 wpm, which is
// roughly 190 chars per minute, or 315 ms per character. At that rate a 60-char
// bubble takes 19 seconds. That is accurate and unusable, so the rate here is
// compressed by about 9x and capped.

/**
 * The one honest knob: milliseconds of apparent typing per character.
 *
 * CALIBRATED AGAINST THE CONSTANT WE ALREADY SHIP. v1's dispatch gap
 * (`INTER_BUBBLE_GAP_MS`, lib/agent/split-message.ts) is a flat 1500 ms, and
 * 1500 / 35 = 43 characters - a typical bubble. So this rule reproduces the
 * live pace at the median bubble length and only diverges at the ends, which is
 * the entire point of deriving the delay from length: a two-word bubble should
 * not take as long as a three-line one.
 */
export const MS_PER_CHAR = 35

/**
 * Floor, reached at 20 characters.
 *
 * A CHOICE, not a measurement. Below it the pause stops reading as someone
 * typing and starts reading as the two bubbles having been one.
 */
export const MIN_BUBBLE_DELAY_MS = 700

/**
 * Cap, reached at 100 characters.
 *
 * A CHOICE, not a measurement. It is also what bounds the whole reveal: with
 * MAX_BUBBLES_PER_RESPONSE-style replies of three, the worst case a reader
 * waits is twice this.
 */
export const MAX_BUBBLE_DELAY_MS = 3_500

/**
 * How long this bubble appears to take to type, clamped to the floor and cap.
 *
 * Length is measured on the trimmed text: leading or trailing whitespace is not
 * something anyone typed.
 */
export function typingDelayMsFor(text: string): number {
  const raw = text.trim().length * MS_PER_CHAR
  if (raw < MIN_BUBBLE_DELAY_MS) return MIN_BUBBLE_DELAY_MS
  if (raw > MAX_BUBBLE_DELAY_MS) return MAX_BUBBLE_DELAY_MS
  return raw
}

/**
 * Per-bubble delays for one reply, each measured from the bubble before it.
 *
 * INDEX 0 IS ALWAYS 0, matching v1's dispatch exactly (`if (index > 0)` in
 * scheduleAndSend). On the dispatch side the opening typing indicator already
 * covers the beat before the first bubble; in the playground the run has
 * already held the operator for 15-45 seconds behind a "running the turn"
 * strip, and charging them a typing delay on top of a wait they have already
 * sat through buys nothing.
 *
 * These are GAPS, not offsets from the start of the reply. A consumer that
 * schedules each reveal from the previous one gets no cumulative drift; one
 * that sums them into absolute offsets is reading them wrongly.
 */
export function bubbleDelaysFor(bubbles: readonly string[]): number[] {
  return bubbles.map((text, index) =>
    index === 0 ? 0 : typingDelayMsFor(text),
  )
}

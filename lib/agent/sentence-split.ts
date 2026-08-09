// TAC-319: deterministic message splitting. The model no longer decides
// whether a reply splits — two prompt-side rounds (v1.30.0 two-job test,
// canceled round 2) failed the same way: in a ~50k-char prompt, splitting was
// a decision the model was allowed to not make, and it reliably didn't. Now
// dispatch decides, with a fair coin.
//
// Pure module: the only import is ./split-message, which is itself
// dependency-free, so everything here loads in vitest with no SDK init (see
// CLAUDE.md "Module split for testability").
//
// The rule, per the TAC-319 round-3 ruling:
//   1. Strip any stray [[BREAK]] markers first — the model no longer controls
//      splitting, so its markers are noise.
//   2. Split into sentences (conservative detector below).
//   3. One sentence → send as-is, no flip.
//   4. Two or three sentences → one fair coin flip per message. Split → every
//      sentence is its own bubble, in order. No split → one block, unchanged.
//   5. Four or more sentences → NO flip, one block. The
//      MAX_BUBBLES_PER_RESPONSE cap would force partial grouping, which
//      violates all-or-nothing, and four bubbles in a row stops reading as
//      texting anyway.
//   6. No categories, no carve-outs. Every scheduleAndSend body rides this.

import { MAX_BUBBLES_PER_RESPONSE, collapseToSingleMessage } from './split-message'

/**
 * Probability that a 2–3 sentence body splits into per-sentence bubbles.
 * The future tuning knob — change this constant, nothing else.
 */
export const SPLIT_PROBABILITY = 0.5

/**
 * Tokens that end with a period WITHOUT ending a sentence, lowercased.
 * Multi-dot abbreviations appear with their internal dots ('a.m', not 'am')
 * because the token is captured up to, but not including, the final period.
 * Grow this list when a venue's copy surfaces a new one — a missing entry
 * splits mid-address, which a guest actually sees.
 */
const ABBREVIATIONS = new Set(['st', 'ave', 'dr', 'a.m', 'p.m', 'etc', 'vs'])

/**
 * A sentence opener is a capital letter, a digit, or an emoji.
 *
 * THE CAPITAL GATE IS DELIBERATE (TAC-319 ruling #2). Production sends
 * capitalize sentence starts, so requiring one here matches real output — and
 * the failure direction is the safe one: lowercase after a boundary means NO
 * split, which sends one slightly-long message instead of mangling a real one.
 * \p{Lu} rather than [A-Z] so accented capitals count.
 */
const SENTENCE_OPENER = /[\p{Lu}\p{N}\p{Extended_Pictographic}]/u

/**
 * Split a body into sentences, conservatively.
 *
 * A split point is `.` `?` or `!` followed by whitespace followed by a
 * sentence opener (capital/digit/emoji), except:
 *   - ellipsis: a `.` preceded by another `.` never ends a sentence, so
 *     'wait... Maybe' stays whole
 *   - abbreviations: a `.` whose preceding token is in ABBREVIATIONS never
 *     ends a sentence, so 'St. Marks' and '8 a.m. Tomorrow' stay whole
 *
 * Prices, decimals, ratios, and times ($7.95, 4.5 oz, 1:1, 7:30) are safe by
 * construction: their internal punctuation has no whitespace after it, and
 * `:` is not a split character at all.
 *
 * Terminal punctuation stays ON each sentence here — stripping is a separate
 * concern (stripTerminalPeriod) applied only to pieces that actually dispatch
 * as separate bubbles.
 */
export function splitIntoSentences(body: string): string[] {
  const sentences: string[] = []
  let start = 0
  const punct = /[.!?]/g
  let match: RegExpExecArray | null

  while ((match = punct.exec(body)) !== null) {
    const i = match.index

    // Must be followed by at least one whitespace character.
    let j = i + 1
    if (j >= body.length || !/\s/.test(body[j]!)) continue
    while (j < body.length && /\s/.test(body[j]!)) j += 1
    // Trailing whitespace with nothing after it: not a boundary.
    if (j >= body.length) continue

    // The next character must open a sentence. codePointAt so an emoji's
    // surrogate pair is tested whole, not as a broken half.
    const opener = String.fromCodePoint(body.codePointAt(j)!)
    if (!SENTENCE_OPENER.test(opener)) continue

    if (match[0] === '.') {
      // Ellipsis guard: the final dot of '...' is preceded by a dot. (The
      // earlier dots are followed by a dot, not whitespace, so they never
      // reach this check.)
      if (i > 0 && body[i - 1] === '.') continue

      // Abbreviation guard: the token immediately before this period,
      // including any internal dots ('a.m'), checked lowercased.
      const token = body.slice(start, i).match(/([A-Za-z]+(?:\.[A-Za-z]+)*)$/)
      if (token && ABBREVIATIONS.has(token[1]!.toLowerCase())) continue
    }

    const sentence = body.slice(start, i + 1).trim()
    if (sentence.length > 0) sentences.push(sentence)
    start = j
  }

  const tail = body.slice(start).trim()
  if (tail.length > 0) sentences.push(tail)
  return sentences
}

/**
 * Strip a split piece's terminal period. Sent texts don't end in periods, and
 * a piece that just became its own message shouldn't either.
 *
 * Only a SINGLE terminal `.` is stripped — `?` and `!` carry meaning and
 * stay, a terminal ellipsis is a deliberate trail-off and stays, and internal
 * punctuation (commas, colons, the .95 in $7.95) is never touched.
 */
export function stripTerminalPeriod(piece: string): string {
  if (piece.endsWith('.') && !piece.endsWith('..')) return piece.slice(0, -1)
  return piece
}

/**
 * The one entry point dispatch calls: body in, bubbles out.
 *
 * `rng` must return a number in [0, 1). It is a required parameter here so no
 * randomness hides inside the pure module — the caller supplies Math.random
 * at the boundary and tests inject a constant to pin either branch. It is
 * consulted exactly once, and only when the sentence count is in the
 * flippable range [2, MAX_BUBBLES_PER_RESPONSE].
 *
 * Returns [] for a body that is empty, whitespace-only, or nothing but stray
 * delimiter markers — same contract the TAC-313 splitter had, so the caller's
 * existing "no sendable bubbles" failure path is unchanged.
 */
export function resolveDispatchBubbles(body: string, rng: () => number): string[] {
  // Stray model-emitted [[BREAK]] markers (and near-misses) are noise now;
  // collapseToSingleMessage strips them and normalizes whitespace, keeping
  // the invariant that no delimiter ever reaches Sendblue or the database.
  const cleaned = collapseToSingleMessage(body)
  if (cleaned.length === 0) return []

  const sentences = splitIntoSentences(cleaned)
  if (sentences.length < 2 || sentences.length > MAX_BUBBLES_PER_RESPONSE) {
    return [cleaned]
  }

  if (rng() < SPLIT_PROBABILITY) {
    return sentences.map(stripTerminalPeriod)
  }
  return [cleaned]
}

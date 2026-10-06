import { URL_TOKEN_SPLITTER } from '@/lib/ai/url-detector'

// Em/en dash normalization for v2 generated messages (owner-ruled
// 2026-10-04): a dash becomes a sentence break, applied deterministically at
// the generation seam so dispatch, the playground, the judge and every
// harness all see what a guest would receive. The template's voice line asks
// the model for the same thing ("end the sentence and start a new one") -
// the v1 lesson that a substitution and its constraint text must agree
// (generate-message.ts, replaceDashes header).
//
// This is character-set normalization, not style enforcement - the one
// deliberate exception to v2's "style is judged, not legislated". It is
// sibling to v1's replaceDashes, not a reuse of it: v1 substitutes ', '
// because ITS constraint text asks for a comma, and its cleanup rules are
// comma-specific. The three edge cases v1 paid to find carry over:
//
//   1. URL tokens are left verbatim (a rewritten dash inside a link is a
//      broken link; URL_TOKEN_SPLITTER's capture group puts them at odd
//      indices).
//   2. A dash directly after existing punctuation drops instead of doubling
//      it ("sure! — anyway" -> "sure! anyway", never "sure! . anyway").
//   3. A substitution that would empty a non-empty message is REFUSED and
//      the original returned - a dash is a better outcome than silence.
//
// En dash is treated as punctuation only when SPACED (" – ", the iPhone
// clause break). Unspaced en dash is left alone: "3–5pm" must survive.
export function replaceDashesWithPeriod(text: string): string {
  const substituted = text
    .split(URL_TOKEN_SPLITTER)
    .map((segment, i) => {
      if (i % 2 === 1) return segment
      return segment
        .replace(/([.!?…,;:])\s*—\s*/g, '$1 ')
        .replace(/([.!?…,;:])\s+–\s+/g, '$1 ')
        .replace(/\s*—\s*/g, '. ')
        .replace(/\s+–\s+/g, '. ')
    })
    .join('')
    .replace(/^\.\s+/, '')
    .replace(/ {2,}/g, ' ')
    .trim()
  // Edge case 3: never trade a dash for an empty bubble.
  return substituted === '' && text.trim() !== '' ? text : substituted
}

// The hedged either/or question (owner-ruled 2026-10-05, an AI tell):
// "anything catch your eye, or want a nudge in a direction?" - a question
// that asks permission for its own alternative instead of committing. The
// ", or <alternative>?" tail drops, keeping the first question whole.
//
// Scope is the COMMA form only. "iced or hot?" and "the foam or the whole
// thing?" are genuine content choices a human asks; the comma before "or"
// is what marks the appended second question. The regression harness's
// either-or tell uses this same pattern (one definition), so a hit there
// means a shape this strip did not catch.
export const EITHER_OR_QUESTION = /,\s*or\s+[^?.!]*\?/i

export function stripEitherOrQuestion(text: string): string {
  const stripped = text
    .split(URL_TOKEN_SPLITTER)
    .map((segment, i) => {
      if (i % 2 === 1) return segment
      return segment.replace(/,\s*or\s+[^?.!]*\?/gi, '?')
    })
    .join('')
  // Same refusal as the dash rule: never trade a tell for an empty or
  // punctuation-only bubble.
  return /[a-z0-9]/i.test(stripped) ? stripped : text
}

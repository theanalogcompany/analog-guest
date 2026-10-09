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

// The emphatic "full stop" tag (owner-ruled 2026-10-09): "25 minutes is too
// long, full stop." It is a pure model tic, and it is normalized here rather
// than asked for in the prompt BECAUSE THE PROMPT WAS MEASURED AND DID
// NOTHING. `Never the phrase "full stop".` shipped in # Texting style first;
// a paired ablation over 8 complaint turns (that line present vs. that one
// sentence deleted from system block 1, everything else byte-identical) read
// 1/8 WITH the ban and the SAME 1/8 without it - the single breach was the
// same input in both arms, so the line had no effect where it had its only
// chance to fire. A no-ban sweep over 16 emphatic-grievance turns put the base
// rate at 1/16. The template line stays for the reason replaceDashesWithPeriod
// keeps its voice line - a substitution and its constraint text must agree -
// but it is NOT the mechanism and must not be credited as one.
//
// SCOPE IS THE EMPHATIC TAG, NOT THE WORDS. Three forms:
//
//   1. the comma appositive, which is every instance ever observed here
//      ("too long, full stop." / "that is on us, full stop")
//   2. its own sentence ("that is on us. Full stop.")
//   3. sentence-leading ("full stop, that is not okay")
//
// A BARE MID-SENTENCE "full stop" IS LEFT ALONE ON PURPOSE. That form is
// almost certainly the British name for a period ("ends with a full stop"),
// and rewriting it would change a fact rather than drop a tic. The word
// boundary on `stop` already spares "stopover" and "stoppage".
//
// No URL_TOKEN_SPLITTER pass, unlike its two siblings: they split because
// dashes and commas occur inside links, and "full stop" cannot - the
// whitespace in the middle means no URL token can contain it.
export function stripFullStop(text: string): string {
  const stripped = text
    // Its own sentence, before the comma form, so the terminator it keeps is
    // the one that preceded it.
    .replace(/([.!?…])\s*full\s+stop\s*[.!?]*/gi, '$1')
    // The comma appositive. Any following punctuation is left to carry the
    // sentence: "too long, full stop. I am sorry" -> "too long. I am sorry".
    .replace(/,\s*full\s+stop\b/gi, '')
    .replace(/^full\s+stop\b\s*[,.!?]?\s*/i, '')
    .replace(/ {2,}/g, ' ')
    .trim()
  // The same refusal the other two make: never trade a tic for an empty or
  // punctuation-only bubble.
  return /[a-z0-9]/i.test(stripped) ? stripped : text
}

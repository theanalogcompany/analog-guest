// TAC-362: per-message emoji cadence. The decision of whether THIS message
// carries an emoji is made here, in code, by a weighted coin — not by the
// model reading a frequency word.
//
// Pure module: the only import is `import type`, fully erased at compile
// time, so this loads in vitest with no SDK init (see CLAUDE.md "Module
// split for testability"). Same shape as its sibling self-talk-detector.ts.
//
// WHY CODE AND NOT A PROMPT RULE. Measured across every generated outbound
// in the database, grouped by RESPONSE (coalesce(generation_id, id) — a
// split response puts the emoji in the last bubble only, so per-ROW counting
// reads the first bubble as a clean miss and understates the determinism):
//
//   never       mock-central-perk       0 / 52
//   sparingly   mock-sextant            0 / 188
//   frequent    le-mils-coffee         10 / 11
//
// Two things follow, and they point in opposite directions:
//
//   1. The model obeys a per-message emoji instruction almost perfectly in
//      BOTH directions — 0 violations in 240 responses told not to use one,
//      10 of 11 compliance with a positive licence. So a binary directive is
//      a thing it reliably does.
//   2. It does NOT act on a FREQUENCY statement. Le Mil's prompt carried the
//      sentence "uses an emoji now and then, not in every text" on every one
//      of those turns and still produced 10/11, because "now and then" has no
//      referent inside a single generation: the model sees one message, with
//      no memory of whether it used one last time.
//
// That is the same failure TAC-319 paid for on message splitting — a
// judgment the model was allowed to not make, which it reliably didn't — and
// the same answer: move the judgment into Math.random() and hand the model
// only the binary it already complies with. Writing a better-worded
// "occasionally" would be the third attempt at (2).
//
// IMPORTANT about that sentence, because it is easy to misread as evidence of
// intent: it was NOT what the owner asked for. The Le Mil's transcript
// (1:15:22) has him saying "always use emojis... hit them with emojis until
// they're like why" — so `emojiPolicy: frequent` was a faithful capture and
// 10/11 was the system doing as instructed. The `tone` sentence corresponds
// to nothing in the transcript; extraction invented it, stating the opposite
// of what the interviewee said (see TAC-371). It is cited here ONLY as
// mechanism evidence — a frequency statement sat in the prompt and did not
// control behaviour — never as a record of what the venue wanted.

import type { BrandPersona } from '@/lib/schemas/brand-persona'

/**
 * Per-policy probability that a given message may carry an emoji.
 *
 * `null` means NO FLIP — no per-message block renders at all and the
 * persona's own standing `## Emojis` statement governs the turn unchanged.
 * That is a real decision per policy, not a missing value, which is why the
 * type is `number | null` rather than a number with 0 standing in for
 * "off": 0 would render a per-message prohibition on every turn, which is a
 * different prompt from the one those venues are measured on.
 *
 * - `never`     — null. Measured 0/52. The persona section already carries
 *                 an absolute prohibition and it works; adding a second
 *                 statement to a proven path buys nothing. This is also why
 *                 acceptance criterion "a venue set to no emoji gets none"
 *                 holds by construction here: `never` never reaches a coin.
 * - `sparingly` — null. DELIBERATE, and the most surprising entry in this
 *                 map. `sparingly` is empirically identical to `never`
 *                 (0/188): its guidance ends "Default to none" and the model
 *                 takes that literally. So the enum has three values and two
 *                 behaviours. That is a more durable finding than the bug
 *                 TAC-362 was filed about, and it is NOT fixed here — giving
 *                 `sparingly` a probability would take Mock Sextant from 0%
 *                 to ~a third of messages, a venue nobody asked to change
 *                 and whose owner never signed off on emoji. Bundling it
 *                 would also make a regression there indistinguishable from
 *                 this fix. Its own ticket, with its own evidence.
 * - `frequent`  — the flip, and 0.75 is A DELIBERATE SOFTENING OF A STATED
 *                 PREFERENCE, not a calibration toward a measured target.
 *                 The Le Mil's owner asked for MORE emoji, not fewer
 *                 ("always use emojis... hit them with emojis until they're
 *                 like why", transcript 1:15:22), and the pre-TAC-362
 *                 behaviour of ~91% was closer to that request than this is.
 *                 The product judgment — Jaipal's, recorded on TAC-362 — is
 *                 that literal compliance reads as a template rather than as
 *                 warmth, and that a guest seeing an emoji in every single
 *                 message reads a bot, so serving the intent behind the
 *                 instruction beats following it to the letter. Nothing was
 *                 measured to produce 0.75; do not read it as an attempt to
 *                 hit a number. It is also a CEILING rather than a target,
 *                 because 'allowed' is a licence the model can decline —
 *                 verified live at 35 permits across 48 generations (72.9%)
 *                 producing 32 emoji (66.7%). Labelled this plainly because
 *                 a guess that reads as a measurement is how
 *                 KNOWLEDGE_RELEVANCE_FLOOR = 0.5 survived unexamined until
 *                 TAC-358 found the distributions it sorted on ran the other
 *                 way.
 *
 *                 KNOWN CONSEQUENCE, recorded not fixed: there is now no
 *                 setting that means "an emoji in nearly every message".
 *                 `frequent` is the top of the enum and it caps at 0.75, so a
 *                 venue that genuinely wants what Le Mil's asked for cannot
 *                 express it. Nobody has asked for that yet.
 *
 * TUNING EMOJI FREQUENCY MEANS CHANGING THIS MAP. There is deliberately no
 * second named constant aliasing an entry — an alias with no readers is the
 * trap CLAUDE.md documents three times over, and it would point the next
 * person at a lever that moves nothing.
 */
export const EMOJI_PROBABILITY = {
  never: null,
  sparingly: null,
  frequent: 0.75,
} as const satisfies Record<BrandPersona['emojiPolicy'], number | null>

/**
 * What this one message may do about emoji.
 *
 * `'none'` is a flat per-message prohibition. `'allowed'` is permission for
 * at most one, never an instruction to include one — so the permitted
 * branch still varies naturally when nothing fits, and the failure
 * direction is fewer emoji than `p`, never more.
 */
export type EmojiDirective = 'none' | 'allowed'

/**
 * Flip the coin for one generation.
 *
 * `null` return = this policy doesn't vary per message (see
 * EMOJI_PROBABILITY); the caller renders no per-message block.
 *
 * `rng` is REQUIRED here and defaulted at the boundary instead — the same
 * split resolveDispatchBubbles uses, so this module stays pure and tests
 * can pin both branches without stubbing globals.
 */
export function resolveEmojiDirective(
  policy: BrandPersona['emojiPolicy'],
  rng: () => number,
): EmojiDirective | null {
  const probability = EMOJI_PROBABILITY[policy]
  // Read as: a null-probability policy must not consume the rng. A caller
  // threading one rng through several decisions would otherwise have its
  // sequence shifted by a venue's emoji setting, which is a spooky coupling
  // to debug.
  if (probability === null) return null
  return rng() < probability ? 'allowed' : 'none'
}

// Emoji detection. Deliberately ONE definition shared with the TAC-347
// deterministic voice grader (scripts/onboarding/grade-voice-deterministic.ts),
// which imported its own block-range regex until this module existed — same
// reasoning as TAC-366's filterByRelevance extraction: one definition of
// "emoji" across grader and runtime beats two that agree until they don't.
//
// The base is `Emoji_Presentation` (renders as an emoji by default) OR any
// `Extended_Pictographic` codepoint explicitly followed by U+FE0F (asking
// for emoji presentation). Extended_Pictographic ALONE is too broad and
// would be a false-positive machine: `®` `™` `©` `‼` `⁉` `ℹ` `▶` `Ⓜ` and the
// non-emoji arrows all carry it, so "Analog®" would be graded as an emoji
// at a `never` venue. `Emoji_Presentation` keeps the ones that matter (☕ ⌚
// 😊 🌸) and drops those.
//
// The trailing groups make a match consume the whole grapheme cluster —
// variation selector, keycap, skin-tone modifier, ZWJ-joined sequences — so
// a joined family counts as ONE emoji rather than as each of its parts.
// Regional-indicator pairs (flags) are matched separately: they carry no
// Extended_Pictographic codepoint at all, which is why the block-range regex
// this replaced listed them as a known gap.
//
// Known gap, stated rather than discovered later: a keycap built on an ASCII
// digit ("1️⃣") is not matched, because the digit is neither
// Emoji_Presentation nor Extended_Pictographic. The failure direction is a
// missed observation event, never a wrong send.
//
// No ReDoS exposure: every quantifier alternative has a disjoint first-set
// of single code units, each ZWJ iteration must start with U+200D which the
// inner classes cannot match, and the pattern has no mandatory trailing
// element to force backtracking. Measured linear (a 2000-link ZWJ chain and
// 100KB of non-emoji text both under a millisecond).
const EMOJI_BASE = '(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)'
const EMOJI_MODIFIERS = '(?:\\uFE0F|\\u20E3|[\\u{1F3FB}-\\u{1F3FF}])*'
const EMOJI_CLUSTER =
  EMOJI_BASE + EMOJI_MODIFIERS + '(?:\\u200D' + EMOJI_BASE + EMOJI_MODIFIERS + ')*'
const FLAG_SEQUENCE = '[\\u{1F1E6}-\\u{1F1FF}]{2}'

// Global flag, and only ever consumed through String.prototype.match below.
// Never call .test() on this: a /g regex carries lastIndex between calls and
// would return alternating answers for the same input. `match` with a global
// regex resets lastIndex per spec, which is why the exported API is
// count/contains functions rather than the regex itself.
const EMOJI_PATTERN = new RegExp(`${FLAG_SEQUENCE}|${EMOJI_CLUSTER}`, 'gu')

/** How many emoji (grapheme clusters, not codepoints) a body contains. */
export function countEmoji(body: string): number {
  return (body.match(EMOJI_PATTERN) ?? []).length
}

/** Whether a body contains at least one emoji. */
export function containsEmoji(body: string): boolean {
  return countEmoji(body) > 0
}

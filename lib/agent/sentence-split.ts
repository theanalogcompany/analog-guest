// TAC-319: deterministic message splitting. The model no longer decides
// whether a reply splits — two prompt-side rounds (v1.30.0 two-job test,
// canceled round 2) failed the same way: in a ~50k-char prompt, splitting was
// a decision the model was allowed to not make, and it reliably didn't. Now
// dispatch decides, with a fair coin.
//
// Pure module: the only import is ./split-message, which is itself
// dependency-free, so everything here loads with no SDK init.
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
//
// TAC-554 adds ONE carve-out to rule 6, and it is structural rather than a
// category: a getting-to-know-you question always goes out as its own message,
// last. Jaipal ruled it; a persona rule saying so failed twice on device on
// 2026-09-29, and the two failures show why wording could never have carried
// it. "nice! what variation did you go with? and by the way, what's your
// name?" is three sentences, so it rode the coin below and lost. "Foncii, nice
// to meet you 🙂 do you live or work around Polk Street?" has no `.?!` before
// "do", so splitIntoSentences returns ONE sentence and rule 3 sends it whole —
// that reply could not have split at any probability.
//
// So the question arrives here as its OWN STRING, `intentionTail`, already
// separated at generation (see composeReplyWithIntention in
// lib/ai/generate-message.ts). The boundary is never found in text: it is the
// join between two separately generated strings, which is why this cannot cut
// a sentence in half.

import {
  MAX_BUBBLES_PER_RESPONSE,
  MAX_PACKED_BUBBLES,
  collapseToSingleMessage,
} from './split-message'

/**
 * Probability that a 2–3 sentence body splits into per-sentence bubbles, for a
 * venue with no measured voice profile.
 */
export const SPLIT_PROBABILITY = 0.5

/**
 * How one venue's replies are cut into messages.
 *
 * For a venue with no measured voice profile this is the coin above and
 * nothing else, which is exactly the behaviour before 2026-10-07.
 */
export interface BubbleStyle {
  /** The coin for a two or three sentence reply that fits in one message. */
  splitProbability: number
  /**
   * No message runs longer than this many words. A reply past it is ALWAYS
   * split, coin or no coin. Absent: no such rule.
   */
  maxBubbleWords?: number
  /** The most messages one reply is cut into, where the words allow it. */
  maxBubbles?: number
  /** Start a split-off message with a capital, as this venue's team does. */
  capitalise?: boolean
}

export const DEFAULT_BUBBLE_STYLE: BubbleStyle = {
  splitProbability: SPLIT_PROBABILITY,
}

/**
 * A venue's style from its measured profile (ruled 2026-10-07). Every figure
 * is the team's own: how often they sent one answer as several messages, the
 * length nine in ten of their messages stay under, the most messages they
 * ever sent in one reply, and whether they start a message with a capital.
 *
 * THE COIN IS NOT THE SAME QUANTITY AS THE SHARE IT IS SET FROM. The measured
 * share is of all the team's replies; the coin is only consulted on a short
 * body the splitter can see two or three sentences in. So short replies go
 * out split less often than the team's do. Long ones are always split.
 *
 * Takes a structural type so this module stays import-free.
 */
export function bubbleStyleFor(
  measured:
    | {
        splitShare: number
        wordsPerBubble: { p90: number }
        bubblesPerReply: Record<string, number>
        lowercaseStartShare: number
      }
    | undefined,
): BubbleStyle {
  if (measured === undefined) return DEFAULT_BUBBLE_STYLE
  const most = Math.max(
    MAX_BUBBLES_PER_RESPONSE,
    ...Object.keys(measured.bubblesPerReply)
      .map(Number)
      .filter(Number.isFinite),
  )
  return {
    splitProbability: measured.splitShare,
    maxBubbleWords: measured.wordsPerBubble.p90,
    maxBubbles: Math.min(most, MAX_PACKED_BUBBLES),
    capitalise: measured.lowercaseStartShare <= 0.3,
  }
}

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
 * Does this piece carry anything a guest would read as a message?
 *
 * A bubble needs a letter or a digit. Punctuation or an emoji alone is not a
 * message, and the one way to get there is real: replaceDashes REFUSES a
 * substitution that would empty a non-empty string, so an intentionQuestion
 * containing only an em dash survives as "—" and would otherwise become its
 * own bubble containing a dash.
 */
export function hasRenderableContent(piece: string): boolean {
  return /[\p{L}\p{N}]/u.test(piece)
}

/**
 * Today's rule, with the bubble cap as a parameter.
 *
 * Extracted by TAC-554 so the tail path and the no-tail path run the SAME
 * logic and differ only in the cap. That is what makes "a turn with no
 * intention question is byte-identical to before" a property of the code
 * rather than a claim: the no-tail path calls this with the same text, the
 * same rng and the original cap.
 */
function splitToBubbles(
  text: string,
  rng: () => number,
  maxBubbles: number,
  style: BubbleStyle,
): string[] {
  if (
    style.maxBubbleWords !== undefined &&
    wordsIn(text) > style.maxBubbleWords
  ) {
    // The answer gives up a slot when a tail follows it, exactly as the coin
    // path does, so the reply as a whole stays inside the venue's most.
    const most =
      (style.maxBubbles ?? MAX_BUBBLES_PER_RESPONSE) -
      (MAX_BUBBLES_PER_RESPONSE - maxBubbles)
    return packWithin(
      text,
      style.maxBubbleWords,
      most,
      style.capitalise === true,
    )
  }
  const sentences = splitIntoSentences(text)
  if (sentences.length < 2 || sentences.length > maxBubbles) return [text]
  if (rng() < style.splitProbability) return sentences.map(stripTerminalPeriod)
  return [text]
}

/**
 * Words a guest reads, counted the way the venue's limit was measured
 * (scripts/lib/voice-profile.ts): a link is not a word, and neither is a
 * token with no letter or digit in it, like an emoji on its own.
 */
function wordsIn(text: string): number {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

/**
 * Cut a sentence that is too long for one message at its clause boundaries:
 * after a comma, semicolon or colon, and before a joining word. Never between
 * two numbers ("2, 3 tbsp" is one quantity, the comma standing in for a dash).
 * Each piece keeps its own punctuation, so joining them back gives the
 * sentence unchanged.
 */
function splitIntoClauses(sentence: string): string[] {
  return sentence
    .split(/(?<=(?<!\d)[,;:])\s+|\s+(?=(?:and|but|or|so|then|because|which)\s)/)
    .filter((c) => c.trim() !== '')
}

/**
 * A reply too long for one message, cut into messages of at most `maxWords`
 * (ruled 2026-10-07: no single message longer than nine in ten of the team's
 * own). NOTHING IS REMOVED OR REWORDED: every word of the reply is in exactly
 * one message, in order.
 *
 *   1. One message per sentence.
 *   2. A sentence over the limit is cut at its clauses, packed greedily.
 *   3. A clause over the limit on its own is cut at the word, the last resort.
 *   4. A scrap of one or two words rides with a neighbour when that fits.
 *   5. Past `maxMessages`, the two shortest neighbours are joined, first only
 *      where the join still fits the word limit.
 *
 * THE MESSAGE COUNT WINS OVER THE WORD LIMIT, and only at step 5's end: a
 * reply too long for `maxMessages` messages of `maxWords` joins neighbours
 * past the word limit rather than send more messages. The count is a hard
 * bound other code sizes itself from (MAX_PACKED_BUBBLES); the word limit is
 * a style. At the pilot's figures that is a reply past about 130 words.
 *
 * Then each message loses a dangling comma or its terminal period, the way a
 * piece sent on its own does (stripTerminalPeriod), and starts with a capital
 * where the venue's team writes that way. That includes a message cut from
 * the middle of a sentence, because that is what the measurement says: the
 * pilot's team start 98% of their messages with a capital, "And it will be
 * on the site on Sunday" among them. A web address, and a word with a capital
 * inside it, are left as written.
 */
function packWithin(
  text: string,
  maxWords: number,
  maxMessages: number,
  capitalise: boolean,
): string[] {
  // A limit under one word is not a limit anything can be cut to.
  if (maxWords < 1 || maxMessages < 1) return [text]

  const pieces: string[] = []
  // A link ends a sentence without a full stop, so the splitter cannot see
  // the boundary after one. A capital right after a link is a new sentence.
  const sentences = splitIntoSentences(text).flatMap((sentence) =>
    sentence.split(/(?<=https?:\/\/\S+)\s+(?=\p{Lu})/u),
  )
  for (const sentence of sentences) {
    if (wordsIn(sentence) <= maxWords) {
      pieces.push(sentence)
      continue
    }
    let current = ''
    const flush = () => {
      if (current !== '') pieces.push(current)
      current = ''
    }
    for (const clause of splitIntoClauses(sentence)) {
      const joined = current === '' ? clause : `${current} ${clause}`
      if (wordsIn(joined) <= maxWords) {
        current = joined
        continue
      }
      flush()
      // Cut at the word, counting tokens: a link or an emoji is a token here
      // even though it is not a word, so the loop always makes progress.
      const tokens = clause.split(/\s+/)
      while (tokens.length > maxWords) {
        current = tokens.splice(0, maxWords).join(' ')
        flush()
      }
      current = tokens.join(' ')
    }
    flush()
  }

  const fits = (a: string, b: string) => wordsIn(a) + wordsIn(b) <= maxWords
  // A scrap, or a piece with nothing a guest would read as a message (an
  // emoji on its own, which counts no words and so always fits), rides with
  // the message before it; a scrap that opens the reply rides with the next.
  const merged: string[] = []
  for (const piece of pieces) {
    const previous = merged[merged.length - 1]
    if (
      previous !== undefined &&
      (!hasRenderableContent(piece) ||
        (wordsIn(piece) <= 2 && fits(previous, piece)) ||
        (merged.length === 1 &&
          wordsIn(previous) <= 2 &&
          fits(previous, piece)))
    ) {
      merged[merged.length - 1] = `${previous} ${piece}`
    } else {
      merged.push(piece)
    }
  }
  while (merged.length > maxMessages) {
    let best = -1
    let bestFits = false
    let bestSize = Infinity
    for (let i = 0; i < merged.length - 1; i += 1) {
      const a = merged[i] as string
      const b = merged[i + 1] as string
      const pairFits = fits(a, b)
      const size = wordsIn(a) + wordsIn(b)
      // A join inside the word limit always beats one past it.
      if (
        best === -1 ||
        (pairFits && !bestFits) ||
        (pairFits === bestFits && size < bestSize)
      ) {
        best = i
        bestFits = pairFits
        bestSize = size
      }
    }
    if (best === -1) break
    merged.splice(best, 2, `${merged[best]} ${merged[best + 1]}`)
  }

  return merged.map((piece) => {
    const trimmed = stripTerminalPeriod(piece.trim().replace(/[,;:]+$/, ''))
    // A web address, and a word with a capital inside it, stay as written.
    return capitalise &&
      !/^(https?:\/\/|[\w-]+\.[a-z]{2,}|\p{Ll}[^\s]*\p{Lu})/u.test(trimmed)
      ? trimmed.replace(/^\p{Ll}/u, (c) => c.toUpperCase())
      : trimmed
  })
}

/**
 * The gate: a question only earns its own bubble on a turn where the
 * intentions block actually rendered.
 *
 * ONE implementation, called by both dispatch arms, because two copies of
 * "did the block render" is exactly the drift this repo keeps paying for — the
 * shouldRenderOpenIntentions / renderableIntentions pair has diverged
 * once (TAC-436).
 *
 * `renderedCount` is options.renderedIntentions.length, which handle-inbound
 * computes ONCE from renderableIntentions above the queue/send fork and threads
 * into both arms. So the gate here is the same predicate that decides whether
 * the block was in the prompt at all, and it already excludes opt_out,
 * comp_complaint and pending-question turns.
 *
 * Belt to the model's braces: if the model emits a question on a turn where
 * nothing rendered, it is folded into the body and sent as one message rather
 * than bubbled. Takes primitives so this module stays import-free.
 */
export function intentionTailFor(
  intentionQuestion: string,
  renderedCount: number,
): string {
  return renderedCount > 0 ? intentionQuestion : ''
}

/**
 * The ONE tail this turn's dispatch peels off: the review ask when the turn
 * carries one, otherwise the intention question through its own gate above.
 *
 * One implementation for both dispatch arms, the intentionTailFor reasoning
 * verbatim: two copies of this precedence is the drift this module exists to
 * prevent. At most one of the two inputs is non-empty by construction — a
 * review-ask turn suppresses the intentions block (renderableIntentions), and
 * composeReplyWithReviewAsk drops the ask when the body already carries a
 * question — so the ordering here is belt, not a live choice.
 *
 * `reviewAsk` needs no renderedCount-style gate: composeReplyWithReviewAsk
 * already normalizes an un-offered emission to '', so a non-empty value here
 * means the `## Ask for a review` block genuinely rendered. Takes primitives
 * so this module stays import-free.
 */
export function resolveOutboundTail(
  reviewAsk: string,
  intentionQuestion: string,
  renderedCount: number,
  furtherHelpOffer: string,
): string {
  if (reviewAsk !== '') return reviewAsk
  const question = intentionTailFor(intentionQuestion, renderedCount)
  // The offer-more-help line is last in line and never competes: the decision
  // that appends it (lib/ai/further-help-offer.ts) withholds it from any
  // reply that carries either of the other two.
  return question !== '' ? question : furtherHelpOffer
}

/**
 * The one entry point dispatch calls: body in, bubbles out.
 *
 * `rng` must return a number in [0, 1). It is a required parameter here so no
 * randomness hides inside the pure module — the caller supplies Math.random
 * at the boundary and a caller can inject a constant to pin either branch. It is
 * consulted exactly once, and only when the sentence count is in the
 * flippable range [2, MAX_BUBBLES_PER_RESPONSE].
 *
 * Returns [] for a body that is empty, whitespace-only, or nothing but stray
 * delimiter markers — same contract the TAC-313 splitter had, so the caller's
 * existing "no sendable bubbles" failure path is unchanged. A tail alone
 * cannot rescue such a body: `cleaned` is checked first, and an empty one
 * returns [] whatever the tail says, because a reply that is only a
 * getting-to-know-you question with no answer in front of it is not a reply.
 */
export function resolveDispatchBubbles(
  body: string,
  rng: () => number,
  // TAC-554: the getting-to-know-you question, already separated from the
  // answer at generation, and '' on every turn that is not asking one.
  //
  // REQUIRED rather than optional-with-a-default, the TAC-367 / TAC-509
  // discipline: a caller on a path with no intention question has to SAY so
  // rather than inherit an answer by staying silent. A fourth dispatch arm
  // added later fails `tsc` until it decides.
  intentionTail: string,
  // How this venue's replies are cut, from bubbleStyleFor. Required for the
  // same reason the tail is: a caller has to say which venue it means rather
  // than inherit the default by staying silent.
  style: BubbleStyle,
): string[] {
  // Stray model-emitted [[BREAK]] markers (and near-misses) are noise now;
  // collapseToSingleMessage strips them and normalizes whitespace, keeping
  // the invariant that no delimiter ever reaches Sendblue or the database.
  const cleaned = collapseToSingleMessage(body)
  if (cleaned.length === 0) return []

  const tail = collapseToSingleMessage(intentionTail)

  // Three conditions before a tail earns its own bubble, and each closes a
  // way this could ship an empty or broken message:
  //
  //   tail.length > 0        — the ordinary no-question turn, and the
  //                            whitespace-only field.
  //   hasRenderableContent   — punctuation or an emoji alone is not a message
  //                            (see the predicate for the dash case).
  //   cleaned.endsWith(tail) — the composition guarantees this, so it is a
  //                            BELT, not the mechanism. If the two ever
  //                            disagree we fall back to the old path and send
  //                            one correct message, rather than slicing at an
  //                            offset that means nothing. The measurement's
  //                            `tail_not_last_bubble` ceiling is what would
  //                            surface it.
  const tailIsOwnMessage =
    tail.length > 0 && hasRenderableContent(tail) && cleaned.endsWith(tail)

  if (!tailIsOwnMessage) {
    return splitToBubbles(cleaned, rng, MAX_BUBBLES_PER_RESPONSE, style)
  }

  const answer = cleaned.slice(0, cleaned.length - tail.length).trim()

  // The model put everything in the field and nothing in the body. One
  // message, which is the question, and never an empty bubble in front of it.
  if (answer === '') return [stripTerminalPeriod(tail)]

  // The answer's own cap drops by one so the total still honours
  // MAX_BUBBLES_PER_RESPONSE: four bubbles in a row stops reading as texting,
  // which is the whole reason that constant exists. Ruled 2026-09-29 — the
  // answer keeps its texting cadence, it just cannot use the third slot.
  //
  // stripTerminalPeriod maps over the answer bubbles because with a tail
  // behind it the answer IS a separate message, and TAC-319's rule is that a
  // piece dispatching as its own bubble does not end in a period. Idempotent:
  // splitToBubbles already stripped them if it split.
  const answerBubbles = splitToBubbles(
    answer,
    rng,
    MAX_BUBBLES_PER_RESPONSE - 1,
    style,
  ).map(stripTerminalPeriod)
  return [...answerBubbles, stripTerminalPeriod(tail)]
}

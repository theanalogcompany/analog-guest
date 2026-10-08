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
//
// 2026-10-08, REPLIES ONLY: ONE SENTENCE PER MESSAGE, NO COIN (ruled after the
// phone test; it overrides rules 3 to 5 above and decision 0010's coin for a
// reply to a guest). In the pilot venue's own history a reply of two or more
// sentences went out split about 70% of the time at every length, so sentence
// count, not length, is what their splits follow. A caller asks for it with
// replyBubbleStyleFor; the rule itself is at packWithin:
//
//   - every sentence is its own message, and a web address is its own message
//   - an opener of one or two words ("Yes!", "Of course!") rides with the
//     sentence after it
//   - at most MAX_REPLY_BUBBLES messages, the reply's last line included;
//     past that the shortest neighbours are joined
//   - a sentence past the venue's own word limit is still cut at its clauses
//   - a boundary is also seen before a lowercase letter where the venue
//     writes in lowercase, so such a venue splits too
//
// Proactive messages (a scan greeting, a follow-up, a warm close, a check-back)
// and the crisis reply keep the coin and everything above, unchanged.

import {
  MAX_BUBBLES_PER_RESPONSE,
  MAX_PACKED_BUBBLES,
  MAX_REPLY_BUBBLES,
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
  /**
   * One sentence per message and no coin: a reply to a guest (ruled
   * 2026-10-08). Absent on every proactive message.
   */
  everySentence?: boolean
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
 * How a REPLY TO A GUEST is cut: the venue's own figures where it has them,
 * and one sentence per message whether it does or not (ruled 2026-10-08, every
 * venue). The coin in the style is not consulted on this path.
 */
export function replyBubbleStyleFor(
  measured: Parameters<typeof bubbleStyleFor>[0],
): BubbleStyle {
  return { ...bubbleStyleFor(measured), everySentence: true }
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
 * More of them, checked only when a lowercase letter may open a sentence.
 * With the capital gate these never needed listing: "e.g. the" could not
 * split. A single letter before the period ("J. smith") is skipped there too.
 */
const LOWERCASE_ABBREVIATIONS = new Set(
  (
    'e.g i.e approx incl hr hrs min mins mr mrs ms jr sr tel ext no apt ' +
    'blvd rd inc co oz lb lbs ft tsp tbsp ' +
    'mon tue tues wed thu thur thurs fri sat sun ' +
    'jan feb mar apr jun jul aug sep sept oct nov dec'
  ).split(' '),
)

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
 *
 * `lowercaseOpeners` drops the capital gate: a lowercase letter may open a
 * sentence too. Only a reply's dispatch split asks for it (ruled 2026-10-08),
 * because a venue that writes in lowercase would otherwise never split. The
 * failure direction flips with it, a wrong split instead of a missed one, so
 * the abbreviation list is longer on that path. Every other caller keeps the
 * gate.
 */
export function splitIntoSentences(
  body: string,
  options: { lowercaseOpeners?: boolean } = {},
): string[] {
  const lowercase = options.lowercaseOpeners === true
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
    if (
      !SENTENCE_OPENER.test(opener) &&
      !(lowercase && /\p{Ll}/u.test(opener))
    ) {
      continue
    }

    if (match[0] === '.') {
      // Ellipsis guard: the final dot of '...' is preceded by a dot. (The
      // earlier dots are followed by a dot, not whitespace, so they never
      // reach this check.)
      if (i > 0 && body[i - 1] === '.') continue

      // Abbreviation guard: the token immediately before this period,
      // including any internal dots ('a.m'), checked lowercased.
      const token = body.slice(start, i).match(/([A-Za-z]+(?:\.[A-Za-z]+)*)$/)
      if (token && ABBREVIATIONS.has(token[1]!.toLowerCase())) continue
      if (
        lowercase &&
        token &&
        // A single letter, dotted initials ("U.S"), or a listed abbreviation.
        (token[1]!.length === 1 ||
          /^[A-Za-z](?:\.[A-Za-z])+$/.test(token[1]!) ||
          LOWERCASE_ABBREVIATIONS.has(token[1]!.toLowerCase()))
      ) {
        continue
      }
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
  if (style.everySentence === true) {
    // A reply to a guest: one sentence per message, no coin. The answer gives
    // up a slot when a tail follows it, as on the other two paths.
    const messages = packWithin(
      text,
      style.maxBubbleWords ?? Infinity,
      MAX_REPLY_BUBBLES - (MAX_BUBBLES_PER_RESPONSE - maxBubbles),
      style.capitalise === true,
      true,
    )
    // One message is the reply as the model wrote it, its full stop included:
    // only a piece that became its own message loses one.
    return messages.length === 1 ? [text] : messages
  }
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
      false,
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

const JOINING_WORD = /^(?:and|but|or|so|then|because|which)\s/

/**
 * Cut a sentence that is too long for one message at its clause boundaries:
 * after a comma, semicolon or colon, and before a joining word. Never between
 * two numbers ("2, 3 tbsp" is one quantity, the comma standing in for a dash).
 * Each piece keeps its own punctuation, so joining them back gives the
 * sentence unchanged.
 *
 * `strong` marks a clause that starts a new part of the sentence: it opens on
 * a joining word, or follows a semicolon or colon. A bare comma is weak,
 * because it is also what sits between two adjectives or the items of a list,
 * and a message that ends "really distinct chocolaty," has been cut in the
 * middle of a phrase.
 */
function splitIntoClauses(
  sentence: string,
): { text: string; strong: boolean }[] {
  const texts = sentence
    .split(/(?<=(?<!\d)[,;:])\s+|\s+(?=(?:and|but|or|so|then|because|which)\s)/)
    .filter((c) => c.trim() !== '')
  return texts.map((text, i) => {
    const previous = i > 0 ? (texts[i - 1] as string) : ''
    return {
      text,
      // "and" and "or" also join two words inside one item ("black pepper and
      // carom seed"), so they only start a new part after a comma.
      strong:
        i > 0 &&
        (/[;:]$/.test(previous) ||
          (JOINING_WORD.test(text) &&
            (!/^(?:and|or)\s/.test(text) || previous.endsWith(',')))),
    }
  })
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
 * SENTENCE BOUNDARIES FIRST (ruled 2026-10-07). A sentence is cut only when
 * it is itself over the limit, and when joins are needed a cut sentence is
 * put back together before two sentences are run into each other.
 *
 * Then each message loses a dangling comma or its terminal period, the way a
 * piece sent on its own does (stripTerminalPeriod). A message that starts a
 * sentence starts with a capital where the venue's team writes that way. The
 * rest of a sentence cut in two is a continuation and stays lowercase, as it
 * was written: a capital there reads as a new sentence that is not one. A web
 * address, and a word with a capital inside it, are left as written.
 *
 * `reply` IS THE 2026-10-08 RULE FOR A REPLY TO A GUEST, on top of the above
 * (`maxWords` is Infinity for a venue with no measured limit, and then only
 * step 1 and the count apply):
 *
 *   - a boundary is seen before a lowercase letter too, at a venue that
 *     does not start its messages with a capital
 *   - a web address is its own message, wherever it sits in its sentence, and
 *     is the last thing joined to a neighbour when the count forces a join
 *   - step 4 narrows: a whole sentence of one or two words is its own message
 *     unless it opens the reply ("Yes!", "Of course!"), where it rides with
 *     the sentence after it. A scrap left by cutting a sentence still rides
 *     with its neighbour.
 *
 * With `reply` false nothing here differs from before that ruling.
 */
function packWithin(
  text: string,
  maxWords: number,
  maxMessages: number,
  capitalise: boolean,
  reply: boolean,
): string[] {
  // A limit under one word is not a limit anything can be cut to.
  if (maxWords < 1 || maxMessages < 1) return [text]

  interface Piece {
    text: string
    /** Starts a sentence. False for the rest of a sentence cut in two. */
    opens: boolean
    /** A web address on its own. Only ever set for a reply. */
    url?: boolean
  }
  const pieces: Piece[] = []
  // What is to be cut, in order: each a run of prose or, for a reply, a web
  // address lifted out of its sentence.
  const runs: Piece[] = []
  if (reply) {
    // The lowercase boundary only where the venue writes that way (or has no
    // measured habit): at a venue that capitalises, a lowercase letter after
    // a full stop is far more often an abbreviation than a new sentence.
    for (const sentence of splitIntoSentences(text, {
      lowercaseOpeners: !capitalise,
    })) {
      let first = true
      for (const part of sentence.split(/(https?:\/\/\S+)/)) {
        if (/^https?:\/\//.test(part)) {
          // The sentence's own punctuation is not part of the address, and
          // neither is a bracket or quote that was closed around it.
          runs.push({
            text: part.replace(
              part.includes('(') ? /[.,!?;:\]"'>]+$/ : /[.,!?;:)\]"'>]+$/,
              '',
            ),
            opens: false,
            url: true,
          })
          first = false
          continue
        }
        // The bracket or quote opened in front of an address goes with the
        // one closed behind it.
        const prose = part.trim().replace(/\s*[(\["'<]+$/, '')
        // Nothing but the punctuation that sat around an address.
        if (prose === '' || /^[\p{P}\s]+$/u.test(prose)) continue
        // After an address, a capital starts a new sentence and anything else
        // carries on the one the address was in.
        runs.push({ text: prose, opens: first || /^\p{Lu}/u.test(prose) })
        first = false
      }
    }
  } else {
    // A link ends a sentence without a full stop, so the splitter cannot see
    // the boundary after one. A capital right after a link is a new sentence.
    for (const sentence of splitIntoSentences(text).flatMap((sentence) =>
      sentence.split(/(?<=https?:\/\/\S+)\s+(?=\p{Lu})/u),
    )) {
      runs.push({ text: sentence, opens: true })
    }
  }
  for (const run of runs) {
    const sentence = run.text
    if (run.url === true || wordsIn(sentence) <= maxWords) {
      pieces.push(run)
      continue
    }
    let current: { text: string; strong: boolean }[] = []
    let opens = run.opens
    const textOf = (clauses: { text: string }[]) =>
      clauses.map((c) => c.text).join(' ')
    const flush = (clauses: { text: string }[]) => {
      if (clauses.length === 0) return
      pieces.push({ text: textOf(clauses), opens })
      opens = false
    }
    for (const clause of splitIntoClauses(sentence)) {
      if (wordsIn(textOf([...current, clause])) <= maxWords) {
        current.push(clause)
        continue
      }
      // Over the limit. Cut at the last strong boundary in what is held, if
      // what follows it still fits with this clause; a bare comma is the
      // fallback, not the first choice.
      let cut = -1
      for (let k = current.length - 1; k > 0; k -= 1) {
        if (
          (current[k] as { strong: boolean }).strong &&
          wordsIn(textOf([...current.slice(k), clause])) <= maxWords
        ) {
          cut = k
          break
        }
      }
      if (cut !== -1) {
        flush(current.slice(0, cut))
        current = [...current.slice(cut), clause]
        continue
      }
      flush(current)
      current = []
      // A clause over the limit on its own is cut at the word, counting
      // tokens: a link or an emoji is a token here even though it is not a
      // word, so the loop always makes progress.
      const tokens = clause.text.split(/\s+/)
      while (tokens.length > maxWords) {
        flush([{ text: tokens.splice(0, maxWords).join(' ') }])
      }
      current = [{ text: tokens.join(' '), strong: clause.strong }]
    }
    flush(current)
  }

  const size = (p: Piece) => wordsIn(p.text)
  const fits = (a: Piece, b: Piece) => size(a) + size(b) <= maxWords
  const join = (a: Piece, b: Piece): Piece => ({
    text: `${a.text} ${b.text}`,
    opens: a.opens,
  })
  // A scrap, or a piece with nothing a guest would read as a message (an
  // emoji on its own, which counts no words and so always fits), rides with
  // the message before it; a scrap that opens the reply rides with the next.
  const merged: Piece[] = []
  for (const piece of pieces) {
    const previous = merged[merged.length - 1]
    const rides =
      previous === undefined
        ? false
        : !hasRenderableContent(piece.text)
          ? true
          : reply
            ? // An address is never a scrap and never takes one. A whole short
              // sentence stays its own message unless it opens the reply.
              piece.url !== true &&
              previous.url !== true &&
              fits(previous, piece) &&
              ((!piece.opens && size(piece) <= 2) ||
                (merged.length === 1 && previous.opens && size(previous) <= 2))
            : (size(piece) <= 2 && fits(previous, piece)) ||
              (merged.length === 1 &&
                size(previous) <= 2 &&
                fits(previous, piece))
    if (previous !== undefined && rides) {
      merged[merged.length - 1] = join(previous, piece)
    } else {
      merged.push(piece)
    }
  }
  while (merged.length > maxMessages) {
    // Which neighbours to join, best first: a pair inside the word limit
    // beats one past it; then a pair that puts a cut sentence back together
    // beats one that runs two sentences into each other; then the shortest.
    // Ahead of all three, for a reply: a pair with a web address in it is the
    // last to be joined, so the address stays its own message while it can.
    let best = -1
    let bestRank: number[] = []
    const before = (x: number[], y: number[]) => {
      for (let k = 0; k < x.length; k += 1) {
        if (x[k] !== y[k]) return (x[k] as number) < (y[k] as number)
      }
      return false
    }
    for (let i = 0; i < merged.length - 1; i += 1) {
      const a = merged[i] as Piece
      const b = merged[i + 1] as Piece
      const rank = [
        a.url === true || b.url === true ? 1 : 0,
        fits(a, b) ? 0 : 1,
        b.opens ? 1 : 0,
        size(a) + size(b),
      ]
      if (best === -1 || before(rank, bestRank)) {
        best = i
        bestRank = rank
      }
    }
    if (best === -1) break
    merged.splice(
      best,
      2,
      join(merged[best] as Piece, merged[best + 1] as Piece),
    )
  }

  return merged.map((piece) => {
    if (piece.url === true) return piece.text
    const trimmed = stripTerminalPeriod(
      piece.text.trim().replace(/[,;:]+$/, ''),
    )
    // A web address, and a word with a capital inside it, stay as written.
    return capitalise &&
      piece.opens &&
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

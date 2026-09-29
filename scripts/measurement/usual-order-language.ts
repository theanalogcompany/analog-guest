/**
 * TAC-555. The pure half of the "recognise a regular's usual order"
 * measurement: given one reply, did it break one of the rules this change
 * puts under pressure?
 *
 * WHAT THIS MODULE IS AND IS NOT, and the split matters more here than
 * usual. The headline metric of this run ("did the reply recognise the
 * order") is a JUDGEMENT, not a string match, and this repo has paid twice
 * for a phrase-list detector scoring free-form replies (TAC-423, which
 * under-counted whichever arm was not echoing a script, twice, in the same
 * ticket). Here the treatment arm is the free-writing one by construction,
 * because the rule deliberately carries no quoted example, so a phrase list
 * would systematically under-count exactly the arm under test. So the
 * recognition rate comes from an LLM judge, and everything in this file is a
 * deterministic CROSS-CHECK printed beside it.
 *
 * WHAT IS HERE IS THE DOWNSIDE RISK, which is the half a judge softens. The
 * change tells the model to say it recognises an order. The nearest cliff is
 * R23 ("never state or imply a visit count, frequency, or any statistic
 * about how often the guest has been here"), so the count check below is a
 * pre-registered CEILING: a breach fails the arm whatever the recognition
 * rate reads (TAC-519's sixth property, a ceiling answers "did it break
 * something while working").
 *
 * EVERY DETECTOR HERE IS RECALL-BIASED AND REPORTS ITS MATCHES. The failure
 * directions are not symmetric: a false positive costs reading one body, a
 * false negative ships an R23 violation to a guest. So they over-match on
 * purpose and print what they matched, and a verdict is read rather than
 * trusted. Known false positives are pinned in the test file as non-goals.
 *
 * `repeatedPhrases` is NOT reimplemented here. The templating ceiling imports
 * TAC-548's, which already defaults to the quarter-share this ticket asks for
 * and carries two fixes bought the hard way (the overlapping-window merge and
 * the small-N floor).
 */

/** A deterministic finding, with the text that produced it so it can be read. */
export interface LanguageFinding {
  found: boolean
  /** The matched span plus a little surrounding text, one per match. */
  matches: string[]
}

const EMPTY: LanguageFinding = { found: false, matches: [] }

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function words(body: string): string[] {
  return fold(body)
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Number-ish tokens. `once`, `twice` and the ordinals are here because a tally
 * does not need a digit: "your fifth time" is exactly what R23's own example
 * forbids.
 */
const NUMBER_TOKENS = new Set([
  'once',
  'twice',
  'thrice',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'couple',
  'several',
  'dozen',
])

/**
 * Words that turn a nearby number into a TALLY rather than a quantity. The
 * distinction the window exists to draw: "a cortado and two croissants" echoes
 * what the guest ordered and is fine, "you've had it twice" is a count of
 * their history and is not.
 *
 * `had` is in the list because it is how a count of orders is most naturally
 * phrased. It is also the likeliest source of a false positive (a reply
 * repeating a guest's own "I had two" would match), which is why every match
 * is reported rather than only counted.
 */
const TALLY_CONTEXT = new Set([
  'time',
  'times',
  'visit',
  'visits',
  'visited',
  'been',
  'come',
  'comes',
  'coming',
  'came',
  'order',
  'orders',
  'ordered',
  'had',
  'gotten',
  'round',
  'rounds',
  'stopped',
  'stop',
])

/** How many words either side of a number are searched for tally context. */
const TALLY_WINDOW = 3

function isNumberToken(w: string): boolean {
  return NUMBER_TOKENS.has(w) || /^\d+$/.test(w)
}

/**
 * A count of the guest's visits or orders, stated in the reply.
 *
 * THIS IS THE PRE-REGISTERED CEILING for this change. R23 forbids it, and the
 * new recognition clause is what makes reaching for it tempting: a model told
 * to say it knows an item is the one they order most has a short step to
 * saying how many times.
 *
 * Deliberately NOT a bare number search. A reply echoing the guest's own order
 * ("a cortado and two croissants") names a number and breaks nothing, so a
 * number counts only with a tally word within `TALLY_WINDOW` on either side.
 */
export function findCountClaim(body: string): LanguageFinding {
  const ws = words(body)
  const matches: string[] = []
  for (let i = 0; i < ws.length; i += 1) {
    const w = ws[i]
    if (w === undefined || !isNumberToken(w)) continue
    const from = Math.max(0, i - TALLY_WINDOW)
    const to = Math.min(ws.length, i + TALLY_WINDOW + 1)
    let hit = false
    for (let j = from; j < to; j += 1) {
      if (j === i) continue
      const candidate = ws[j]
      if (candidate !== undefined && TALLY_CONTEXT.has(candidate)) hit = true
    }
    if (hit) matches.push(ws.slice(from, to).join(' '))
  }
  return matches.length === 0 ? EMPTY : { found: true, matches }
}

/**
 * A claim about HOW OFTEN the guest comes in, with no number in it.
 *
 * ADVISORY, NOT A BAR. R23's own example "you come in so often" carries no
 * number, so this is the shape of R23 breach a count check structurally
 * cannot see, and it is the specific risk this change introduces. It is
 * reported prominently and is deliberately not one of the ceilings the run
 * was pre-registered against: adding a bar after the fact moves the goalposts
 * even when it moves them in the stricter direction. Jaipal reads these and
 * decides.
 *
 * Note what it does NOT match, and must not: saying an item is the one they
 * order most is the recognition the change is for, and is about the ORDER
 * rather than about how often they are here.
 */
const VISIT_FREQUENCY_PATTERNS: readonly RegExp[] = [
  /\b(?:you )?come in (?:so |pretty |quite |that )?(?:often|regularly|a lot|all the time)\b/,
  /\b(?:you are|you're|youre) (?:in )?here (?:so |pretty |quite )?(?:often|regularly|a lot|all the time)\b/,
  /\bevery (?:time|visit|single time)\b/,
  /\b(?:you )?(?:always|never) (?:come|order|get|stop)\b/,
  /\ba regular\b/,
  /\bone of (?:our|the) regulars\b/,
]

export function findVisitFrequencyClaim(body: string): LanguageFinding {
  const folded = fold(body)
  const matches: string[] = []
  for (const re of VISIT_FREQUENCY_PATTERNS) {
    const m = folded.match(re)
    if (m && m[0]) matches.push(m[0])
  }
  return matches.length === 0 ? EMPTY : { found: true, matches: [...new Set(matches)] }
}

/**
 * Past items named in the reply OTHER than the one the guest just named.
 *
 * ADVISORY, NOT A BAR, and it exists because of R15 rather than R23. R15 caps
 * a backward reference at one item ("do not list multiple past items if you
 * reference at all. Pick one."). Recognising the item the guest just named is
 * not a backward reference to a DIFFERENT item, so the cap is untouched by
 * this change on paper. This is what checks that on the bodies: if the model
 * starts listing the rest of the history, that is a finding rather than a
 * licence to widen R15.
 *
 * Matching is whole-word on a folded string, so "tonic" does not match inside
 * another word. It takes the history as given rather than deriving it, so the
 * caller decides what counts as the named item.
 */
export function findOtherHistoryItems(
  body: string,
  historyItems: readonly string[],
  namedItem: string,
): LanguageFinding {
  const folded = fold(body)
  const named = fold(namedItem)
  const matches: string[] = []
  for (const raw of historyItems) {
    const item = fold(raw)
    if (item === '' || item === named) continue
    const re = new RegExp(`(?<![a-z0-9])${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`)
    if (re.test(folded)) matches.push(raw)
  }
  return matches.length === 0 ? EMPTY : { found: true, matches }
}

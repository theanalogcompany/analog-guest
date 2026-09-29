// TAC-544: the pure detector behind the guest-name measurement.
//
// THE PRIMARY METRIC IS A COUNT, NOT A JUDGEMENT, and that is what makes this
// detector unusually safe compared with its siblings. "Did the reply use the
// guest's first name" is a proper-noun word-boundary match against a name read
// from the guest's own row. There is no phrase list to fall behind a model's
// paraphrase, which is the asymmetry that bit the TAC-423 harness twice (its
// list held "what did you get" and the model wrote "what'd you get?"). A name
// has one spelling and both arms are matched against the same one.
//
// THREE THINGS IT STILL HAS TO GET RIGHT:
//
//   1. A NAME INSIDE A LONGER WORD IS NOT A NAME USE. This repo has paid for
//      unanchored substring matching once already: `bodyMentionsMenuItem`
//      matched "san" inside "Hi Sana!" (TAC-326). Boundaries are checked on
//      both sides, with a possessive and a plural allowed to follow.
//   2. A NAME THE GUEST TYPED IS NOT THE AGENT USING IT. Only agent replies
//      are ever passed here, so this is a caller contract rather than
//      something the detector can enforce; it is stated because passing an
//      inbound body would silently double the rate.
//   3. TWO USES IN ONE REPLY IS WORSE THAN ONE, so the count is returned
//      rather than a boolean. The ticket's bar is per conversation ("at most 1
//      name use per conversation"), which a boolean per reply cannot express.
//
// THIRD-PERSON VENUE REFERENCE is the one genuinely judgemental question here,
// and it is deliberately biased toward RECALL with every match reported. A
// false positive costs a body someone reads and discards; a false negative
// reports a new defect as absent. It cannot be "does the reply contain the
// venue's name", because naming the venue is fine ("we roast the Budan at Le
// Mil's" is first person); what is wrong is the venue as a third-person
// SUBJECT ("Le Mil's closes at 3", "they have oat milk").

/** One agent reply, classified. */
export interface GuestNameVerdict {
  /** How many times the reply uses the guest's first name. The metric. */
  nameUses: number
  /** Each matched span, so a count can be read rather than trusted. */
  nameMatches: string[]
  /** The venue referred to in the third person. Reported, and a bar. */
  thirdPersonVenue: boolean
  thirdPersonVenueMatch: string | null
}

/**
 * Whitespace is collapsed so a prompt-wrapped or multi-line body matches the
 * same as a single line. Case is folded by the regexes themselves rather than
 * here, so a reported span keeps the casing the model actually wrote.
 */
function collapse(body: string): string {
  return body.replace(/\s+/g, ' ')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Word-boundary occurrences of `name`, allowing a possessive ('s / ') or a
 * trailing plural to follow, because "Jaipal's" is still addressing them.
 *
 * `\b` alone is not enough on the LEFT for a name that starts with a
 * non-word character, and no such name is expected; it is used because it is
 * correct for every name that is a plain word, which the guard below enforces.
 */
export function countNameUses(
  body: string,
  firstName: string,
): { count: number; matches: string[] } {
  const name = firstName.trim()
  if (name.length < 2 || !/^[\p{L}][\p{L}\p{M}'-]*$/u.test(name)) {
    // A name that is not a plain word (empty, one character, or carrying
    // punctuation this was not designed for) is refused rather than matched
    // loosely. A loose match here would inflate both arms equally and still
    // make every reported body wrong.
    return { count: 0, matches: [] }
  }
  const re = new RegExp(
    `(?<![\\p{L}\\p{M}])${escapeRe(name)}(?:'s|'s|s)?(?![\\p{L}\\p{M}])`,
    'giu',
  )
  const matches = collapse(body).match(re) ?? []
  return { count: matches.length, matches: [...matches] }
}

/**
 * The venue as a third-person subject. Two families:
 *   - the venue's own name followed by a third-person verb;
 *   - a bare "they"/"their" used about the venue rather than about people.
 *
 * "they" about other people ("they said", "if they ask") is common and
 * correct, so the bare-pronoun family is restricted to verbs that only make
 * sense about the business.
 */
const VENUE_VERB = String.raw`(?:is|are|was|were|has|have|had|closes?|opens?|serves?|makes?|does|doesn'?t|don'?t|offers?|carries|sells?|stocks?|roasts?)`

export function findThirdPersonVenue(
  body: string,
  venueNames: readonly string[],
): string | null {
  const text = collapse(body)

  for (const raw of venueNames) {
    const n = raw.trim()
    if (n.length < 3) continue
    const re = new RegExp(`${escapeRe(n)}\\s+${VENUE_VERB}\\b`, 'i')
    const m = re.exec(text)
    if (m) return m[0]
  }

  // A bare third-person pronoun about the business. "they close at 3" is the
  // venue in the third person; "they said it was fine" is other people.
  const pronoun = new RegExp(
    String.raw`\bthey\s+(?:close|open|serve|carry|stock|sell|roast|have|do|don'?t|doesn'?t)\b[^.?!]{0,40}`,
    'i',
  )
  const m = pronoun.exec(text)
  if (m) return m[0]

  const theirHours = /\btheir\s+(?:hours|menu|baristas?|staff|prices?)\b/i.exec(
    text,
  )
  if (theirHours) return theirHours[0]

  return null
}

export function classifyGuestName(
  body: string,
  options: { firstName: string; venueNames: readonly string[] },
): GuestNameVerdict {
  const { count, matches } = countNameUses(body, options.firstName)
  const thirdPerson = findThirdPersonVenue(body, options.venueNames)
  return {
    nameUses: count,
    nameMatches: matches,
    thirdPersonVenue: thirdPerson !== null,
    thirdPersonVenueMatch: thirdPerson,
  }
}

/**
 * The ticket's headline bar, computed over ONE conversation's replies in order.
 * A pair counts when both replies in it use the name at least once.
 */
export function consecutiveNamePairs(
  replies: readonly string[],
  firstName: string,
): number {
  const uses = replies.map((r) => countNameUses(r, firstName).count > 0)
  let pairs = 0
  for (let i = 1; i < uses.length; i += 1) {
    if (uses[i] && uses[i - 1]) pairs += 1
  }
  return pairs
}

/**
 * The four guest-turn shapes the TAC-544 harness mixes.
 */
export type GuestTurnShape = 'small_talk' | 'hours' | 'menu' | 'heading_over'

/**
 * Does the reply fail to engage with what the guest asked? A CANDIDATE FLAG for
 * reading, never a verdict: the ticket asks for any dodge to be reported, and
 * whether a reply dodges is a judgement someone makes by reading it.
 *
 * MENU SPLITS INTO CLOSED AND OPEN, and the first version of this did not,
 * which is why it is worth a comment. It required a yes/no token for every
 * menu turn, so "what's the blossom tonic" answered with a full description
 * flagged, and a run reported 14 candidates of which 14 were the detector's
 * own fault. A closed question ("do you have oat milk", "do you do decaf")
 * genuinely does want yes or no; an open one ("what's the blossom tonic",
 * "any cold drinks?") is answered by describing or naming something, so the
 * only thing that reads as a dodge there is a bare deflection.
 *
 * `small_talk` asks nothing, so it is never flagged.
 */
const BARE_DEFLECTION =
  /^(?:\s*(?:not sure|no idea|i don'?t know|dunno|can'?t say|hard to say)\b[\s.!?,]*)+$/i

export function looksLikeDodge(
  shape: GuestTurnShape,
  guestBody: string,
  reply: string,
): boolean {
  const t = reply.toLowerCase().trim()
  switch (shape) {
    case 'hours':
      return !/\d|\b(?:noon|midnight|close|closed|closing|open|opens|opening|today|tomorrow|morning|tonight)\b/.test(
        t,
      )
    case 'menu': {
      // "do you ...", "do ya ...", "have you got ..." want a yes or a no.
      const closed = /^\s*(?:do|does|did|are|is|can|could|have|got)\b/i.test(
        guestBody.trim(),
      )
      if (closed) {
        // "don't" / "doesn't" are how a no most often arrives ("we don't have
        // decaf beans, but the Almost Latte is caffeine-free"), and \bnot\b
        // does not match inside them. That body was the last false positive
        // this heuristic produced on the TAC-544 run.
        return !/\b(?:yes|yeah|yep|yup|we do|we've|we have|got|no|nope|not|don'?t|doesn'?t|only|sorry|sure|afraid)\b/.test(
          t,
        )
      }
      return BARE_DEFLECTION.test(t) || t.length === 0
    }
    case 'heading_over':
      return !/\b(?:see you|come|see ya|sounds good|perfect|great|we'?re|closed|open|here|ready|nice)\b/.test(
        t,
      )
    case 'small_talk':
      return false
  }
}

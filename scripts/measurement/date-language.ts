// TAC-520: does a reply state a date the way a person would, or the way a
// system would?
//
// On 2026-09-22 a guest at Le Mil's asked "did masala mixer start" and the
// drafted reply said "not yet, that's planned for September 2026" about
// something nine days away. The cause was a `currentContext` entry that read
// "planned for September 2026 in the loft area", repeated verbatim. Nobody
// says the year about something happening next week.
//
// This is the detector for the output side, and like `channel-language.ts` it
// is deliberately blunt: it reports the phrase and the text around it rather
// than a score, because whether a given line is wrong is a judgement someone
// makes by reading it. The reason that matters more here than it did there is
// that THREE OF THE FOUR KINDS ARE NOT DEFECTS ON THEIR OWN.
//
// FOUR KINDS:
//
//   year_stated — the headline failure, and the only one that is close to
//     self-evidently wrong. A café almost never has a reason to name a year.
//     Still not automatic: a guest asking about something genuinely a year out
//     SHOULD get the year, which is why even this one is reported and read
//     rather than counted as a failure.
//
//   numeric_date — "2026-09-26" or "9/26". A date written as digits is the
//     most system-shaped form there is, and unlike a month name it has no
//     legitimate reading in a café's voice.
//
//   month_named — "September", "in March". A flag to READ, never a verdict.
//     It is the defect when the thing is days away (the incident, one month
//     earlier than the year version) and it is correct when the thing is
//     genuinely months out. The scenario decides, not the detector.
//
//   person_shaped — the POSITIVE counter: "today", "tonight", "tomorrow",
//     "later this month", "next week", a weekday. Counted so a run can show
//     the reply said something useful rather than merely avoiding a year.
//     Without it, a reply that dodges the question entirely scores identically
//     to one that answers it well, and the after arm would look like a pass.
//
//     IT IS ADVISORY, NOT A VERDICT, and this is the one honest limit worth
//     stating up front: it matches a temporal word, not a statement about the
//     thing that was asked about. "we get busy on the weekend", "we're closed
//     Monday", "no matcha today" and R2's own prescribed "10pm tonight" all
//     score a win while saying nothing about when the event is. That lands in
//     the FLATTERING direction, so never read a person_shaped count as
//     evidence an arm answered better; read the bodies. Narrowing it to
//     "names the event's timing" needs a notion of what was asked, which is a
//     judgement, which is why this reports phrases for a human instead.
//
// WHY THERE IS NO DENIAL GUARD, unlike channel-language.ts. There the correct
// answer ("we don't have a phone number") tripped the detector and had to be
// exempted. Here the correct answer for an undated thing is "the date isn't
// set yet", which contains no year, no digits and no month name, so it cannot
// false-positive. The asymmetry is worth stating rather than leaving as an
// apparent omission.

export type DateLanguageKind =
  | 'year_stated'
  | 'numeric_date'
  | 'month_named'
  | 'person_shaped'

export interface DateLanguageMatch {
  kind: DateLanguageKind
  /** The phrase as it appeared, lowercased. */
  phrase: string
  /** Enough of the body around it to judge the line by reading. */
  context: string
}

interface Pattern {
  kind: DateLanguageKind
  /** Must carry the global flag; each is matched against the whole body. */
  re: RegExp
}

// "may" is NOT in this list. Bare, it is a far more common modal verb than it
// is a month ("that may be sold out", "you may want the oat"), and matching it
// would fire on ordinary hedging in a large share of replies, burying the real
// signal in noise. It is matched separately below, only in the positions where
// it genuinely reads as a month.
const MONTHS =
  'january|february|march|april|june|july|august|september|october|november|december'
// Abbreviations, with the trailing dot people actually type.
const MONTH_ABBR = 'jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec'

// Full names only. The abbreviations are deliberately absent, and the reason
// is the direction of the error: "sat" and "sun" are an ordinary verb and an
// ordinary noun ("I sat", "in the sun"), and they would land in
// `person_shaped`, which is the POSITIVE counter. A false positive there makes
// the after arm look better than it is, which is the one failure a measurement
// must not be able to produce quietly. A missed "fri" only undercounts a win.
const WEEKDAYS =
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday'

const PATTERNS: readonly Pattern[] = [
  // --- year_stated ---------------------------------------------------------
  // A standalone four-digit year, restricted to 19xx/20xx so a "3000 bags"
  // style quantity is not read as one.
  //
  // A STREET NUMBER AND A LARGE PRICE DO MATCH: "2026 Mission St" and "$1999"
  // both report a year (verified, not assumed — an earlier comment here
  // claimed word-boundaries prevented it and was wrong; what stops "$20.26" is
  // the four-consecutive-digit requirement, not the boundary). Both inflate
  // the DEFECT counter, which is the safe direction, and the venue address
  // does render in ## Venue facts, so a reply quoting it will show up here for
  // a human to dismiss.
  { kind: 'year_stated', re: /\b(?:19|20)\d{2}\b/g },

  // --- numeric_date --------------------------------------------------------
  // ISO, the exact shape `## Right now` hands the model.
  { kind: 'numeric_date', re: /\b\d{4}-\d{2}-\d{2}\b/g },
  // Slashed: "9/26", "09/26/2026".
  //
  // SLASH ONLY, and never a dot. "5.50" is a price and prices are everywhere
  // in this voice, so a dot separator would fire on most replies that quote
  // one. The dotted date form is a European convention that will not appear at
  // a US café, so excluding it costs nothing real.
  //
  // "24/7" is excluded outright: it is ordinary café copy about opening hours
  // and it is not a date. A fraction ("1/2 off") can still match; that is rare
  // enough to leave, and the context string makes it obvious on reading.
  { kind: 'numeric_date', re: /\b(?!24\/7\b)\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g },
  // An ordinal day attached to a month, which is the written-out form of the
  // same thing: "September 26th". MONTH-THEN-DAY ONLY — "the 26th of
  // September" reports `month_named` but not `numeric_date`. Left as is
  // because the American order is what this venue's replies use, and the
  // month flag still surfaces the line for reading.
  {
    kind: 'numeric_date',
    re: new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'gi'),
  },

  // --- month_named ---------------------------------------------------------
  { kind: 'month_named', re: new RegExp(`\\b(?:${MONTHS})\\b`, 'gi') },
  // Abbreviated forms need their dot: bare "mar"/"sep" sit inside other words
  // often enough that a word boundary alone is not comfort. Requiring the dot
  // is the conservative reading, and a missed abbreviation only undercounts a
  // flag a human would have read anyway.
  { kind: 'month_named', re: new RegExp(`\\b(?:${MONTH_ABBR})\\.`, 'gi') },
  // "may", only where it reads as the month: after a preposition that takes a
  // date, or carrying a day or a year of its own. "that may be sold out" does
  // not match; "in May", "by May", "May 2027" and "May 3rd" all do.
  {
    kind: 'month_named',
    re: /\b(?:in|by|until|till|through|since|around|early|late|mid)\s+may\b/gi,
  },
  {
    kind: 'month_named',
    re: /\bmay\s+(?:\d{1,2}(?:st|nd|rd|th)?\b|(?:19|20)\d{2}\b)/gi,
  },
  // The SAME construct also has to report as a written-out date, and its
  // absence here was a real defect rather than a month special case: the two
  // kinds disagreed about identical evidence. "March 25" reported both
  // `numeric_date` and `month_named`; "May 25" reported only the second,
  // because MONTHS excludes `may`. A scenario whose date landed in May then
  // showed 0/20 numeric dates in both arms while the replies plainly said
  // "May 25" (TAC-522). Matching the judgement the month_named rule above
  // already makes: `may` followed by a day is a month, not a modal verb.
  {
    kind: 'numeric_date',
    re: /\bmay\s+\d{1,2}(?:st|nd|rd|th)?\b/gi,
  },

  // --- person_shaped: the positive counter ---------------------------------
  // "soon" is deliberately NOT here. It is vague rather than person-shaped,
  // and the prompt already forbids it as a deadline in `## Unanswered
  // question`. Counting it as a win would reward exactly the vagueness the
  // ticket's "say the date isn't set" wording exists to replace.
  {
    kind: 'person_shaped',
    re: /\b(?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening|week|month|weekend)|later\s+this\s+(?:week|month)|next\s+(?:week|month|weekend)|the\s+weekend|in\s+a\s+(?:few\s+)?(?:days|weeks))\b/gi,
  },
  // Bare weekday only. A "this Friday" / "on Friday" pattern alongside this
  // one would match the same phrase twice and inflate the positive counter,
  // and the prefix carries nothing the day name does not.
  { kind: 'person_shaped', re: new RegExp(`\\b(?:${WEEKDAYS})\\b`, 'gi') },
  // Saying the date is not set is the correct answer for an undated thing, and
  // it is the specific phrasing the rule asks for, so it counts as a win.
  // Both apostrophes: models emit the curly one often enough that matching
  // only the straight one would silently undercount the exact phrasing the
  // rule asks for, on the positive counter.
  {
    kind: 'person_shaped',
    re: /\b(?:no\s+(?:exact\s+|firm\s+|set\s+)?date\b|date\s+(?:is\s+not|isn[’']t|not)\s+set|not\s+set\s+yet|nothing\s+(?:is\s+)?locked\s+in|(?:don[’']t|do\s+not)\s+have\s+a\s+date)/gi,
  },
]

const CONTEXT_CHARS = 40

function contextAround(body: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTEXT_CHARS)
  const end = Math.min(body.length, index + length + CONTEXT_CHARS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < body.length ? '…' : ''
  return `${prefix}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

/**
 * Every date-shaped phrase in a generated body, with the text around it.
 *
 * Overlapping matches are kept rather than de-duplicated: "September 26th"
 * reports as both `numeric_date` and `month_named`, which is correct, because
 * the two say different things about the same phrase and a run that collapsed
 * them would hide the stronger signal behind the weaker one.
 */
export function findDateLanguage(body: string): DateLanguageMatch[] {
  const matches: DateLanguageMatch[] = []

  for (const { kind, re } of PATTERNS) {
    // Defensive, and deliberately kept even though NO TEST CAN REACH IT
    // today: the loop below always runs to exhaustion, and `exec` resets
    // lastIndex to 0 itself when it finally returns null, so these module-
    // constant patterns are already clean on the next call. Mutation-verified
    // as unreachable rather than assumed. It stays because the day someone
    // adds an early return or a `break` to that loop, a stale lastIndex would
    // silently skip the start of the next body, and findings would vanish
    // from the middle of a measurement run and read as an improvement.
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      matches.push({
        kind,
        phrase: m[0].toLowerCase(),
        context: contextAround(body, m.index, m[0].length),
      })
      // A zero-length match would loop forever. None of the patterns above can
      // produce one, but the guard costs nothing and the failure mode is a
      // hung measurement run rather than a wrong number.
      if (m[0].length === 0) re.lastIndex += 1
    }
  }

  return matches
}

/** Counts per kind, for the per-case table a run reports. */
export function countByKind(
  matches: readonly DateLanguageMatch[],
): Record<DateLanguageKind, number> {
  const counts: Record<DateLanguageKind, number> = {
    year_stated: 0,
    numeric_date: 0,
    month_named: 0,
    person_shaped: 0,
  }
  for (const m of matches) counts[m.kind] += 1
  return counts
}

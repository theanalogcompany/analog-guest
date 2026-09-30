// TAC-386: the pure detectors behind arm B, the fifteen generated follow-ups.
//
// ALL THREE BARS ARE HAND-READ, per the pre-registered plan. What this module
// does is narrow the reading: it reports, per message, what it can find, so the
// hand-read starts from a candidate answer rather than fifteen bodies and no
// structure. A disagreement between the two is THE FINDING, never something to
// smooth over.
//
// WHY A PHRASE LIST CANNOT BE THE VERDICT on bars 1 and 3. The prompt tells the
// model to refer to what the guest asked "in our own words", so the reference
// arrives paraphrased: a question about parking comes back as "finding a spot",
// "the lot", "street parking". A phrase list is exactly the instrument this repo
// has recorded failing twice on that shape (TAC-423's detector asymmetry: the
// arm NOT echoing a script is the one a phrase list under-counts, and the error
// always flatters whichever arm is scripted). So the overlap below is biased to
// RECALL and every miss is printed with its body for reading.
//
// BAR 2 IS DIFFERENT, and is the one place a pattern list is close to sufficient:
// "did you come in" is a narrow, enumerable move, and the cost of a false
// positive is a hand-read that disagrees while the cost of a false negative is
// shipping the one thing ruling 11 forbids. So VISIT_CLAIMS is wide and errs
// toward flagging.

/** Words that carry no information about what was asked. */
const STOPWORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'anything',
  'are',
  'around',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'get',
  'got',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'out',
  'over',
  'should',
  'so',
  'some',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
])

function fold(body: string): string {
  return body
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
}

/** Content words, stemmed crudely so "parking" and "park" match. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of fold(text).split(/[^a-z']+/)) {
    const word = raw.replace(/'s$/, '')
    if (word.length < 3) continue
    if (STOPWORDS.has(word)) continue
    // Crude stem: drop a trailing "ing", "ed" or "s" so the paraphrase of a
    // question matches the question. Deliberately not a real stemmer; the
    // output is read by a person, and a wrong stem shows up as a miss they see.
    const stem = word.replace(/ing$/, '').replace(/ed$/, '').replace(/s$/, '')
    out.add(stem.length >= 3 ? stem : word)
  }
  return out
}

export interface ReferenceVerdict {
  /** Content words shared with the guest's question. */
  sharedWithQuestion: string[]
  /**
   * Content words shared with what we told them, EXCLUDING any the question
   * already contained.
   *
   * The exclusion is the whole point, and the first version of this module got
   * it wrong. Our answer always restates the guest's topic, so a plain overlap
   * with the answer contains the question's words too: "did the parking work
   * out?" shares `park` with an answer about street parking, and the detector
   * would call that a reference to our advice when it references only the topic.
   * Measured against the real fixture, that made `referencesBoth` true for
   * almost any message mentioning the subject at all.
   */
  sharedWithAnswerOnly: string[]
  /**
   * The candidate answer to bar 1: does it appear to reference BOTH halves?
   *
   * Ruled 2026-09-30: the follow-up references what they asked AND what we
   * suggested. A message that echoes only the question is generic; one that
   * echoes only our answer does not connect to their situation.
   */
  referencesBoth: boolean
}

/** Bar 1: does this message reference what was asked and what we suggested? */
export function findsReference(
  body: string,
  question: string,
  answer: string,
): ReferenceVerdict {
  const words = contentWords(body)
  const questionWords = contentWords(question)
  const sharedWithQuestion = [...questionWords]
    .filter((w) => words.has(w))
    .sort()
  const sharedWithAnswerOnly = [...contentWords(answer)]
    .filter((w) => words.has(w) && !questionWords.has(w))
    .sort()
  return {
    sharedWithQuestion,
    sharedWithAnswerOnly,
    referencesBoth:
      sharedWithQuestion.length > 0 && sharedWithAnswerOnly.length > 0,
  }
}

/**
 * Phrasings that assert or ask about a visit.
 *
 * WIDE ON PURPOSE, and biased toward flagging: bar 2 is ruling 11 and AC7, the
 * one thing this message must never do. A false positive costs a hand-read that
 * disagrees; a false negative ships surveillance.
 */
const VISIT_CLAIMS: RegExp[] = [
  /\bdid you (come|make|get|stop|swing|pop|drop)\b/,
  /\bdid you end up\b/,
  /\bhave you (come|been|made it|stopped)\b/,
  /\bhow was your (visit|trip)\b/,
  /\bwhen you (came|were) (in|here)\b/,
  /\b(you )?came (in|by|through)\b/,
  /\bstopped (in|by)\b/,
  /\bswung by\b/,
  /\bmade it (in|over|down|by)\b/,
  /\bsaw you\b/,
  /\bgood to see you\b/,
  /\bthanks for (coming|stopping|visiting)\b/,
  /\bsince your visit\b/,
  /\bwhile you were here\b/,
  /\byour last visit\b/,
  /\bhope you enjoyed\b/,
]

/** Phrasings that push the guest to come in, also barred by ruling 2. */
const VISIT_PUSHES: RegExp[] = [
  /\bcome (on )?(in|by|down|over)\b/,
  /\bswing by\b/,
  /\bstop (in|by)\b/,
  /\bpop (in|by)\b/,
  /\bsee you (soon|then|tomorrow)\b/,
  /\bwe'?d love to see you\b/,
  /\bhope to see you\b/,
]

export interface VisitVerdict {
  /** Matched phrasings that assert or ask about a visit. */
  claims: string[]
  /** Matched phrasings that push the guest to come in. */
  pushes: string[]
  /** The candidate answer to bar 2: clean on both counts. */
  clean: boolean
}

/** Bar 2: does this message ask or assert the visit, or push for one? */
export function findsVisitClaim(body: string): VisitVerdict {
  const folded = fold(body)
  const claims = VISIT_CLAIMS.filter((p) => p.test(folded)).map((p) => p.source)
  const pushes = VISIT_PUSHES.filter((p) => p.test(folded)).map((p) => p.source)
  return { claims, pushes, clean: claims.length === 0 && pushes.length === 0 }
}

export interface RepetitionVerdict {
  /** Each shared phrase and how many messages carry it, worst first. */
  phrases: { phrase: string; count: number }[]
  /** The worst count seen. */
  worst: number
  /** The bar: no phrase in more than a quarter of the set. */
  withinBar: boolean
  /** The threshold this verdict was computed against. */
  limit: number
}

/**
 * Bar 3: does any wording appear in more than a quarter of the set?
 *
 * THE BAR THE OTHER TWO MISS. Fifteen messages can each reference the right
 * things and never mention a visit and still all be the same sentence, which is
 * a voice failure no per-message check can see.
 *
 * `Math.floor(n / 4)` is the limit, so 3 of 15 is within it and 4 is not. Word
 * n-grams rather than whole bodies, because the repetition that matters is a
 * template with the specifics swapped in, not a literal duplicate.
 */
export function findsRepetition(
  bodies: readonly string[],
  gramSize = 4,
): RepetitionVerdict {
  const limit = Math.floor(bodies.length / 4)
  const seenIn = new Map<string, Set<number>>()
  bodies.forEach((body, index) => {
    const words = fold(body)
      .split(/[^a-z']+/)
      .filter(Boolean)
    for (let i = 0; i + gramSize <= words.length; i += 1) {
      const gram = words.slice(i, i + gramSize).join(' ')
      const set = seenIn.get(gram) ?? new Set<number>()
      set.add(index)
      seenIn.set(gram, set)
    }
  })

  const phrases = [...seenIn.entries()]
    .map(([phrase, set]) => ({ phrase, count: set.size }))
    .filter((p) => p.count > 1)
    .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase))

  const worst = phrases[0]?.count ?? 0
  return { phrases, worst, withinBar: worst <= limit, limit }
}

/** Voice checks that are not bars but would each be a defect. */
export interface VoiceVerdict {
  /** R3 bans em dashes in output. */
  emDash: boolean
  /** Ruled 2026-09-30: no named speaker; outreach comes from the shop. */
  namedSpeaker: string[]
  /** No loyalty-program language anywhere (root CLAUDE.md). */
  loyalty: string[]
}

const VENUE_HOSTS = ['himanshu', 'neha']
const LOYALTY = [
  'points',
  'rewards',
  'tier',
  'earn',
  'badge',
  'loyalty',
  'punch card',
]

export function findsVoiceProblems(body: string): VoiceVerdict {
  const folded = fold(body)
  return {
    emDash: body.includes('—') || body.includes('–'),
    namedSpeaker: VENUE_HOSTS.filter((n) => folded.includes(n)),
    loyalty: LOYALTY.filter((w) => folded.includes(w)),
  }
}

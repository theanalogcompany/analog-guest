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
// BAR 2 IS A LINE BETWEEN A QUESTION AND A STATEMENT (ruled 2026-10-06, which
// loosened ruling 11). The follow-up may ASK how the thing we helped with turned
// out, or whether they got to it. It may not ask whether they came in, may not
// write as though it knows they did, and may not push them to come in. So there
// are three lists, and an outcome question ("did you find a spot okay", "did you
// end up picking any up") is on none of them.
//
// The first version had one list, VISIT_CLAIMS, of interrogative and assertive
// phrasings. It flagged the outcome question the ruling now allows and missed
// the presumption it still bars: "hope your pup had a good time" names no visit
// and uses none of those phrasings. A presumption is not enumerable the way
// "did you come in" is, so VISIT_PRESUMED is wide, errs toward flagging, and is
// still only where the hand-read starts.
//
// THE DETECTORS ARE CHECKED AGAINST LABELLED SENTENCES BEFORE THEY ARE USED
// (`checkDetectors`, called by the harness at startup). A scorer nobody can
// contradict is not evidence, and this module was wrong twice without anything
// saying so.

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

/**
 * Content words, stemmed crudely so "parking" and "park" match.
 *
 * NUMBERS ARE CONTENT. The first version split on non-letters and dropped
 * anything under three characters, so "the 49", "1:16" and "17g to 250" were
 * invisible, each being the exact thing we had told the guest: bar 1 read 4 of
 * 15 where the hand-read was 12. Any token containing a digit is kept whole,
 * whatever its length. "1:16" splits into "1" and "16", which is what lets it
 * match an answer that said "1 to 16".
 */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of fold(text).split(/[^a-z0-9']+/)) {
    const word = raw.replace(/'s$/, '')
    if (/\d/.test(word)) {
      out.add(word)
      continue
    }
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
  /**
   * Does it name something we suggested that the guest's question did not
   * already contain?
   *
   * Reported BESIDE `referencesBoth`, not in place of it. Rescoring the
   * 2026-09-30 run after the digit fix still read 5 of 15 against a hand-read
   * of 12, and the digits were not why: seven bodies named our suggestion
   * ("the green awning", "the Pink Panther or the cortado") without repeating
   * a word of the question, and `referencesBoth` demands both. On that run
   * this field alone read 12 of 15 and missed the same three the hand-read
   * did. It was found by looking at that result, so it is offered as the
   * better candidate and is not the bar.
   */
  namesSuggestion: boolean
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
    namesSuggestion: sharedWithAnswerOnly.length > 0,
  }
}

/**
 * Asking whether they came in. Barred.
 *
 * Narrow on purpose: every pattern names the coming-in itself. "did you find a
 * spot", "did you get to try it" and "did you end up picking any up" ask about
 * the errand and are allowed.
 */
const VISIT_ASKS: RegExp[] = [
  /\bdid you (come|stop|swing|pop|drop) (in|by|over|through)\b/,
  /\bdid you (make|get) (it )?(in|over|down|by)\b/,
  /\bhave you (come|been|made it|stopped) (in|by|over|here)\b/,
  /\bwere you able to (come|make it|stop)\b/,
  /\bif you (made it|came|stopped|were|got) (in|by|here|over)\b/,
  /\bhow was (your|the) (visit|trip)\b/,
  // Ruled barred 2026-10-06: finding the venue is the visit.
  /\bdid you find (us|the (shop|cafe|place|spot we))\b/,
  // An ask in statement form, found in the 2026-10-06 treatment run: "hope you
  // got a chance to bring your pup by". It presumes nothing, and it is still
  // about the coming-in and not about how our help turned out.
  /\bhope you (got|get|had|found) (a|the) (chance|time) to (come|stop|swing|pop|drop|bring|make it)\b/,
]

/**
 * Writing as though we know they came in. Barred, and the gap the first
 * version could not see.
 *
 * Two shapes. The explicit ones name the visit ("good to see you", "while you
 * were here"). The presumptions describe the guest, or someone or something
 * with them, as having had or enjoyed something: "hope your pup had a good
 * time". "Hope the parking worked out" is NOT one: it is about our help, it
 * describes nobody, and it was ruling 11's own example of an acceptable line.
 *
 * WIDE ON PURPOSE. A false positive costs a hand-read that disagrees; a false
 * negative ships a claim about the guest's movements that nothing else in the
 * pipeline can contradict.
 */
const VISIT_PRESUMED: RegExp[] = [
  /\bhope (you|y'all|your [a-z' ]{1,24}?|they|she|he) (all |both )?(had|enjoyed|liked|loved)\b/,
  /\b(glad|happy|great|good|nice) (that )?(you|your [a-z' ]{1,24}?) (came|made it|stopped|enjoyed|liked|loved|had)\b/,
  /\b(good|great|nice|lovely) (to see|seeing|having) (you|y'all)\b/,
  /\bsaw you\b/,
  /\bthanks for (coming|stopping|visiting|swinging)\b/,
  /\bsince your visit\b/,
  /\bwhile you were (here|in)\b/,
  /\byour (last|next|recent) visit\b/,
  /\bwhen you (came|were) (in|here|by)\b/,
  /\byou (came|stopped|swung|popped) (in|by|through)\b/,
  /\b(had|enjoyed|liked|loved) [a-z' ]{0,30}?\b(here|with us)\b/,
  // Found in the 2026-10-06 control run, which the lines above read as clean:
  // "hoping the Pink Panther or the cortado hit the spot for you" states that
  // they had the drink. A hope about how something we recommended WAS.
  /\b(hope|hoping) [a-z' ,]{0,48}?\b(hit the [a-z ]{0,16}?(spot|note|notes|mark)|went down|was (good|great|tasty|nice))\b/,
  // Both ruled barred 2026-10-06, from the control run. "hoping it was the
  // cocoa hit you were after" says they had it; "hope the corner table worked
  // out for your dog" seats the dog. "worked out for you" stays allowed.
  /\b(hope|hoping) (it|that|they) (was|were)\b/,
  // A HOPE only. "did the corner table work out for your pup?" is a question
  // about the thing, which the ruling allows, and the second treatment run
  // showed the unanchored pattern flagging it.
  /\b(hope|hoping) [a-z' ,]{0,48}?\bwork(ed)? out for (your|the) (dog|pup|puppy|kid|kids|friend|friends|family|group)\b/,
]

/** Phrasings that push the guest to come in, also barred by ruling 2. */
const VISIT_PUSHES: RegExp[] = [
  // Not "come in handy", which the second treatment run produced.
  /\bcome (on )?(in|by|down|over)\b(?! handy)/,
  /\bswing by\b/,
  /\bstop (in|by)\b/,
  /\bpop (in|by)\b/,
  /\bsee you (soon|then|tomorrow)\b/,
  /\bwe'?d love to see you\b/,
  /\bhope to see you\b/,
]

export interface VisitVerdict {
  /** Matched phrasings that ask whether they came in. */
  asks: string[]
  /** Matched phrasings that write as though we know they came in. */
  presumed: string[]
  /** Matched phrasings that push the guest to come in. */
  pushes: string[]
  /** The candidate answer to bar 2: clean on all three counts. */
  clean: boolean
}

/** Bar 2: does this message ask about the visit, presume it, or push for one? */
export function findsVisitClaim(body: string): VisitVerdict {
  const folded = fold(body)
  const matches = (patterns: readonly RegExp[]) =>
    patterns.filter((p) => p.test(folded)).map((p) => p.source)
  const asks = matches(VISIT_ASKS)
  const presumed = matches(VISIT_PRESUMED)
  const pushes = matches(VISIT_PUSHES)
  return {
    asks,
    presumed,
    pushes,
    clean: asks.length === 0 && presumed.length === 0 && pushes.length === 0,
  }
}

/**
 * Sentences with a known verdict, from the rulings and from bodies the first
 * measurement runs produced. Each `clean: false` row names the list that must
 * catch it, so a pattern moved to the wrong list fails here too.
 */
const VISIT_CASES: {
  body: string
  clean: boolean
  via?: 'asks' | 'presumed' | 'pushes'
}[] = [
  // Allowed by name in the 2026-10-06 ruling.
  { body: 'did you find a spot okay?', clean: true },
  { body: "how'd the pour over turn out?", clean: true },
  // Outcome questions the first version flagged and the ruling allows.
  { body: 'did you end up picking any up?', clean: true },
  { body: 'did you get to try the cardamom bun?', clean: true },
  // Ruling 11's own example. A hope about our help, describing nobody.
  { body: 'hope the parking worked out', clean: true },
  // Barred by name in the 2026-10-06 ruling.
  { body: 'hope your pup had a good time here', clean: false, via: 'presumed' },
  // The 2026-09-30 body, which has no "here" to catch it by.
  { body: 'hope your pup had a good time 🐾', clean: false, via: 'presumed' },
  { body: 'hope you enjoyed the cortado', clean: false, via: 'presumed' },
  {
    body: 'hoping the Pink Panther or the cortado hit the spot for you.',
    clean: false,
    via: 'presumed',
  },
  {
    body: 'let us know if you have any questions before your next visit',
    clean: false,
    via: 'presumed',
  },
  { body: 'did you make it in?', clean: false, via: 'asks' },
  { body: 'hey, did you find us okay?', clean: false, via: 'asks' },
  {
    body: 'hoping it was the cocoa hit you were after',
    clean: false,
    via: 'presumed',
  },
  {
    body: 'hope the corner table worked out for your dog',
    clean: false,
    via: 'presumed',
  },
  { body: 'hope the parking tip worked out for you', clean: true },
  { body: 'did the corner table work out for your pup? 🐾', clean: true },
  { body: 'did the water bowl come in handy?', clean: true },
  {
    body: 'hoping it hit the right note for you.',
    clean: false,
    via: 'presumed',
  },
  {
    body: 'hope you got a chance to bring your pup by 🐾',
    clean: false,
    via: 'asks',
  },
  { body: 'hope it helped if you made it in', clean: false, via: 'asks' },
  { body: 'swing by whenever', clean: false, via: 'pushes' },
]

/**
 * Run both detectors over sentences whose verdict is known, and return every
 * disagreement. Empty means they agree with every label.
 *
 * The harness calls this before spending a generation and refuses to run on a
 * non-empty result: a bar read off a detector that mislabels the ruling's own
 * examples is not a measurement.
 */
export function checkDetectors(): string[] {
  const problems: string[] = []
  for (const c of VISIT_CASES) {
    const verdict = findsVisitClaim(c.body)
    if (verdict.clean !== c.clean) {
      problems.push(
        `bar 2: ${JSON.stringify(c.body)} should be ${c.clean ? 'clean' : 'flagged'} and was not`,
      )
    } else if (c.via !== undefined && verdict[c.via].length === 0) {
      problems.push(
        `bar 2: ${JSON.stringify(c.body)} was flagged, but not as ${c.via}`,
      )
    }
  }

  // Bar 1 must see a number we gave them, in both of the forms it took.
  const bus = findsReference(
    'did the 49 get you over alright?',
    'whats the easiest way to get to you from the mission',
    'The 49 drops you two blocks away, or BART to Civic Center.',
  )
  if (!bus.sharedWithAnswerOnly.includes('49')) {
    problems.push('bar 1: "the 49" is invisible to the reference check')
  }
  const ratio = findsReference(
    'how did the 1:16 come out?',
    'how should I brew the beans I got from you',
    'A 1 to 16 ratio, water just off the boil.',
  )
  if (!ratio.sharedWithAnswerOnly.includes('16')) {
    problems.push('bar 1: "1:16" does not match an answer that said "1 to 16"')
  }
  // And must still refuse a body that names only the topic.
  const topicOnly = findsReference(
    'hope the beans info was helpful!',
    'which bag should I buy if I like something chocolatey',
    'The Colombia is the one, it leans cocoa and brown sugar.',
  )
  if (topicOnly.namesSuggestion) {
    problems.push(
      'bar 1: a body naming only the topic passes as naming our suggestion',
    )
  }
  return problems
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

/**
 * Capitalised words in the body that neither the question nor our answer
 * contains: a candidate list for "added a fact we did not say".
 *
 * Ruled 2026-10-06 to carry the same weight as presuming the visit, after a
 * body named "the lot on Bush and Polk" where our answer said a garage on Clay.
 * A NARROW INSTRUMENT, and it says so: it sees an invented proper noun and
 * nothing else. An invented "lot", price or opening time is lower-case and
 * invisible here, so an empty list is not a clean bill. The hand-read is.
 */
export function findsUnsaidNames(
  body: string,
  question: string,
  answer: string,
): string[] {
  const said = new Set(
    fold(`${question} ${answer}`)
      .split(/[^a-z0-9']+/)
      .filter(Boolean),
  )
  const unsaid = new Set<string>()
  // Skip each sentence's first word, which is capitalised for another reason.
  for (const sentence of body.split(/[.!?\n]+/)) {
    const words = sentence.trim().split(/\s+/).slice(1)
    for (const raw of words) {
      const word = raw.replace(/[^A-Za-z']/g, '')
      if (!/^[A-Z][a-z]+/.test(word)) continue
      if (!said.has(fold(word).replace(/'s$/, ''))) unsaid.add(word)
    }
  }
  return [...unsaid].sort()
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

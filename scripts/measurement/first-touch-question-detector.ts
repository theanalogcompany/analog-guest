// TAC-423: the pure detector behind the first-touch measurement.
//
// Two questions per reply, and they are deliberately different in kind:
//
//   hasQuestion     — did the reply ask ANYTHING at all? This is the metric
//                     the ruling's stop condition is written against, so it is
//                     kept as mechanical as it can be: a sentence ending in a
//                     question mark. It is not a judgement.
//   isOrderQuestion — was that question about what the guest got? This one
//                     cannot be mechanical, so the matched phrase and the
//                     question sentence are BOTH reported and the verdict is
//                     auditable line by line in the run log rather than
//                     collapsed into a number nobody can check.
//
// WHAT hasQuestion CANNOT SEE, stated rather than left to be discovered: a
// question written without a question mark ("wondering what you went with").
// Casual venue voice does that. It therefore UNDERCOUNTS questions, on both
// arms equally, so a difference between arms survives the limitation even
// though an absolute rate is a floor rather than a point. `impliedAsk` is
// reported alongside as a secondary, non-authoritative signal so a run can say
// how much is hiding under that floor.

export interface FirstTouchVerdict {
  hasQuestion: boolean
  questionSentences: string[]
  isOrderQuestion: boolean
  orderPhrase: string | null
  impliedAsk: boolean
  namesSomeone: boolean
  thanks: boolean
}

// Phrases that make a question an ORDER question. Matched against the question
// sentence only, never the whole body, so "what did you get" in a statement
// elsewhere cannot count. Lowercased, punctuation-insensitive at the edges.
// An ORDER question, as a pattern rather than an exact phrase list.
//
// The list shape has now broken twice, each time asymmetrically and each time
// against whichever arm was NOT echoing a script. First contractions, then an
// adverb: the opener says "Ask what they just got", so the model writes "what
// did you just grab?" and a list holding "what did you get" misses it. The
// adverb slot is what stops the next wording breaking it again.
//
// Anchored on "what did/do you", never on a loose "what ... got", so
// "how was whatever you got?" does NOT match: that is did_they_like_it, a
// different intention, and counting it would inflate the arm instead.
const ORDER_PATTERNS: readonly RegExp[] = [
  /\bwhat (?:did|do) you (?:just |already |end up |finally |actually )?(?:get|getting|got|grab|grabbing|order|ordering|pick up|pick|have|try|go with|settle on|land on)\b/,
  /\bwhat (?:are|were) you (?:picking up|drinking|having|getting)\b/,
  /\bwhat(?:'s| is| was) (?:in your hand|it)\b/,
  /\bwhat you (?:got|get|end(?:ed)? up with)\b/,
  /\bwhich one did you (?:get|go with|pick|grab)\b/,
  /\bwhat did you end up with\b/,
]


// An ask with no question mark. Secondary only.
const IMPLIED_ASK_PHRASES = [
  'let me know what',
  'tell me what',
  'curious what',
  'wondering what',
  'i want to know what',
]

// CONTRACTIONS ARE EXPANDED BEFORE MATCHING, and this is not a tidy-up.
//
// The first live run scored the AFTER arm 0/3 on the order question while
// two of those three replies asked it outright, as "what'd you get?". The
// phrase list held only the uncontracted form. The undercount was ASYMMETRIC
// and in the direction that flatters reverting: the BEFORE arm's opener
// literally scripts "ask what they got", so the model echoes the long form
// and matches, while the AFTER arm, with no script to echo, writes the way a
// person texts and did not. A detector that misses one arm more than the
// other does not measure a difference between arms, it manufactures one.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\bwhat'd\b/g, 'what did')
    .replace(/\bwhat're\b/g, 'what are')
    .replace(/\bd'you\b/g, 'do you')
    .replace(/\s+/g, ' ')
}

/**
 * Split into sentences well enough to isolate the ones ending in '?'.
 * Deliberately simpler than lib/agent/sentence-split.ts: that one decides how
 * a reply is DISPATCHED and has to be conservative about false splits, while
 * this one only has to find question marks, and over-splitting costs nothing.
 */
export function sentencesOf(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function classifyFirstTouchReply(body: string): FirstTouchVerdict {
  const sentences = sentencesOf(body)
  const questionSentences = sentences.filter((s) => s.includes('?'))
  const normalizedQuestions = questionSentences.map(normalize)
  const orderPhrase =
    normalizedQuestions
      .flatMap((q) => ORDER_PATTERNS.map((re) => re.exec(q)?.[0] ?? null))
      .find((m): m is string => m !== null) ?? null
  const normalizedBody = normalize(body)
  return {
    hasQuestion: questionSentences.length > 0,
    questionSentences,
    isOrderQuestion: orderPhrase !== null,
    orderPhrase,
    impliedAsk: IMPLIED_ASK_PHRASES.some((p) => normalizedBody.includes(p)),
    namesSomeone: /\bhimanshu\b/i.test(body) || /le mil/i.test(body),
    thanks: /\bthank(s| you)\b/i.test(body),
  }
}

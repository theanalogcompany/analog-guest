// TAC-560: the pure detector behind the warm-close measurement.
//
// The primary bar is "each close names all three topics", and that is HAND-READ,
// per the acceptance criteria. What this module does is narrow the reading: it
// reports, per close, which of the three it can find, so the hand-read starts
// from a candidate answer rather than fifteen bodies and no structure. A
// disagreement between the two is the finding, never something to smooth over.
//
// WHY IT CANNOT BE THE VERDICT. Rule 15 says "say it in your own words", so each
// topic arrives paraphrased: "what's in the cup", "what we're pouring this week",
// "anything we've got coming up". A phrase list is exactly the instrument this
// repo has recorded failing twice on this shape (TAC-423's detector asymmetry:
// the arm NOT echoing a script is the one a phrase list under-counts, and the
// error always flatters the control). So the lists below are deliberately WIDE,
// biased to recall, and every miss is printed with its body for reading.
//
// The three topics are Le Mil's, from that venue's rule 15. They live here, in a
// measurement script for one venue, and NOT in shared prompt copy: the prompt
// block names no topic precisely so another venue's close would name its own.

/** Which of Le Mil's three topics a close appears to name. */
export interface TopicVerdict {
  /** Questions about our coffee and beans. */
  coffee: boolean
  /** The menu, specials, and recommendations for next time. */
  menu: boolean
  /** Events and what's coming up. */
  events: boolean
  /** All three, which is the bar. */
  allThree: boolean
  /** The matched substring per topic, for the hand-read. */
  matched: { coffee: string | null; menu: string | null; events: string | null }
}

function fold(body: string): string {
  return body
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
}

/**
 * Wide on purpose. A false positive costs a hand-read that disagrees, which is
 * visible; a false negative would report a working close as broken and is the
 * direction that has misled this project before.
 */
const TOPIC_PATTERNS: Record<'coffee' | 'menu' | 'events', RegExp[]> = {
  coffee: [
    /\bbeans?\b/,
    /\bcoffee\b/,
    /\broast(s|ing|ed)?\b/,
    /\bbrew(s|ing)?\b/,
    /\borigins?\b/,
    /\bsourc(e|es|ing)\b/,
    /\bwhat'?s in (the|your) cup\b/,
    /\btasting notes?\b/,
  ],
  menu: [
    /\bmenu\b/,
    /\bspecials?\b/,
    /\brecommend(ation|ations|s|ing)?\b/,
    /\brecs?\b/,
    /\bwhat to (try|order|get)\b/,
    /\bnext time\b/,
    /\bwhat we'?re pouring\b/,
    /\bnew drinks?\b/,
    /\bpastr(y|ies)\b/,
  ],
  events: [
    /\bevents?\b/,
    /\bwhat'?s coming up\b/,
    /\bcoming up\b/,
    /\bwhat'?s on\b/,
    /\bhappening\b/,
    /\bpop[- ]?ups?\b/,
    /\bcupping(s)?\b/,
    /\bworkshops?\b/,
  ],
}

export function findTopics(body: string): TopicVerdict {
  const folded = fold(body)
  const matched = {
    coffee: null,
    menu: null,
    events: null,
  } as TopicVerdict['matched']
  for (const topic of ['coffee', 'menu', 'events'] as const) {
    for (const pattern of TOPIC_PATTERNS[topic]) {
      const m = pattern.exec(folded)
      if (m) {
        matched[topic] = m[0]
        break
      }
    }
  }
  const coffee = matched.coffee !== null
  const menu = matched.menu !== null
  const events = matched.events !== null
  return { coffee, menu, events, allThree: coffee && menu && events, matched }
}

/**
 * Does the close ask the guest a question?
 *
 * A CEILING, not a metric. The prompt block says not to, and a close that asks
 * something reopens the conversation it is closing, so one occurrence fails the
 * run whatever the other rates say (the TAC-519 lesson: a ceiling breach fails an
 * arm at any rate, and read as a rate it looks dismissible).
 */
export function asksAQuestion(body: string): boolean {
  return body.includes('?')
}

/**
 * Does the close mention the silence?
 *
 * The other ceiling. "Sorry for the wait", "you went quiet", "haven't heard from
 * you" all narrate the pause, which the block forbids and which reads as a
 * reproach. TAC-484's incident was exactly an invented wait.
 */
export function mentionsThePause(body: string): string | null {
  const folded = fold(body)
  const patterns = [
    /\bsorry for the wait\b/,
    /\bwent quiet\b/,
    /\bhaven'?t heard\b/,
    /\bno (reply|response)\b/,
    /\bstill (there|around)\b/,
    /\bif you'?re still\b/,
    /\bbefore you go\b/,
  ]
  for (const p of patterns) {
    const m = p.exec(folded)
    if (m) return m[0]
  }
  return null
}

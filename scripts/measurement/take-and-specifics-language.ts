/**
 * TAC-548. The pure half of the "keep the honest take, add the specifics"
 * measurement: given one reply, did it use the specifics the venue's own
 * knowledge entry holds, and did it keep a personal take?
 *
 * WHAT THIS MODULE IS AND IS NOT. Two of the ticket's three headline metrics
 * are judgements, not string matches, and this repo has paid twice for a
 * phrase-list detector scoring free-form replies (TAC-423, which under-counted
 * whichever arm was not echoing a script, twice, in the same ticket). So the
 * PRIMARY numbers in this run come from an LLM judge that is handed the actual
 * knowledge entry, and everything here is a deterministic CROSS-CHECK printed
 * beside it. Where the two disagree, the run prints both and the bodies, which
 * is the point: Jaipal reads the replies and decides.
 *
 * Read the two rates accordingly:
 *   - `countSpecificHits` is a FLOOR. It matches listed variants only, so a
 *     paraphrase nobody anticipated ("chocolatey" for "dark chocolate" when
 *     that variant is absent) scores as a miss. It can undercount, never
 *     overcount.
 *   - `findPersonalTake` is RECALL-BIASED and reports its matches so a verdict
 *     can be read rather than trusted. A take phrased without any of these
 *     markers is invisible to it. It is deliberately NOT the number the
 *     ticket's "must not be lower than the control" bar is read from.
 *
 * The two "no new problems" checks are NOT reimplemented here. They are
 * imported from the TAC-544 and TAC-541 harnesses by the runner, so a rule
 * added there reaches this run without an edit.
 */

/** One fact the venue's own entry holds, with the wordings that count as using it. */
export interface Specific {
  /** What the fact is, for the report. */
  label: string
  /** Any one of these appearing counts as the fact being used. */
  variants: readonly string[]
}

export interface SpecificsVerdict {
  /** How many distinct specifics the reply used. */
  hits: number
  /** Of how many the entry holds. */
  available: number
  /** Which ones, by label, so a verdict can be read. */
  hitLabels: string[]
  /** The matched text for each, so a false positive is visible. */
  matches: string[]
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A variant matches on word boundaries at both ends, which is the TAC-326
 * lesson: unanchored containment matched "san" inside "Hi Sana!" and "ice"
 * inside "nice". A multi-word variant is matched as a phrase with flexible
 * inner whitespace so a line break does not hide it.
 */
function containsVariant(text: string, variant: string): string | null {
  const v = fold(variant).trim()
  if (v.length === 0) return null
  const pattern = v.split(' ').map(escapeRe).join('\\s+')
  const re = new RegExp(`(?<![a-z0-9])${pattern}(?![a-z0-9])`, 'i')
  const m = re.exec(text)
  return m ? m[0] : null
}

export function countSpecificHits(
  body: string,
  specifics: readonly Specific[],
): SpecificsVerdict {
  const text = fold(body)
  const hitLabels: string[] = []
  const matches: string[] = []
  for (const spec of specifics) {
    for (const variant of spec.variants) {
      const m = containsVariant(text, variant)
      if (m !== null) {
        hitLabels.push(spec.label)
        matches.push(m)
        break
      }
    }
  }
  return { hits: hitLabels.length, available: specifics.length, hitLabels, matches }
}

/**
 * Markers of an opinion, a reaction, or an honest aside, as opposed to a
 * statement of fact. Drawn from the reply Jaipal named as the voice WORKING
 * ("Bhadra is intense, honestly"), so the shapes are: a hedge that admits a
 * view ("honestly", "to be fair"), a first-person preference ("I love",
 * "my pick"), an intensity word doing the work of an opinion ("intense",
 * "unreal"), and a direct address of the guest's own taste ("if you like").
 *
 * Deliberately recall-biased: a false positive here is visible in the printed
 * match, and a false NEGATIVE would silently deflate the arm that kept its
 * take, which is the metric the ticket guards. Never read a count from this
 * alone; the judge is the primary source and the bodies are the real one.
 */
export const TAKE_MARKERS: readonly RegExp[] = [
  /\bhonestly\b/i,
  /\bto be (?:fair|honest)\b/i,
  /\bnot gonna lie\b/i,
  /\bpersonally\b/i,
  /\bi(?:'| a)?m (?:a )?(?:big )?fan\b/i,
  /\bi (?:love|like|prefer|reach for|go for|swear by|adore)\b/i,
  /\bmy (?:favou?rite|pick|go.?to)\b/i,
  /\bit'?s (?:my|the) (?:favou?rite|pick|go.?to)\b/i,
  /\b(?:favou?rite|underrated|overrated)\b/i,
  /\b(?:intense|unreal|incredible|gorgeous|lovely|stunning|wild|bold|punchy|serious)\b/i,
  /\b(?:so|really|genuinely|properly|seriously) good\b/i,
  /\bif you (?:like|want|are into|'re into)\b/i,
  /\bworth (?:it|a|the)\b/i,
  /\bdepends (?:on )?(?:what|how|if)\b/i,
  /\bi'?d (?:say|start|go|steer|point)\b/i,
  /\bwarning\b/i,
  /\bhits (?:hard|different)\b/i,
  /\bnot for everyone\b/i,
  /\bsneaks? up\b/i,
]

export interface TakeVerdict {
  /** At least one marker fired. */
  hasTake: boolean
  /** The matched spans, so a verdict can be read rather than trusted. */
  matches: string[]
}

export function findPersonalTake(body: string): TakeVerdict {
  const matches: string[] = []
  for (const re of TAKE_MARKERS) {
    const m = re.exec(body)
    if (m) matches.push(m[0])
  }
  return { hasTake: matches.length > 0, matches }
}

export interface RepeatedPhrase {
  phrase: string
  /** How many of the arm's replies contain it. Replies, not occurrences. */
  replies: number
}

/**
 * Phrases appearing in more than `maxShare` of an arm's replies. The ticket's
 * ceiling is a quarter, and it is about a TEMPLATE forming, so this counts
 * REPLIES containing the phrase rather than total occurrences: one reply that
 * repeats itself is a different problem.
 *
 * n-grams are taken over folded text so punctuation and case cannot hide a
 * repeat. Sub-phrases of a longer repeated phrase are dropped, so one template
 * reports as one finding rather than as every window inside it.
 */
export function repeatedPhrases(
  replies: readonly string[],
  options: { n?: number; maxShare?: number } = {},
): RepeatedPhrase[] {
  const n = options.n ?? 5
  const maxShare = options.maxShare ?? 0.25
  // A phrase in ONE reply is never a repeated phrasing, whatever the share
  // arithmetic says. Below eight replies a quarter-share is less than two, so
  // without this floor a single reply trips the ceiling and a small run reports
  // a template that does not exist (seen on a two-question smoke run).
  const threshold = Math.max(replies.length * maxShare, 1)

  const perReply = replies.map((r) => {
    const words = fold(r).replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean)
    const grams = new Set<string>()
    for (let i = 0; i + n <= words.length; i += 1) {
      grams.add(words.slice(i, i + n).join(' '))
    }
    return grams
  })

  const counts = new Map<string, number>()
  for (const grams of perReply) {
    for (const g of grams) counts.set(g, (counts.get(g) ?? 0) + 1)
  }

  const over = [...counts.entries()]
    .filter(([, c]) => c > threshold)
    .map(([phrase, replyCount]) => ({ phrase, replies: replyCount }))
    .sort((a, b) => b.replies - a.replies || a.phrase.localeCompare(b.phrase))

  // MERGE OVERLAPPING WINDOWS INTO ONE FINDING. A repeated phrase longer than
  // n produces several over-threshold n-grams, each overlapping the next by
  // n-1 words and none containing another, so a contains-check alone reports
  // one template as four findings and the ceiling reads as four breaches. Chain
  // grams that share a reply count and overlap by n-1 into the maximal phrase.
  const merged: RepeatedPhrase[] = []
  for (const group of groupBy(over, (p) => p.replies)) {
    const remaining = new Set(group.map((p) => p.phrase))
    while (remaining.size > 0) {
      let phrase = [...remaining][0] as string
      remaining.delete(phrase)
      let grew = true
      while (grew) {
        grew = false
        for (const candidate of [...remaining]) {
          const cWords = candidate.split(' ')
          const pWords = phrase.split(' ')
          // The overlap is n-1 words. Compare the TAIL of the phrase against
          // the head of the candidate, not phrase.slice(1): once the phrase has
          // grown past n those are different lengths and every further merge
          // silently fails, which is what left one template reporting as three.
          const tail = pWords.slice(-(n - 1)).join(' ')
          const head = pWords.slice(0, n - 1).join(' ')
          if (tail === cWords.slice(0, -1).join(' ')) {
            phrase = `${phrase} ${cWords[cWords.length - 1]}`
            remaining.delete(candidate)
            grew = true
          } else if (cWords.slice(1).join(' ') === head) {
            phrase = `${cWords[0]} ${phrase}`
            remaining.delete(candidate)
            grew = true
          }
        }
      }
      merged.push({ phrase, replies: group[0]?.replies ?? 0 })
    }
  }

  // Then drop anything fully contained in a longer finding: a shorter template
  // inside a longer one is the same template.
  return merged
    .filter(
      (p) => !merged.some((q) => q !== p && q.phrase.includes(p.phrase) && q.replies >= p.replies),
    )
    .sort((a, b) => b.replies - a.replies || a.phrase.localeCompare(b.phrase))
}

function groupBy<T>(items: readonly T[], key: (item: T) => number): T[][] {
  const map = new Map<number, T[]>()
  for (const item of items) {
    const k = key(item)
    const bucket = map.get(k)
    if (bucket) bucket.push(item)
    else map.set(k, [item])
  }
  return [...map.values()]
}

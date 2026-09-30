/**
 * TAC-547 — pure detector for the Bhadra end-to-end arm.
 *
 * A CANDIDATE FLAG, not a verdict. It reports which brewing method a reply
 * names; whether the reply is right is settled by reading the ten bodies the
 * run prints. Kept pure and tested so the number a run prints means the same
 * thing twice.
 *
 * The correct answer for Bhadra is espresso, moka pot or drip, with milk. The
 * wrong one is the Budan pour-over recipe (1:15, 21-22g), which is what the
 * 2026-09-28 device draft produced.
 */
export type BhadraVerdict = {
  namesCorrectMethod: boolean
  namesPourOver: boolean
  namesMilk: boolean
  namesPourOverRecipeNumbers: boolean
  matched: string[]
}

const CORRECT_METHOD = [/\bespresso\b/i, /\bmoka\b/i, /\bdrip\b/i]
// "pour over", "pour-over", "pourover", and the V60 it is made with.
const POUR_OVER = [/\bpour[\s-]?over\b/i, /\bv60\b/i]
const MILK = [/\bmilk\b/i, /\blatte\b/i, /\bcortado\b/i]
// The Budan recipe's own numbers. Their presence in a Bhadra answer is the
// device failure verbatim, whether or not the words "pour over" appear.
const RECIPE_NUMBERS = [
  /1\s*[:/]\s*1[56]\b/,
  /\b2[12]\s*[-–—]?\s*2?2?\s*g(?:rams)?\b/i,
]

function hits(body: string, patterns: RegExp[]): string[] {
  return patterns.flatMap((p) => {
    const m = body.match(p)
    return m ? [m[0]] : []
  })
}

export function classifyBhadraReply(body: string): BhadraVerdict {
  const correct = hits(body, CORRECT_METHOD)
  const pourOver = hits(body, POUR_OVER)
  const milk = hits(body, MILK)
  const numbers = hits(body, RECIPE_NUMBERS)
  return {
    namesCorrectMethod: correct.length > 0,
    namesPourOver: pourOver.length > 0,
    namesMilk: milk.length > 0,
    namesPourOverRecipeNumbers: numbers.length > 0,
    matched: [...correct, ...pourOver, ...milk, ...numbers],
  }
}

/**
 * The ticket's bar: "espresso or moka pot and milk, not pour over".
 * Both halves required, and the pour-over recipe numbers disqualify even when
 * the words are absent.
 */
export function meetsBar(v: BhadraVerdict): boolean {
  return (
    v.namesCorrectMethod &&
    v.namesMilk &&
    !v.namesPourOver &&
    !v.namesPourOverRecipeNumbers
  )
}

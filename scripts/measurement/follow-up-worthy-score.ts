// TAC-386: the arithmetic behind arm A, the followUpWorthy classifier run.
//
// Pure, and separated from the runner so it needs no model call.
//
// THE LABELS COME FIRST. Every case carries a hand-assigned `expected` written
// BEFORE the run, which is what makes precision mean anything: scoring a
// classifier against labels derived from its own output measures nothing, and
// that is the specific failure this repo keeps recording.

/** One labelled inbound and what the classifier said about it. */
export interface ScoredCase {
  /** Where it came from, for the report. A real message id or a fixture name. */
  id: string
  body: string
  /** Hand-assigned, before the run. */
  expected: boolean
  /** What the classifier returned. */
  actual: boolean
  /** The classifier's own one-line reasoning, for reading disagreements. */
  reasoning?: string
}

export interface Confusion {
  truePositives: number
  falsePositives: number
  trueNegatives: number
  falseNegatives: number
}

export interface ArmScore extends Confusion {
  name: string
  total: number
  /**
   * Of the messages it called follow-up-worthy, how many were.
   *
   * `null` when it called none, which is NOT 1: a classifier that never fires
   * has undefined precision, and reporting 100% there is the flattering error.
   */
  precision: number | null
  /** Of the messages that were, how many it found. `null` when there were none. */
  recall: number | null
  /** Every case it got wrong, for reading. */
  disagreements: ScoredCase[]
}

export function scoreArm(name: string, cases: readonly ScoredCase[]): ArmScore {
  const truePositives = cases.filter((c) => c.expected && c.actual).length
  const falsePositives = cases.filter((c) => !c.expected && c.actual).length
  const trueNegatives = cases.filter((c) => !c.expected && !c.actual).length
  const falseNegatives = cases.filter((c) => c.expected && !c.actual).length
  const predictedPositive = truePositives + falsePositives
  const actualPositive = truePositives + falseNegatives
  return {
    name,
    total: cases.length,
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    precision:
      predictedPositive === 0 ? null : truePositives / predictedPositive,
    recall: actualPositive === 0 ? null : truePositives / actualPositive,
    disagreements: cases.filter((c) => c.expected !== c.actual),
  }
}

/**
 * A named false-positive arm and its verdict.
 *
 * Its bar is ZERO: every case is hand-labelled `expected: false`, so any
 * positive is a false positive and the arm fails. Ruling 1 of 2026-09-17
 * excluded a bare hours question and the 2026-09-30 widening kept that, plus
 * small talk, business inquiries and complaints.
 */
export interface FalsePositiveArm {
  name: string
  score: ArmScore
  /** The bar. */
  passed: boolean
  /** The bodies that fired, which is what a failure report has to show. */
  fired: ScoredCase[]
}

export function scoreFalsePositiveArm(
  name: string,
  bodies: readonly {
    id: string
    body: string
    actual: boolean
    reasoning?: string
  }[],
): FalsePositiveArm {
  const cases: ScoredCase[] = bodies.map((b) => ({ ...b, expected: false }))
  const score = scoreArm(name, cases)
  const fired = cases.filter((c) => c.actual)
  return { name, score, passed: fired.length === 0, fired }
}

/**
 * The classifier's output-token headroom against its own cap.
 *
 * Nothing measures this today, and the field ordering is why it matters:
 * `reasoning` is unbounded free text and precedes all three booleans in
 * `ClassifiedMessageSchema`, which is the ordering that truncated generation in
 * TAC-309 and the grounding check in TAC-367. A third boolean makes the tail
 * longer.
 */
export interface HeadroomReport {
  cap: number
  /** Output tokens per call, as the provider reported them. */
  samples: number[]
  max: number
  mean: number
  /** How close the worst call came to the cap, as a fraction of it. */
  worstUtilisation: number
  /**
   * Did any call hit the cap exactly? That is the signal for truncation, and it
   * is a finding rather than a number to note.
   */
  anyAtCap: boolean
}

export function scoreHeadroom(
  cap: number,
  samples: readonly number[],
): HeadroomReport {
  const list = [...samples]
  const max = list.length === 0 ? 0 : Math.max(...list)
  const mean =
    list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length
  return {
    cap,
    samples: list,
    max,
    mean,
    worstUtilisation: cap === 0 ? 0 : max / cap,
    anyAtCap: list.some((n) => n >= cap),
  }
}

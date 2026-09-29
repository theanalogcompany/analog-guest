// TAC-554: the pure scorer behind scripts/measurement/intention-bubble.ts.
//
// Split out of the runner for the reason every -language.ts module in this
// folder is: the runner spends model calls, so its scoring has to be testable
// without them, and a detector whose own behaviour is unverified is how two
// TAC-423 runs reported numbers nobody could act on.
//
// THE JUDGE IS PRODUCTION'S OWN classifyIntentionPrompts, NOT A PHRASE LIST,
// and that is the whole reason this scorer is safe to compare arms with.
// TAC-423's harness broke twice on the same asymmetry: a phrase list matched
// the arm that echoed a script and missed the arm writing freely, so the error
// always flattered the control. Here both arms are scored by the same three
// model calls on the same three strings, and this module only combines their
// verdicts. There is no phrase list to fall behind a paraphrase.
//
// The three verdicts, per unit:
//   whole   — the keys the complete reply raises. This is what "an intention
//             was raised on this turn" means, and it is the denominator.
//   last    — the keys the LAST bubble alone raises.
//   earlier — the keys the non-last bubbles, joined, raise.
//
// A turn met the ruling when the last bubble raises the intention and nothing
// before it does. That phrasing is arm-symmetric by construction: on the
// control arm the question is inline, so either there is one bubble (earlier is
// empty but there is no separate bubble) or the raising text sits in an earlier
// bubble. Both fail, for the right reason, with no special-casing per arm.

/** MAX_BUBBLES_PER_RESPONSE, restated rather than imported. */
// Deliberately NOT imported from lib/agent/split-message: a scorer that reads
// the constant under test agrees with it by construction, so a change raising
// the cap would silently raise this ceiling too. Bound to the shipped value by
// a test that DOES import it, which is where a divergence should fail.
export const MAX_BUBBLES_CEILING = 3

export interface JudgeVerdicts {
  whole: readonly string[]
  last: readonly string[]
  earlier: readonly string[]
}

export interface UnitInput {
  bubbles: readonly string[]
  /** '' on the control arm, where the field does not exist. */
  intentionQuestion: string
  judge: JudgeVerdicts
}

export type CeilingBreach =
  /** More bubbles than TAC-319 permits. Four stops reading as texting. */
  | 'too_many_bubbles'
  /** A bubble that is empty or whitespace-only. */
  | 'empty_bubble'
  /** A bubble with no letter or digit: punctuation or an emoji alone. */
  | 'contentless_bubble'
  /**
   * The structural identity failed: a non-empty intentionQuestion is not
   * exactly the last bubble. Only reachable on an arm that has the field, and
   * it is the one check that says the MECHANISM is wrong rather than the
   * model's text. If this ever fires, the composition and the slice disagree.
   */
  | 'tail_not_last_bubble'

export interface UnitVerdict {
  raised: boolean
  separateLastBubble: boolean
  breaches: CeilingBreach[]
  pass: boolean
}

/** A bubble carries content when it has at least one letter or digit. */
export function hasContent(bubble: string): boolean {
  return /[\p{L}\p{N}]/u.test(bubble)
}

export function scoreUnit(input: UnitInput): UnitVerdict {
  const { bubbles, intentionQuestion, judge } = input
  const breaches: CeilingBreach[] = []

  if (bubbles.length > MAX_BUBBLES_CEILING) breaches.push('too_many_bubbles')
  if (bubbles.some((b) => b.trim() === '')) breaches.push('empty_bubble')
  if (bubbles.some((b) => !hasContent(b))) breaches.push('contentless_bubble')
  if (
    intentionQuestion !== '' &&
    bubbles[bubbles.length - 1] !== intentionQuestion
  ) {
    breaches.push('tail_not_last_bubble')
  }

  const raised = judge.whole.length > 0
  const separateLastBubble =
    bubbles.length >= 2 && judge.last.length > 0 && judge.earlier.length === 0

  return {
    raised,
    separateLastBubble,
    breaches,
    // A unit passes only when an intention was actually raised AND it went out
    // as its own last bubble AND no ceiling was breached. A turn that raised
    // nothing is not a pass and not a failure — it is outside the denominator,
    // which the runner reports separately.
    pass: raised && separateLastBubble && breaches.length === 0,
  }
}

/**
 * Normalize for the duplicate comparison: case-folded, punctuation and
 * whitespace stripped. Used by the runner to report whether the generator put
 * the question in BOTH fields, which is the one failure the mechanism cannot
 * prevent structurally.
 */
export function normalizeForDuplicate(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Did the answer already end with the question? Reported per unit so the
 * guard's firing rate is visible rather than silent — the answer half of a
 * composed reply is guest-facing text, and a guard that quietly edits it
 * should be countable.
 */
export function answerRepeatsQuestion(
  answer: string,
  question: string,
): boolean {
  if (question.trim() === '') return false
  const a = normalizeForDuplicate(answer)
  const q = normalizeForDuplicate(question)
  if (q === '') return false
  return a.endsWith(q)
}

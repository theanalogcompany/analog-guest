import type {
  HumanEvalArm,
  HumanEvalPreference,
  HumanEvalVerdict,
} from '@/lib/eval/human-eval'
import type { GoldenQuestion, GoldenV1, GoldenV2 } from '@/lib/schemas/golden'

// Shapes for /admin/tests/human-eval. The server loader builds these and the
// client holds them in state; every write route answers with the same unit
// shape, so a row on screen after a verdict is the row the database holds
// rather than an optimistic guess.

/** One question in a pass: both answers, the scramble, and the judgment. */
export interface HumanEvalUnitView {
  id: string
  questionKey: string
  /** Null when the stored key is no longer in GOLDEN_QUESTIONS - an orphan. */
  question: GoldenQuestion | null
  /** Which engine was shown as A. B is the complement. */
  aArm: HumanEvalArm
  /**
   * Null when the stored column failed schema parse. Rendered as unreadable,
   * never as an empty reply - a blank cell reads as "the engine said nothing",
   * which is a different and false claim.
   */
  v1: GoldenV1 | null
  v2: GoldenV2 | null
  parseError: string | null
  aVerdict: HumanEvalVerdict | null
  bVerdict: HumanEvalVerdict | null
  preference: HumanEvalPreference | null
  note: string
  generatedAt: string
  /** The most recent verdict write, null when the row is unjudged. */
  judgedAt: string | null
  /** When the rater unblinded this row. Set once, never cleared. */
  revealedAt: string | null
}

/** A pass, with the code state both arms ran at. */
export interface HumanEvalSessionView {
  id: string
  venueId: string
  venueName: string
  ratedBy: string
  v1PromptVersion: string
  v2PromptVersion: string
  v2Model: string
  venueOpenState: string
  /** Null on a local dev server - there is no deployment sha to record. */
  gitSha: string | null
  startedAt: string
  units: HumanEvalUnitView[]
}

/** One row of the pass picker. */
export interface HumanEvalSessionSummary {
  id: string
  startedAt: string
  venueOpenState: string
  v2Model: string
  generated: number
  judged: number
}

export interface HumanEvalPageData {
  /** Set when the tables are unreadable - almost always "apply migration 083". */
  degraded: string | null
  /** Every scenario in the golden set. */
  questionCount: number
  /** The ones both engines can be asked, which is what a pass covers. */
  judgeableCount: number
  /**
   * Scenarios a blind pass leaves out, with the reason. RENDERED: a pass over
   * 58 of 62 presented as "the golden set" reads as complete coverage.
   */
  excluded: Array<{ key: string; question: string; reason: string }>
  sessions: HumanEvalSessionSummary[]
  /** The pass on screen - the newest, or the one `?session=` names. */
  session: HumanEvalSessionView | null
  hasMoreSessions: boolean
}

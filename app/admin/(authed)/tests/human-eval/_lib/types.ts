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
  /**
   * Both answers are gone from the row, which on a submitted pass means they
   * were cleared once its CSV was stored (migration 088). Carried separately
   * because `v1`/`v2` are null for the unrelated reason above, and the two
   * must not render alike: one is a finished pass, the other a broken row.
   */
  answersAbsent: boolean
  parseError: string | null
  aVerdict: HumanEvalVerdict | null
  bVerdict: HumanEvalVerdict | null
  preference: HumanEvalPreference | null
  note: string
  generatedAt: string
  /** The most recent verdict write, null when the row is unjudged. */
  judgedAt: string | null
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
  /**
   * When the pass was submitted, null while it is in progress. A submitted
   * pass is READ-ONLY: every write route on it answers 409, and it is the
   * only state in which its CSV exists (migration 084).
   */
  submittedAt: string | null
  /**
   * What about this pass's code state is no longer current, as a sentence, or
   * null when it matches. Computed on load by comparing the three stamps
   * against the code doing the comparing.
   *
   * A STALE PASS IS NEVER WHAT THE PAGE OPENS ON - the loader skips past it.
   * This exists for the one that was asked for by `?session=`, where the
   * answer is to say so rather than to refuse: a verdict given today against
   * v2.18 is not evidence about v2.21, which is why the versions are stamped
   * at all, and judging an old pass unknowingly is the whole failure.
   */
  stale: string | null
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
  /** Submitted passes are labelled in the picker - they are the finished ones. */
  submittedAt: string | null
  /**
   * Generated under code that is no longer current. Listed anyway and marked:
   * removing them would make a submitted pass unreachable, and its CSV with
   * it. Picking one is a deliberate act, which is the difference between this
   * and what the page opens on by itself.
   */
  stale: boolean
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
  /**
   * The pass on screen: the one `?session=` names, or the newest generated
   * under the CURRENT code. Null when neither exists - including when passes
   * exist but every one of them is stale, which renders as the empty state
   * and a new pass rather than as old answers to judge.
   */
  session: HumanEvalSessionView | null
  hasMoreSessions: boolean
}

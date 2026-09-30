// TAC-558: the pure half of the first-visit-question measurement.
//
// Two jobs, both kept out of the harness so they can be tested without a model
// call, and so a detector fix can re-score a finished run log rather than
// re-generating it.
//
// The VARIETY detector itself is NOT here: `repeatedPhrases` in
// take-and-specifics-language.ts already counts replies containing an n-gram,
// already has the small-N floor (a phrase in one reply is never a template) and
// already merges overlapping windows into one finding. A second implementation
// would be a second thing to get wrong. What this module adds is the reading
// rule that detector cannot know about.

import {
  repeatedPhrases,
  type RepeatedPhrase,
} from './take-and-specifics-language'

/**
 * Words the question is ABOUT, which therefore repeat by necessity.
 *
 * THE PRE-REGISTERED READING RULE (approved 2026-09-29, before the run). At n=2
 * a question about first visits shares "first time" or "been coming" with every
 * other question about first visits, whatever wording surrounds it. That
 * measures the SUBJECT, not a template, so a breach made only of these is
 * reported and read rather than scored as a failure. n=3 and n=5 carry the bar.
 *
 * Kept deliberately SHORT. Every word added here excuses a longer repeated
 * phrase, so this is the question's own topic plus the interrogative scaffolding
 * English gives it no way around - not filler, not politeness, nothing else. A
 * phrase containing any word OUTSIDE this list is a template finding and is
 * scored as one.
 *
 * `have` AND `you` WERE ADDED AFTER THE RUN, and that is recorded rather than
 * quietly folded in. They were not in the list the bar was pre-registered
 * against, and adding a word here can only ever make a breach disappear, which
 * is the direction a measurement must never be adjusted in without saying so.
 *
 * Approved by Jaipal, 2026-09-30, on this evidence: "have you been…?" is how
 * English asks whether someone has done something before, and it was NOT copied
 * from the promptLine. A second wording sharing no phrase with its own questions
 * still produced "have you been coming" in 3 of its 4 on-target questions. So it
 * is scaffolding the question cannot avoid rather than a template the line
 * created, which is what "subject" was always meant to exclude.
 *
 * Adding them makes the three approved phrases - "have you", "you been", "have
 * you been" - read as subject-only. IT DOES NOT CLEAR THE BAR, and that was
 * known when it was approved: the shipped wording still breaches on `or have`
 * (4/10), `a while` (3/10) and `in or` (3/10). Shipping despite that is the
 * ruling, not a pass.
 */
export const SUBJECT_WORDS: readonly string[] = [
  'first',
  'time',
  'visit',
  'been',
  'coming',
  'here',
  'before',
  'in',
  // The interrogative scaffolding, approved 2026-09-30. See above.
  'have',
  'you',
]

/**
 * Whether a repeated phrase is made ONLY of the question's own subject words.
 *
 * Note what this deliberately does not do: it does not ask whether the phrase
 * LOOKS like a template. "first time in" is subject-only and reads like one;
 * "is this your first" is not, because "is", "this" and "your" are scaffolding
 * the model chose. The second is the one worth reading.
 */
export function isSubjectOnlyPhrase(phrase: string): boolean {
  const words = phrase.split(' ').filter(Boolean)
  if (words.length === 0) return false
  return words.every((w) => SUBJECT_WORDS.includes(w))
}

export interface VarietyFinding extends RepeatedPhrase {
  n: number
  /** True when the phrase is only the question's topic. Reported, not scored. */
  subjectOnly: boolean
}

export interface VarietyVerdict {
  raisedCount: number
  /** Every over-threshold phrase at every n, subject-only ones included. */
  findings: VarietyFinding[]
  /**
   * The findings that count against the bar: anything at n=3 or n=5, plus an n=2
   * phrase carrying a word outside SUBJECT_WORDS.
   */
  scored: VarietyFinding[]
  /** False when `scored` is non-empty. A ceiling, evaluated here, not by the reader. */
  pass: boolean
}

/** The n-gram widths the run reports. n=2 is informational; see SUBJECT_WORDS. */
export const VARIETY_WIDTHS: readonly number[] = [2, 3, 5]
const INFORMATIONAL_WIDTH = 2

/**
 * Score phrasing variety over the raised questions.
 *
 * `maxShare` is a quarter, per the acceptance criterion. At ten raised questions
 * that is 2.5, so a phrase in two replies passes and three breaches - coarse at
 * this n, which is why the harness prints the bodies too.
 */
export function scoreVariety(
  questions: readonly string[],
  maxShare = 0.25,
): VarietyVerdict {
  const findings: VarietyFinding[] = []
  for (const n of VARIETY_WIDTHS) {
    for (const p of repeatedPhrases(questions, { n, maxShare })) {
      findings.push({ ...p, n, subjectOnly: isSubjectOnlyPhrase(p.phrase) })
    }
  }
  const scored = findings.filter(
    (f) => !(f.n === INFORMATIONAL_WIDTH && f.subjectOnly),
  )
  return {
    raisedCount: questions.length,
    findings,
    scored,
    pass: scored.length === 0,
  }
}

export type TurnStage = 'scan' | 'order' | 'reply' | 'answer'

export interface TurnRecord {
  stage: TurnStage
  /** Intentions the derivation actually rendered this turn. */
  renderedKeys: readonly string[]
  /** Keys the post-send classifier says the sent message raised. */
  raisedKeys: readonly string[]
  /** An order is on record as of this turn's context. */
  orderOnRecord: boolean
  /** The question the model put in its own field, '' when it raised nothing. */
  intentionQuestion: string
  bubbles: readonly string[]
  /** contextUpdate.structured.guest_details.history_here, if the model wrote one. */
  storedHistory: string | undefined
  /**
   * What the FULL-BALLOT judge attributed the question to (every intention
   * offered, not just the open ones). Empty when nothing was asked or the read
   * was not run. See OnTargetRead.
   */
  attributedTo: readonly string[]
  /** A model call that errored. A failed unit is not a result. */
  failed: boolean
}

export const TARGET_KEY = 'are_they_new_here'

/**
 * Was the question actually ABOUT this intention's subject?
 *
 * WHY THIS IS A SEPARATE READ FROM `raisedKeys`, and why the first run of this
 * harness needed it. classifyIntentionPrompts builds its `z.enum` from the OPEN
 * keys only, so on a turn where one intention rendered the classifier's only
 * options are "raised it" or "raised nothing" - a forced choice. Asked whether
 * "do you live close by?" raised are_they_new_here, with are_they_local not on
 * the ballot, it says yes. Six of twelve questions in one run were off target
 * that way and the summary line read 12/20.
 *
 * So the harness asks production's judge a SECOND time with EVERY intention
 * offered, which is the same instrument with a fair ballot. `offTarget` names
 * whichever intention the question really belongs to, so the run reports what
 * was asked rather than what the gate could attribute.
 *
 * Deliberately NOT a phrase list. A list of "history" words would under-count
 * whichever wording is not echoing a script, and the error always flatters the
 * arm being tested - the asymmetry the measurement convention's point 7 is about
 * and that TAC-423 paid for twice.
 */
export interface OnTargetRead {
  /** The full-ballot judge attributed the question to this intention. */
  attributedTo: readonly string[]
  /** True when the target is among them. */
  onTarget: boolean
  /** Non-empty when the question belongs to some OTHER intention instead. */
  offTarget: readonly string[]
}

export function readOnTarget(attributedTo: readonly string[]): OnTargetRead {
  return {
    attributedTo,
    onTarget: attributedTo.includes(TARGET_KEY),
    offTarget: attributedTo.filter((k) => k !== TARGET_KEY),
  }
}

export interface ConversationVerdict {
  /** The question was raised on some turn. */
  raised: boolean
  /** Raised on a turn with NO order on record. AC 1's hard zero. */
  raisedBeforeOrder: boolean
  /** Raised, and its question was exactly the last bubble. */
  ownLastBubble: boolean
  /** The guest's answer reached guests.context. */
  answerStored: boolean
  /** Any turn had a failed model call, so this conversation scores nothing. */
  invalid: boolean
  /** The raised question verbatim, for reading. */
  question: string
  /**
   * The question was raised AND the full-ballot judge agrees it is about this
   * intention. This is the number to read, not `raised`.
   */
  onTarget: boolean
  /** Which other intention it really asked about, when it was off target. */
  offTarget: readonly string[]
}

/**
 * Fold a conversation's turns into one verdict.
 *
 * A FAILED TURN INVALIDATES THE CONVERSATION rather than scoring as "did not
 * raise" - convention 5. Without that, a run where every call errored reports a
 * clean zero before-order count and a zero raise rate, which is indistinguishable
 * from a working control arm.
 */
export function scoreConversation(
  turns: readonly TurnRecord[],
): ConversationVerdict {
  if (turns.some((t) => t.failed)) {
    return {
      raised: false,
      raisedBeforeOrder: false,
      ownLastBubble: false,
      answerStored: false,
      invalid: true,
      question: '',
      onTarget: false,
      offTarget: [],
    }
  }

  const raisedTurns = turns.filter((t) => t.raisedKeys.includes(TARGET_KEY))
  const raised = raisedTurns.length > 0
  const first = raisedTurns[0]

  return {
    raised,
    // Read off the turn's OWN order state, not the stage label: the label is the
    // harness's intent and this is what the derivation actually saw.
    raisedBeforeOrder: raisedTurns.some((t) => !t.orderOnRecord),
    ownLastBubble:
      first !== undefined &&
      first.intentionQuestion.trim() !== '' &&
      first.bubbles[first.bubbles.length - 1] === first.intentionQuestion,
    answerStored: turns.some(
      (t) => t.storedHistory !== undefined && t.storedHistory.trim() !== '',
    ),
    invalid: false,
    question: first?.intentionQuestion ?? '',
    onTarget: raised && (first?.attributedTo.includes(TARGET_KEY) ?? false),
    offTarget:
      first === undefined
        ? []
        : first.attributedTo.filter((k) => k !== TARGET_KEY),
  }
}

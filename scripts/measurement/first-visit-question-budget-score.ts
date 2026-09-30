// TAC-567: on a guest's FIRST conversation, how many questions do they get, and
// which ones?
//
// PURE. No @/* imports, no clients, no model calls, so every boundary here is a
// plain unit test and the harness that spends the model calls holds no logic that
// could be wrong without something failing.
//
// THE THREE BARS, all absolute zeros, transcribed from the acceptance criteria:
//
//   1. the questions asked, per conversation: only the order, the name and the
//      first-visit question. 0 others.
//   2. turns carrying two questions (a body question plus an intention bubble): 0.
//   3. "you've reached" or equivalent in the opener: 0.
//
// A ZERO IS ONLY EVIDENCE IF THE DETECTOR COULD HAVE FIRED, which is why each
// detector below is driven from both sides in the test file rather than only on
// clean input. That is this repo's most-repeated lesson: a claim nothing enforces
// is the expensive defect, and a printed PASS is exactly such a claim.

/**
 * The three intentions a first conversation may raise (TAC-567). Kept as a
 * literal transcribed from the ruling rather than read off
 * allowedOnFirstConversation, because a scorer that derives its expectation from
 * the code under test can only confirm that code equals itself.
 */
export const ALLOWED_KEYS = [
  'understand_order',
  'learn_name',
  'are_they_new_here',
] as const

export type AllowedKey = (typeof ALLOWED_KEYS)[number]

export function isAllowedKey(key: string): key is AllowedKey {
  return (ALLOWED_KEYS as readonly string[]).includes(key)
}

/**
 * The question sentences in one outbound response.
 *
 * Split on '?' rather than by sentence-splitting the whole body first, because
 * lib/agent/sentence-split.ts needs a capitalised opener and Le Mil's writes
 * lowercase - it returns 1 for every reply at this venue and is blind to the
 * question. That exact trap cost TAC-555 a clause count (recorded in
 * lib/ai/prompts/CLAUDE.md), so it is not repeated here.
 *
 * Each question is trimmed back to its own sentence start, so a reply reads as
 * one question rather than as the whole paragraph. A '?' with no letter or digit
 * in front of it ("??", a lone "?") is not a question.
 *
 * THE EXCERPT IS BEST-EFFORT; THE COUNT IS NOT. Where the model wrote no `.!`
 * before its question ("that's a good one to start with 🌸 how'd you like it?",
 * the device case) the excerpt carries the lead-in with it. That is the same
 * absent boundary that made TAC-554 move the question into its own schema field
 * rather than ask dispatch to split it. Both bars read the COUNT, which is exact;
 * the excerpts are for human reading and the harness prints the whole body beside
 * them.
 */
export function splitQuestions(body: string): string[] {
  const out: string[] = []
  const chunks = body.split('?')
  // The last chunk is whatever followed the final '?', so it is never a question.
  for (let i = 0; i < chunks.length - 1; i += 1) {
    const chunk = chunks[i] ?? ''
    const sentences = chunk.split(/(?<=[.!])\s+/)
    const q = `${(sentences[sentences.length - 1] ?? chunk).trim()}?`
    if (/[\p{L}\p{N}]/u.test(q)) out.push(q)
  }
  return out
}

/** How many questions this response asks the guest. Bar 2 counts turns above 1. */
export function countQuestions(body: string): number {
  return splitQuestions(body).length
}

/**
 * Ways an opener can tell the guest whose number they just reached.
 *
 * SPLIT INTO TWO TIERS DELIBERATELY. `strict` is the literal instruction the
 * ruling deleted and the phrase the device transcript produced; `equivalent` is
 * the same ACT in other words. The ticket's bar is '"you've reached" or
 * equivalent', so the arm fails on either - but they are counted and printed
 * separately, because "welcome to <venue>" is a judgement call and a bar should
 * never fail on a judgement call without a human seeing the sentence.
 *
 * The venue-name patterns are built per run rather than hardcoded: no venue name
 * may appear in shared prompt or test copy (lib/ai/prompts/CLAUDE.md), and a
 * hardcoded one would silently stop matching at the second venue.
 */
export interface IdentityClaim {
  label: string
  tier: 'strict' | 'equivalent'
  matched: string
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function identityClaims(
  body: string,
  venueName: string,
): IdentityClaim[] {
  const name = escapeForRegex(venueName.trim())
  // An apostrophe in a venue name arrives as ' or U+2019 depending on who typed
  // it, and the model re-punctuates freely, so either form must match.
  const flexibleName = name.replace(/['’]/g, "['’]")
  const patterns: readonly {
    label: string
    tier: 'strict' | 'equivalent'
    re: RegExp
  }[] = [
    {
      label: "you've reached",
      tier: 'strict',
      re: /you\s*['’]?\s*(?:ve|have)\s+reached/i,
    },
    {
      label: "you're texting/messaging",
      tier: 'strict',
      re: /you\s*['’]?\s*re\s+(?:texting|messaging)/i,
    },
    ...(flexibleName.length > 0
      ? ([
          {
            label: 'this is <venue>',
            tier: 'equivalent' as const,
            re: new RegExp(`\\bthis is ${flexibleName}`, 'i'),
          },
          {
            label: 'welcome to <venue>',
            tier: 'equivalent' as const,
            re: new RegExp(`\\bwelcome to ${flexibleName}`, 'i'),
          },
          {
            label: '<venue> here',
            tier: 'equivalent' as const,
            re: new RegExp(`${flexibleName}\\s+here\\b`, 'i'),
          },
        ] as const)
      : []),
  ]
  const out: IdentityClaim[] = []
  for (const p of patterns) {
    const m = p.re.exec(body)
    if (m !== null) out.push({ label: p.label, tier: p.tier, matched: m[0] })
  }
  return out
}

export interface TurnInput {
  /** 'opener' is the first outbound of the conversation; bar 3 reads only that one. */
  stage: string
  /** The complete outbound response, question bubble included (generation.body). */
  body: string
  /**
   * The getting-to-know-you question, which is the exact TAIL of `body`
   * (generation.intentionQuestion), or '' on a turn that asked none.
   *
   * THE SPLIT IS STRUCTURAL, NOT A TEXT HEURISTIC, and that is the whole reason
   * this field exists. The first smoke run passed the whole body to the judge and
   * got got_the_recommendation attributed to "we've got that comp and the SoFi
   * recommendation still waiting" - a statement that happened to sit in front of
   * "by the way, what's your name?" with no sentence terminator between them, so
   * the question excerpt swallowed it. TAC-554 already made the boundary exact by
   * moving the question into its own field; reading it here instead of guessing at
   * it removes a false positive that would have failed the arm for text no guest
   * was asked to answer.
   */
  tail: string
  /**
   * What the FULL-BALLOT judge attributed the BODY's own questions to: every
   * intention key, not just the open ones. Production's own gate asks a
   * forced-choice question built from the open keys alone, so with one intention
   * rendered an off-target question lands in the one available bucket and reads as
   * on-target. TAC-558 found exactly that: 12 raised of which 6 were about
   * something else.
   *
   * The TAIL's attribution is `raisedKeys` below, from production's own gate, so
   * the two questions in a turn are never judged by the same forced choice.
   */
  attributedTo: readonly string[]
  /** What production's gate recorded the tail as raising. */
  raisedKeys: readonly string[]
  /** True when the model call or the judge failed. A failed turn is not a result. */
  failed: boolean
}

/**
 * The reply without its getting-to-know-you question.
 *
 * `body` ends with `tail` character for character by construction
 * (composeReplyWithIntention did the joining), so this is a slice rather than a
 * search. It falls back to the whole body if that identity does not hold, which
 * would itself be a defect worth seeing rather than silently half-counting.
 */
export function answerPartOf(body: string, tail: string): string {
  if (tail.trim() === '') return body
  return body.endsWith(tail) ? body.slice(0, body.length - tail.length) : body
}

export interface TurnVerdict {
  stage: string
  questions: string[]
  questionCount: number
  /** Bar 2. */
  twoQuestions: boolean
  /** Bar 1: attributed keys outside the ruled three. */
  offTargetKeys: string[]
  /**
   * The BODY asked a question and the full ballot attributed it to nothing at all.
   *
   * COUNTED SEPARATELY FROM offTargetKeys AND IT MATTERS. An invented question
   * that happens to match no intention description ("how was your morning?") is
   * still a question the ruling does not allow on a first visit, and reading only
   * the attributed keys would score it clean. This is the half a judge-only read
   * misses. Scoped to the body: the tail is judged by production's own gate.
   */
  unattributedQuestion: boolean
  failed: boolean
}

export function scoreTurn(turn: TurnInput): TurnVerdict {
  const bodyQuestions = splitQuestions(answerPartOf(turn.body, turn.tail))
  const tailQuestions = turn.tail.trim() === '' ? [] : [turn.tail]
  const questions = [...bodyQuestions, ...tailQuestions]
  const offTargetKeys = [
    ...new Set(
      [...turn.attributedTo, ...turn.raisedKeys].filter(
        (k) => !isAllowedKey(k),
      ),
    ),
  ].sort()
  return {
    stage: turn.stage,
    questions,
    questionCount: questions.length,
    // BAR 2 IS EXACTLY THIS: a question the body invented plus the intention
    // bubble on top, which is the turn the ticket was filed for.
    twoQuestions: questions.length > 1,
    offTargetKeys,
    unattributedQuestion:
      bodyQuestions.length > 0 && turn.attributedTo.length === 0,
    failed: turn.failed,
  }
}

export interface ConversationVerdict {
  /** Every question the guest was asked across the conversation, in order. */
  questions: string[]
  questionCount: number
  /** Bar 2: how many turns carried more than one question. */
  twoQuestionTurns: number
  /** Bar 1: attributed keys outside the ruled three, deduped. */
  offTargetKeys: string[]
  /** Bar 1's other half: turns whose question matched no intention at all. */
  unattributedTurns: number
  /** Bar 3: identity claims found in the opener only. */
  openerIdentityClaims: IdentityClaim[]
  /** The opener verbatim, so bar 3 can be read rather than trusted. */
  opener: string
  /** Every bar met. Always false when the conversation is invalid. */
  clean: boolean
  invalid: boolean
}

/**
 * One conversation's verdict.
 *
 * A FAILED TURN INVALIDATES THE CONVERSATION rather than scoring as a clean zero
 * (convention 5). Every bar here counts a BAD thing, so a conversation that died
 * after one turn would otherwise report three perfect zeros and flatter the run.
 */
export function scoreConversation(
  turns: readonly TurnInput[],
  venueName: string,
): ConversationVerdict {
  const verdicts = turns.map(scoreTurn)
  const invalid = verdicts.length === 0 || verdicts.some((v) => v.failed)
  const opener = turns[0]?.body ?? ''
  const openerIdentityClaims =
    turns.length > 0 ? identityClaims(opener, venueName) : []
  const offTargetKeys = [
    ...new Set(verdicts.flatMap((v) => v.offTargetKeys)),
  ].sort()
  const twoQuestionTurns = verdicts.filter((v) => v.twoQuestions).length
  const unattributedTurns = verdicts.filter(
    (v) => v.unattributedQuestion,
  ).length
  return {
    questions: verdicts.flatMap((v) => v.questions),
    questionCount: verdicts.reduce((n, v) => n + v.questionCount, 0),
    twoQuestionTurns,
    offTargetKeys,
    unattributedTurns,
    openerIdentityClaims,
    opener,
    clean:
      !invalid &&
      offTargetKeys.length === 0 &&
      twoQuestionTurns === 0 &&
      unattributedTurns === 0 &&
      openerIdentityClaims.length === 0,
    invalid,
  }
}

export interface RunSummary {
  conversations: number
  valid: number
  invalid: number
  /** Bar 1, both halves. */
  offTargetConversations: number
  unattributedConversations: number
  /** Bar 2. */
  twoQuestionTurns: number
  /** Bar 3, by tier. */
  strictIdentityConversations: number
  equivalentIdentityConversations: number
  cleanConversations: number
  /** Every bar met across every valid conversation. */
  pass: boolean
}

/**
 * The run verdict.
 *
 * `pass` REQUIRES AT LEAST ONE VALID CONVERSATION. Without that clause a wholly
 * broken run - every model call failing - reports every bar at zero and prints
 * PASS, which is convention 5 and 6's exact failure and has happened twice in this
 * repo.
 */
export function summarize(
  verdicts: readonly ConversationVerdict[],
): RunSummary {
  const valid = verdicts.filter((v) => !v.invalid)
  const summary: RunSummary = {
    conversations: verdicts.length,
    valid: valid.length,
    invalid: verdicts.length - valid.length,
    offTargetConversations: valid.filter((v) => v.offTargetKeys.length > 0)
      .length,
    unattributedConversations: valid.filter((v) => v.unattributedTurns > 0)
      .length,
    twoQuestionTurns: valid.reduce((n, v) => n + v.twoQuestionTurns, 0),
    strictIdentityConversations: valid.filter((v) =>
      v.openerIdentityClaims.some((c) => c.tier === 'strict'),
    ).length,
    equivalentIdentityConversations: valid.filter((v) =>
      v.openerIdentityClaims.some((c) => c.tier === 'equivalent'),
    ).length,
    cleanConversations: valid.filter((v) => v.clean).length,
    pass: false,
  }
  summary.pass =
    valid.length > 0 &&
    summary.offTargetConversations === 0 &&
    summary.unattributedConversations === 0 &&
    summary.twoQuestionTurns === 0 &&
    summary.strictIdentityConversations === 0 &&
    summary.equivalentIdentityConversations === 0
  return summary
}

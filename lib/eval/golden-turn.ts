import type { GoldenQuestion } from '@/lib/schemas/golden'
import { RUNNABLE_DRIVERS } from '@/lib/eval/golden-set'
import type { DeclaredTurnMedia } from '@/lib/relationship/turn-media'
import {
  EMPTY_MEMORY,
  EMPTY_PROFILE,
  type GuestProfile,
  type InteractionMemory,
} from '@/lib/relationship/profile'

// One golden question to the turn v2 would be asked, or the reason it cannot
// be asked at all.
//
// EXTRACTED SO TWO CALLERS CANNOT DISAGREE. The measurement harness
// (`scripts/measurement/golden-set.ts`) and `/admin/prompt-lab` both turn a
// `GoldenQuestion` into an inbound plus a history, and both have to decline the
// same two scenario shapes for the same reasons. Two copies of that mapping is
// two chances for the lab to ask v2 something the harness never would - and the
// surfaces would then disagree about what v2 said while both looked right.
//
// Pure: no DB, no SDK, no clock. Importable from a script, a server loader and
// a client component alike.

export interface GoldenTurnInput {
  /** The guest's message(s) this turn, oldest first. Empty on an outreach turn. */
  inbound: string[]
  /** The conversation before it. Empty for a cold open. */
  history: Array<{ role: 'user' | 'assistant'; text: string }>
  /**
   * What the guest sent besides words, for a scenario carrying `mediaUrls`.
   * Absent on a text scenario, which composes byte-identically to before.
   *
   * A TYPE-ONLY IMPORT, and it has to stay one: this module is imported by
   * `prompt-lab-client.tsx`, a client component, and `turn-media.ts` reaches
   * for the admin DB client. The value side of that module never belongs in a
   * browser bundle; the shape does no harm.
   */
  media?: DeclaredTurnMedia
  /**
   * Set on a proactive scenario: the v2 outreach turn (v2.21.0). The authored
   * history is the whole input and the venue writes first.
   */
  outreach?: { hoursQuiet: number }
}

/**
 * The quiet gap a golden proactive scenario simulates. The fixtures all say
 * "the next day"; 21 hours is that, authored here once so the harness and
 * /admin/prompt-lab cannot drift. An AUTHORED fixture value, not a product
 * constant - the phase-B sweep computes the real gap from the real anchor.
 */
export const GOLDEN_OUTREACH_HOURS_QUIET = 21

export interface GoldenTurnSkip {
  stage: 'proactive' | 'not_automated'
  error: string
}

/**
 * The turn, and whether v2 can be asked it.
 *
 * `skip` is NOT a failure. It is the harness declining, by name, rather than
 * asking anyway - running it would answer a turn driven by an inbound that
 * does not exist, and the column would read as "v2 handled it". A caller must
 * render it as a labelled gap and never count it as a failed arm.
 *
 * The skips are down to `not_automated` plus one degenerate case: media
 * scenarios run on both arms (the media lane), proactive scenarios run as v2
 * outreach turns, and the only 'proactive' skip left is a fixture with no
 * history - a follow-up to nothing, which runTurn refuses by the same name.
 */
export function goldenTurnFor(question: GoldenQuestion): {
  turn: GoldenTurnInput
  skip: GoldenTurnSkip | null
} {
  const history = (question.history ?? []).map((t) => ({
    role: t.role,
    text: t.text,
  }))

  // A proactive scenario is a v2 OUTREACH turn (v2.21.0): no inbound - the
  // scenario's `question` string is a bracketed descriptor, never a guest
  // message - the authored history is the whole input, and the venue writes
  // first. A proactive fixture with no history is still declined: a follow-up
  // answers a relationship, and runTurn refuses the same turn by name.
  if (question.driver === 'proactive') {
    return {
      turn: {
        inbound: [],
        history,
        outreach: { hoursQuiet: GOLDEN_OUTREACH_HOURS_QUIET },
      },
      skip:
        notAutomatedSkip(question) ??
        (history.length === 0
          ? {
              stage: 'proactive',
              error:
                'a follow-up answers a relationship - this proactive scenario carries no history, so there is no thread to pick up',
            }
          : null),
    }
  }

  return {
    turn: {
      inbound: question.messages ?? [question.question],
      history,
      // v2 HAS A MEDIA INPUT NOW, so the skip this branch used to return is
      // gone: it read "run-turn.ts and the v2 composer take text only", which
      // stopped being true when the media lane landed
      // (lib/relationship/turn-media.ts). The scenario's links are stated
      // rather than stored, exactly as the v1 arm states them, so both arms
      // answer a turn that mentions the same photo.
      //
      // The links are read for their FILE EXTENSION and nothing else, on both
      // arms. Nothing looks at the image, and no description exists for a
      // scenario - so these turns measure the "you can't see it" wording and
      // the hold, which is what they measured on v1.
      ...(question.mediaUrls !== undefined
        ? { media: { mediaUrls: question.mediaUrls } }
        : {}),
    },
    skip: notAutomatedSkip(question),
  }
}

/**
 * What v2 is told about the guest for a golden turn. One definition, for the
 * same reason `goldenTurnFor` is: the harness and /admin/tests/human-eval both
 * ask v2 these questions, and a difference here is a difference in WHO v2
 * thinks it is talking to - which would show up as a difference in the reply
 * and be read as a finding about the prompt.
 *
 * EMPTY PROFILE, EMPTY MEMORY, ZERO VISITS, even on a scenario whose history
 * implies past ones. That is deliberate parity with the v1 arm: its synthetic
 * guest has no `transactions` rows, so declaring visits here would have v2
 * answering about a regular while v1 answers about a stranger, and the
 * asymmetry would flatter whichever arm was told more. Anything a scenario
 * needs the guest to have done is in the transcript, where both arms read it.
 *
 * `replyCount` counts the guest's own messages - the authored history plus
 * this turn - which is what v1's count sees for the same materialized thread.
 * Defaulting it (runTurn's own fallback is 1) would tell v2 that a guest six
 * turns into a conversation had just said their first word.
 */
export function goldenSessionFor(turn: GoldenTurnInput): {
  profile: GuestProfile
  memory: InteractionMemory
  facts: {
    visitCount: number
    replyCount: number
    daysSinceLastContact: number | null
  }
} {
  return {
    profile: EMPTY_PROFILE,
    memory: EMPTY_MEMORY,
    facts: {
      visitCount: 0,
      replyCount:
        turn.history.filter((t) => t.role === 'user').length +
        turn.inbound.length,
      daysSinceLastContact: null,
    },
  }
}

/**
 * The scenarios the set itself says cannot be automated - a driver with no
 * read-only test sink (`scan_arrival`, `held_draft_expiry`) or a per-scenario
 * fixture veto (`notAutomated`).
 *
 * CHECKED FIRST, and from `RUNNABLE_DRIVERS` rather than a second list. These
 * scenarios carry a `question` string like every other, so building a turn out
 * of it would hand the engine a guest message that was never sent - a sticker
 * tap is a scan row, not a message - and the reply would read as the agent
 * handling the scenario. The harness never reaches this branch because it
 * filters with `runnableGoldenQuestions()` first; a surface that renders the
 * whole set does reach it, and this is the one place that decides.
 */
function notAutomatedSkip(question: GoldenQuestion): GoldenTurnSkip | null {
  if (question.notAutomated !== undefined)
    return { stage: 'not_automated', error: question.notAutomated }
  const driver = question.driver ?? 'inbound'
  if (!RUNNABLE_DRIVERS.includes(driver))
    return {
      stage: 'not_automated',
      error: `driver '${driver}' has no read-only test sink, so there is no turn to draft`,
    }
  return null
}

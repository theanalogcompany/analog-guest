import type { GoldenQuestion } from '@/lib/schemas/golden'
import { RUNNABLE_DRIVERS } from '@/lib/eval/golden-set'
import type { DeclaredTurnMedia } from '@/lib/relationship/turn-media'

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
  /** The guest's message(s) this turn, oldest first. */
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
}

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
 * ONE SKIP LEFT, where there were two: media scenarios now run on both arms.
 */
export function goldenTurnFor(question: GoldenQuestion): {
  turn: GoldenTurnInput
  skip: GoldenTurnSkip | null
} {
  return {
    turn: {
      inbound: question.messages ?? [question.question],
      history: (question.history ?? []).map((t) => ({
        role: t.role,
        text: t.text,
      })),
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
    skip:
      notAutomatedSkip(question) ??
      (question.driver === 'proactive'
        ? {
            stage: 'proactive',
            error:
              'v2 has no proactive path - runTurn answers an inbound, and this scenario has none',
          }
        : null),
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

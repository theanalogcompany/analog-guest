import type { GoldenQuestion } from '@/lib/schemas/golden'
import type { StoredV1Cell } from './load-stored-v1'

// Shapes for /admin/prompt-lab. Kept apart from the playground's `_lib/types`
// because the UNIT OF WORK is different: the playground holds one conversation
// whose turns carry a rolling session, this holds 67 independent single-turn
// scenarios against one prompt. Sharing a type would make the session
// semantics ambiguous in both.

/** One golden question, its stored v1 answer, and this session's v2 run. */
export interface LabRow {
  question: GoldenQuestion
  /** Null when no run ever recorded a real v1 answer for this key. */
  storedV1: StoredV1Cell | null
  /** Absent until this question has been asked in this session. */
  v2?: LabV2State
}

export type LabV2State =
  | { status: 'running' }
  | {
      status: 'done'
      bubbles: string[]
      /** `send | queue | block`, or null when the run never reached the gate. */
      verdict: 'send' | 'queue' | 'block' | null
      promptVersion: string
      model: string
      effort: string | null
      durationMs: number
      /** Thinking tokens, null when the provider reported no breakdown. */
      thinkingTokens: number | null
      /**
       * `templateEditHash` of the template blocks this answer ran on, or null
       * when none were sent.
       *
       * PER CELL, not on the sweep arm, for the reason the sweep store's own
       * header gives: the arm describes the sweep's start and a question re-run
       * under an edited template lands in the same column. Promotion asks "how
       * many of these answers came from the bytes about to be promoted", and
       * only the cell can answer that. `promptVersion` carries `+hand-edited`
       * but says nothing about WHICH edit, which is the distinction that
       * matters once the text has been touched twice.
       */
      templateHash: string | null
    }
  /**
   * A failed arm is a FAILURE, never a short answer (`scripts/CLAUDE.md`
   * rule 5). Rendered red and counted apart from the successes, so a sweep
   * where half the calls 500'd cannot read as a sweep where half the replies
   * were terse.
   */
  | { status: 'error'; error: string }
  /**
   * The harness declines to ask - a media or proactive scenario v2 has no
   * input for. GREY and labelled, distinct from `error`, because reporting a
   * capability gap as a failure is a finding about the agent that is not true.
   */
  | { status: 'not_run'; reason: string }

/**
 * A state a run has SETTLED on. `running` is excluded at the type level
 * because it is the one state that is not a result: it is never stored and
 * never returned by a run, and a checkpoint of it would restore a spinner with
 * nothing driving it.
 */
export type LabV2Settled = Exclude<LabV2State, { status: 'running' }>

/**
 * What a sweep ran WITH, captured when it starts.
 *
 * On the sweep rather than read live when it is rendered: the prompt, model
 * and template are all editable while results are on screen, so a header that
 * read today's controls would relabel yesterday's results every time someone
 * touched a picker.
 */
export interface SweepArm {
  /** '' when no saved prompt was loaded. */
  promptName: string
  promptEdited: boolean
  /** The template's own blocks were edited, which `promptEdited` is not about. */
  templateEdited: boolean
  templateVersion: string
  modelKey: string
  effort: string
  maxOutputTokens: number
}

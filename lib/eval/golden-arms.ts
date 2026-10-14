// One engine's answer, in the shape both the golden set and the blind human
// evaluation store it in (lib/schemas/golden.ts).
//
// EXTRACTED SO TWO CALLERS CANNOT DISAGREE, the same reason `golden-turn.ts`
// exists one step upstream. The measurement harness
// (`scripts/measurement/golden-set.ts`) and the human-evaluation client both
// take a v1 draft and a v2 trace and reduce them to the stored columns. Two
// copies of that reduction is two chances for one surface to record a reply
// the other would have recorded differently - and a human verdict given
// against a mis-stored reply is worse than no verdict, because it looks like
// evidence.
//
// STRUCTURAL INPUT TYPES, DELIBERATELY. The v1 mapper takes the fields it
// reads rather than importing `TestDraft`, so nothing in `lib/` names
// `app/admin/(authed)/playground/api/run/v1-arm.ts` - that file's header
// records that no `lib/` module imports it, which is what makes deleting v1
// in phase 6 a bounded change. `TestDraft` satisfies this shape without being
// mentioned.
//
// Pure: no DB, no SDK, no clock. Importable from a script, a server route and
// a client component alike.

import type { TurnTrace } from '@/lib/relationship/run-turn'
import type { GoldenV1, GoldenV2 } from '@/lib/schemas/golden'

/**
 * The fields a v1 draft contributes to the stored column. A structural subset
 * of `TestDraft` - see the header for why it is not that type.
 */
export interface GoldenV1Draft {
  bubbles: string[]
  category: string
  recognitionState: string
  substitute:
    | 'crisis_safety'
    | 'media_only_card'
    | 'opt_out_confirmation'
    | 'no_reply_needed'
    | null
  promptVersion: string
}

/**
 * An arm that produced no reply. One shape for both arms, as the schema has
 * it: `error` is the engine breaking on something it is supposed to handle,
 * `not_run` is the harness declining to ask because the engine has no such
 * capability. Opposite findings, never collapsed.
 */
export type GoldenArmFailure = Extract<GoldenV1, { ok: false }>

export function goldenArmFailure(input: {
  kind: 'error' | 'not_run'
  stage: string
  error: string
  durationMs: number
}): GoldenArmFailure {
  return {
    ok: false,
    kind: input.kind,
    stage: input.stage,
    error: input.error,
    durationMs: input.durationMs,
  }
}

/**
 * v1's answer, or its failure.
 *
 * `substitute` is carried rather than collapsed into an empty reply: "v1 would
 * have sent this fixed crisis text" and "v1 would have sent nothing and
 * carded it" are different answers, and a surface rendering both as silence is
 * lying about one of them.
 */
export function goldenV1FromOutcome(
  outcome:
    | { ok: true; data: GoldenV1Draft }
    | { ok: false; error: string; stage: string },
  durationMs: number,
): GoldenV1 {
  if (!outcome.ok)
    return goldenArmFailure({
      kind: 'error',
      stage: outcome.stage,
      error: outcome.error,
      durationMs,
    })
  return {
    ok: true,
    bubbles: outcome.data.bubbles,
    category: outcome.data.category,
    recognitionState: outcome.data.recognitionState,
    substitute: outcome.data.substitute,
    promptVersion: outcome.data.promptVersion,
    durationMs,
  }
}

/**
 * v2's answer, or its failure, off the turn trace.
 *
 * `durationMs` IS THE CALLER'S STOPWATCH, never `trace.totalDurationMs`. Both
 * columns have to measure the same boundary or the pair is not a comparison:
 * v1's figure covers its sandbox setup too, and runTurn's own total does not.
 *
 * `promptVersion` is passed in rather than read off a constant here, so a
 * caller running an archived template records the version that actually
 * composed the prompt instead of the one the code currently ships.
 */
export function goldenV2FromTrace(
  trace: TurnTrace,
  promptVersion: string,
  durationMs: number,
): GoldenV2 {
  if (!trace.generation.ok)
    return goldenArmFailure({
      kind: 'error',
      stage: 'generation',
      error: trace.generation.error,
      durationMs,
    })
  return {
    ok: true,
    messages: trace.generation.output.messages,
    stateKey: trace.state.resolvedKey,
    gateVerdict: trace.gate?.verdict ?? null,
    gateMatched: (trace.gate?.matched ?? []).map((m) => m.policyKey),
    promptVersion,
    durationMs,
  }
}

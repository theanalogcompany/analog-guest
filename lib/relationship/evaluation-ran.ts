// Did a turn's evaluation stage actually run, or did the caller decline it?
//
// `runTurn` can be asked to skip the two judges and the assessor
// (`skipEvaluation`), so three fields of `TurnTrace` carry a third state:
// `{skipped: true}`, which is NOT `null`. Null already means "generation
// failed upstream, so there was nothing to judge". Collapsing the two would
// make "we did not look" indistinguishable from "there was nothing to look
// at" - the three-state rule in .claude/rules/errors-as-values.md, and the
// difference between a grey "skipped" and a red "failed" on the playground
// inspector.
//
// NO IMPORTS, deliberately, same posture as bubble-pacing.ts. The readers are
// `'use client'` components in the playground, and `run-turn.ts` pulls in the
// Supabase admin client and the whole v2 pipeline - a VALUE import of this
// guard from there drags `node:fs` into the client bundle and Turbopack fails
// the build with "the chunking context does not support external modules".
// `tsc` cannot see that, because the import that used to be there was
// types-only and erased.
//
// Generic rather than typed to TurnTrace's members: it needs nothing from
// that type, and importing it would reintroduce the coupling this file exists
// to remove.

/**
 * Narrow away the skipped state.
 *
 * ONE definition, because the alternative is every reader spelling out
 * `x !== null && !('skipped' in x)` and one of them eventually writing
 * `!x.ok` instead - which reads a declined stage as a failure.
 */
export function evaluationRan<T extends object>(
  stage: T | { skipped: true } | null,
): stage is T {
  return stage !== null && !('skipped' in stage)
}

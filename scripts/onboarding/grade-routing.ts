/**
 * TAC-347 Stage 3. Deterministic routing grade — expected_route from the
 * scenario vs the actual approval decision route from the harness run. Pure
 * and import-free.
 *
 * A prior version of this module also tracked an "unflagged" signal tied to
 * a scenario-level expected_flag field — removed same-day per a revised
 * owner decision on safety-critical scenarios (no flag mechanism; graded on
 * the reply's content instead, via the ordinary expected_behavior_verdict).
 */

export type RoutingVerdict = 'pass' | 'fail' | 'not_applicable'

export interface RoutingGrade {
  verdict: RoutingVerdict
  expectedRoute: string
  actualRoute: string | null
}

export function gradeRouting(input: {
  expectedRoute: 'send' | 'queue' | 'unknown'
  actualRoute: 'send' | 'queue' | 'drop' | null
}): RoutingGrade {
  if (input.expectedRoute === 'unknown' || input.actualRoute === null) {
    return { verdict: 'not_applicable', expectedRoute: input.expectedRoute, actualRoute: input.actualRoute }
  }

  // 'drop' (TAC-308 knowledge-gap-card protection) is never what
  // expected_route predicts — a real routing failure worth a look, not a
  // silent not_applicable.
  const verdict = input.actualRoute === input.expectedRoute ? 'pass' : 'fail'
  return { verdict, expectedRoute: input.expectedRoute, actualRoute: input.actualRoute }
}

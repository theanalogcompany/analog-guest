import type { HumanEvalJudgment } from '@/lib/eval/human-eval'
import type { GoldenV1, GoldenV2 } from '@/lib/schemas/golden'
import { patchJson, postJson, type FetchResult } from '../../../_lib/fetch-json'
import type { HumanEvalSessionView, HumanEvalUnitView } from './types'

// The human-evaluation routes, one wrapper each. The HTTP half is
// `(authed)/_lib/fetch-json.ts`, shared with every other admin surface.
//
// EVERY WRITE ANSWERS WITH THE STORED ROW, and the client renders that rather
// than its own optimistic copy. A verdict that failed to persist must not sit
// on screen looking recorded - that is the one failure this surface cannot
// tolerate, because the rater has no way to tell and the pass's whole value is
// that the rows are the record.

export function postPass(
  venueId: string,
): Promise<FetchResult<{ session: HumanEvalSessionView }>> {
  return postJson('/admin/tests/human-eval/api/sessions', { venueId })
}

export function postPair(body: {
  sessionId: string
  questionKey: string
  v1: GoldenV1
  v2: GoldenV2
}): Promise<FetchResult<{ unit: HumanEvalUnitView }>> {
  return postJson('/admin/tests/human-eval/api/units', body)
}

export function patchJudgment(
  unitId: string,
  judgment: HumanEvalJudgment,
): Promise<FetchResult<{ unit: HumanEvalUnitView }>> {
  return patchJson(`/admin/tests/human-eval/api/units/${unitId}`, judgment)
}

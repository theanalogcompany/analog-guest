import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/db/admin'
import { HumanEvalJudgmentSchema } from '@/lib/eval/human-eval'
import {
  HUMAN_EVAL_UNIT_COLUMNS,
  unitViewFromRow,
  type HumanEvalUnitRow,
} from '../../../_lib/map-unit'
import { parseJsonBody } from '../../../_lib/parse-body'
import {
  refuseIfSubmitted,
  requireUnitAdmin,
} from '../../../_lib/require-pass-admin'

// PATCH /admin/tests/human-eval/api/units/<unitId> - record what the rater
// decided about one row.
//
// THE WHOLE JUDGMENT GOES OVER THE WIRE EVERY TIME, nulls included, and all
// four columns are written. That is the admin write boundary's rule
// (app/admin/CLAUDE.md: read-modify-write and validate the whole object), and
// here it is also what keeps the row internally consistent: flipping the last
// failing verdict to `pass` has to be able to clear a preference that no
// longer has anything to adjudicate, which a per-field patch could not
// express.
//
// THIS ROUTE CANNOT UNBLIND A ROW, because nothing can: the surface has no
// reveal and the CSV export is the only place A and B are named. That is why
// there is no `revealed_at` write here and no gate guarding one - "the
// verdicts in this pass were given blind" is a property of what the page can
// render rather than a claim this route has to police. The column is still in
// the schema, holding old passes' stamps, and nothing reads it.
//
// A COMMENT IS REQUIRED ON A FAILING ROW, AND NOT BY THIS ROUTE. The whole
// judgment arrives on every write, so the click that marks the first `fail`
// necessarily carries an empty note - a 400 here would make that click
// unsaveable. `judgmentComplete` (lib/eval/human-eval.ts) is where the rule
// lives; the page renders it and the session bar counts it.

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  context: { params: Promise<{ unitId: string }> },
): Promise<NextResponse> {
  const { unitId } = await context.params
  const auth = await requireUnitAdmin(unitId)
  if (!auth.ok) return auth.response
  // Before the body is even read: a submitted pass does not accept a verdict,
  // and this is the enforcement rather than the disabled button the rater
  // sees (migration 084).
  const frozen = refuseIfSubmitted(auth)
  if (frozen !== null) return frozen

  const parsed = await parseJsonBody(request, HumanEvalJudgmentSchema)
  if (!parsed.ok) return parsed.response
  const judgment = parsed.body

  const supabase = createAdminClient()
  const now = new Date().toISOString()
  const updated = await supabase
    .from('human_eval_units')
    .update({
      a_verdict: judgment.aVerdict,
      b_verdict: judgment.bVerdict,
      preference: judgment.preference,
      // '' from an empty textarea is stored as null, so "the rater typed
      // nothing" and "the rater typed and then cleared it" read the same -
      // which they are.
      note: judgment.note.trim().length === 0 ? null : judgment.note,
      // The most recent verdict write, or null on a row whose verdicts were
      // both cleared. An unjudged row must not carry a judged instant.
      judged_at:
        judgment.aVerdict === null && judgment.bVerdict === null ? null : now,
    })
    .eq('id', auth.unitId ?? unitId)
    .select(HUMAN_EVAL_UNIT_COLUMNS)
    .single()
  if (updated.error || !updated.data)
    return NextResponse.json(
      {
        error: `could not record the verdict: ${updated.error?.message ?? 'no row returned'}`,
      },
      { status: 500 },
    )

  return NextResponse.json({
    unit: unitViewFromRow(updated.data as HumanEvalUnitRow),
  })
}

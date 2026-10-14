import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/db/admin'
import { HumanEvalJudgmentSchema } from '@/lib/eval/human-eval'
import {
  HUMAN_EVAL_UNIT_COLUMNS,
  unitViewFromRow,
  type HumanEvalUnitRow,
} from '../../../_lib/map-unit'
import { parseJsonBody } from '../../../_lib/parse-body'
import { requireUnitAdmin } from '../../../_lib/require-pass-admin'

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
// REVEAL IS ONE-WAY AND GATED. `revealed_at` is stamped the first time the
// rater unblinds a row and never cleared, and a reveal is refused outright
// while either verdict is missing. Both halves matter: the gate is what makes
// "the verdicts in this pass were given blind" a property of the surface
// rather than a claim on it, and the one-way stamp is what stops a later write
// from erasing the evidence that a row was revealed before its verdict
// changed. The CSV export derives that comparison per row.

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  context: { params: Promise<{ unitId: string }> },
): Promise<NextResponse> {
  const { unitId } = await context.params
  const auth = await requireUnitAdmin(unitId)
  if (!auth.ok) return auth.response

  const parsed = await parseJsonBody(request, HumanEvalJudgmentSchema)
  if (!parsed.ok) return parsed.response
  const judgment = parsed.body

  const bothJudged = judgment.aVerdict !== null && judgment.bVerdict !== null
  if (judgment.revealed && !bothJudged)
    return NextResponse.json(
      {
        error:
          'a row cannot be unblinded before both replies have a verdict - that is what makes the pass blind',
      },
      { status: 400 },
    )

  const supabase = createAdminClient()
  // Read-modify-write: `revealed_at` is stamped once and the stored value is
  // what decides, so a second reveal does not move the instant a verdict is
  // compared against.
  const current = await supabase
    .from('human_eval_units')
    .select('revealed_at')
    .eq('id', auth.unitId ?? unitId)
    .maybeSingle()
  if (current.error || !current.data)
    return NextResponse.json(
      { error: `row unreadable: ${current.error?.message ?? 'gone'}` },
      { status: 500 },
    )

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
      revealed_at: current.data.revealed_at ?? (judgment.revealed ? now : null),
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

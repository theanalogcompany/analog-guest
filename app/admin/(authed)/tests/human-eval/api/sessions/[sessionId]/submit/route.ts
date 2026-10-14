import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/db/admin'
import {
  humanEvalBlockers,
  humanEvalCompleteness,
  humanEvalQuestions,
  isUnitJudgeable,
} from '@/lib/eval/human-eval'
import {
  HUMAN_EVAL_UNIT_COLUMNS,
  unitViewFromRow,
  type HumanEvalUnitRow,
} from '../../../../_lib/map-unit'
import {
  refuseIfSubmitted,
  requireSessionAdmin,
} from '../../../../_lib/require-pass-admin'

// POST /admin/tests/human-eval/api/sessions/<sessionId>/submit - finish a
// pass: freeze it, and let its CSV exist.
//
// THE COMPLETENESS CHECK IS RE-COMPUTED HERE FROM THE ROWS, never taken from
// the client. The button is disabled on the same counts, but a disabled
// button is a statement about a page, not about a pass - and this surface's
// whole output is a file asserting that a human judged every row in it. The
// rule and the label come from one function (`humanEvalCompleteness`), so the
// refusal cannot say something the button did not.
//
// SUBMITTING IS ONE-WAY AND IT IS THE POINT. From here the PATCH and the
// pair-store routes answer 409 (`refuseIfSubmitted`), so the rows cannot move
// after the CSV quotes them, and the export - which refuses an unsubmitted
// pass - will serve it. Those three together are what make the file the pass
// rather than a snapshot of it. There is no unsubmit route; reopening is an
// operator UPDATE in Studio, by someone who knows the downloaded file is now
// stale (migration 084).
//
// A SECOND SUBMIT IS A 409, not an idempotent no-op: the two calls would be
// the same request with different meanings, and "already submitted at 09:41"
// is the answer the second one deserves.

export const dynamic = 'force-dynamic'

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  const { sessionId } = await context.params
  const auth = await requireSessionAdmin(sessionId)
  if (!auth.ok) return auth.response
  const already = refuseIfSubmitted(auth)
  if (already !== null) return already

  const supabase = createAdminClient()
  const units = await supabase
    .from('human_eval_units')
    .select(HUMAN_EVAL_UNIT_COLUMNS)
    .eq('session_id', auth.sessionId)
  // Fails CLOSED: a pass whose rows cannot be read cannot be declared
  // complete. The cost of refusing wrongly is one retry; the cost of
  // accepting wrongly is a frozen pass and a CSV nobody checked.
  if (units.error)
    return NextResponse.json(
      { error: `rows unreadable, nothing submitted: ${units.error.message}` },
      { status: 500 },
    )

  const views = (units.data as HumanEvalUnitRow[]).map(unitViewFromRow)
  // `humanEvalQuestions` on BOTH sides of this: the coverage target and the
  // set a stored row is matched against. Orphans - a row whose question left
  // the set - do not count toward coverage, because one cannot stand in for a
  // question still in it, but they are judged like any other row.
  const inSet = new Set(humanEvalQuestions().map((q) => q.key))
  const completeness = humanEvalCompleteness(
    views.map((unit) => ({
      judgeable: isUnitJudgeable(unit),
      aVerdict: unit.aVerdict,
      bVerdict: unit.bVerdict,
      note: unit.note,
    })),
    humanEvalQuestions().length,
    views.filter((unit) => inSet.has(unit.questionKey)).length,
  )
  if (!completeness.complete)
    return NextResponse.json(
      {
        error: `this pass is not complete: ${humanEvalBlockers(completeness).join(', ')}`,
      },
      { status: 400 },
    )

  const submittedAt = new Date().toISOString()
  // Conditional on `submitted_at is null`, so two clicks racing cannot both
  // stamp it - the second updates no row and is reported as the 409 it is.
  // The gate above reads a row fetched moments earlier, which is a check, not
  // a claim about what is in the table now.
  const updated = await supabase
    .from('human_eval_sessions')
    .update({ submitted_at: submittedAt, submitted_by: auth.operatorId })
    .eq('id', auth.sessionId)
    .is('submitted_at', null)
    .select('id, submitted_at')
    .maybeSingle()
  if (updated.error)
    return NextResponse.json(
      { error: `could not submit the pass: ${updated.error.message}` },
      { status: 500 },
    )
  if (!updated.data)
    return NextResponse.json(
      { error: 'this pass was submitted by another request just now' },
      { status: 409 },
    )

  return NextResponse.json({ submittedAt: updated.data.submitted_at })
}

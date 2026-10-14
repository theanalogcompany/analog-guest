import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/db/admin'
import { CSV_UTF8_BOM } from '@/lib/eval/csv'
import {
  humanEvalBlockers,
  humanEvalCompleteness,
  humanEvalQuestions,
  isUnitJudgeable,
} from '@/lib/eval/human-eval'
import { humanEvalCsvRows, humanEvalRowsToCsv } from '@/lib/eval/human-eval-csv'
import {
  HUMAN_EVAL_UNIT_COLUMNS,
  unitViewFromRow,
  type HumanEvalUnitRow,
} from '../../../../_lib/map-unit'
import {
  refuseIfSubmitted,
  requireSessionAdmin,
} from '../../../../_lib/require-pass-admin'
import { sortUnitsByQuestionOrder } from '../../../../_lib/map-unit'

// POST /admin/tests/human-eval/api/sessions/<sessionId>/submit - finish a
// pass: freeze it, write its CSV, and let the replies go.
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
//
// THE LAST THREE STEPS ARE ORDERED BY WHAT THEIR FAILURES COST, not by what
// reads tidily: stamp, store the file, clear the replies. Every prefix of that
// is a state the surface still works in.
//
//   stamp fails                 nothing happened. The pass is still open and
//                               the button is still there.
//   store fails after stamping  the pass is submitted with its replies intact
//                               and no stored file - which is exactly a pass
//                               submitted before migration 087, and the export
//                               route builds the file from the rows for those.
//                               Reported as a warning, not an error: the pass
//                               IS submitted and its CSV IS downloadable.
//   clear fails after storing   the file exists and the replies linger, which
//                               is the state every pass was in before this
//                               existed. Also a warning.
//
// Reversing it - clearing before the file is written - is the one order where
// a single failed statement destroys the pass. That is the whole reason 087
// stores the file at all.
//
// The CSV IS BUILT FROM THE ROWS THIS ROUTE ALREADY READ for the completeness
// check, by the same function the export route uses. Not re-fetched: the
// rows that were judged complete and the rows in the file have to be the same
// rows, and a second read is a second chance for them not to be.

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

  // Rendered down the file in the order the page renders it down the screen,
  // so a reader comparing the two does not have to re-sort either.
  const csv = `${CSV_UTF8_BOM}${humanEvalRowsToCsv(
    humanEvalCsvRows(sortUnitsByQuestionOrder(views)),
  )}`
  const stored = await supabase
    .from('human_eval_sessions')
    .update({ csv })
    .eq('id', auth.sessionId)
  if (stored.error)
    return NextResponse.json({
      submittedAt: updated.data.submitted_at,
      warning: `the pass is submitted and its CSV is downloadable, but the file could not be stored (${stored.error.message}) - the replies were left in place, so the download builds it from them instead`,
    })

  // LAST. Both columns in one statement, because one absent column is a state
  // nothing should be able to read as "cleared" (the row mapper says so too).
  const cleared = await supabase
    .from('human_eval_units')
    .update({ v1: null, v2: null })
    .eq('session_id', auth.sessionId)
  if (cleared.error)
    return NextResponse.json({
      submittedAt: updated.data.submitted_at,
      warning: `the pass is submitted and its CSV is stored, but the replies could not be cleared (${cleared.error.message}) - has migration 088 been applied?`,
    })

  return NextResponse.json({ submittedAt: updated.data.submitted_at })
}

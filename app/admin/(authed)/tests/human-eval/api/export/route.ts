import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/db/admin'
import { CSV_UTF8_BOM } from '@/lib/eval/csv'
import {
  humanEvalCsvFilename,
  humanEvalCsvRows,
  humanEvalRowsToCsv,
} from '@/lib/eval/human-eval-csv'
import {
  HUMAN_EVAL_UNIT_COLUMNS,
  sortUnitsByQuestionOrder,
  unitViewFromRow,
  type HumanEvalUnitRow,
} from '../../_lib/map-unit'
import { requireSessionAdmin } from '../../_lib/require-pass-admin'

// GET /admin/tests/human-eval/api/export?sessionId=<uuid> - one pass as a CSV
// attachment.
//
// Carries its own auth gate. Route handlers under the (authed) group do not
// inherit the layout's - a download link is still a route handler, and without
// this it would serve a venue's replies unauthenticated.
//
// EVERY GENERATED ROW IS EXPORTED, judged or not, with the unjudged ones
// carrying empty verdict cells. Filtering them out would make a half-finished
// pass read as a complete one with a smaller set, and the row count is how
// anyone reading the file knows which they have.
//
// DOWNLOADING THIS IS THE ONLY WAY TO LEARN WHICH ENGINE WROTE WHICH, and it
// only exists for a SUBMITTED pass. The page has no reveal, so `shown_as_a`
// here is the unblinding; refusing an unsubmitted pass is what stops it being
// used to peek at a pass still being judged, and it is what makes "submitting
// generates the CSV" a fact about this route rather than a sentence about a
// button. A pass cannot be submitted while it is incomplete and cannot change
// after it is, so the file is the pass.
//
// TWO SOURCES FOR THE SAME FILE, and which one answers is not a detail the
// caller can see. Submitting stores the file on the pass and then clears the
// replies (migration 087, 088), so a pass submitted from then on serves the
// stored bytes. A pass submitted BEFORE that still has its replies and no
// stored copy, and its file is built here from the rows by the same function
// that wrote the stored one - so both downloads are the same spreadsheet, and
// the older passes did not have to be migrated to keep working.
//
// NEITHER SOURCE IS A STATE THIS CAN INVENT A FILE FROM: a pass whose replies
// are gone and whose file was never stored is refused outright rather than
// served as a spreadsheet of empty reply cells. Submitting writes the file
// before it clears anything, so that state means someone cleared the rows by
// hand.

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
  const auth = await requireSessionAdmin(sessionId)
  if (!auth.ok) return auth.response

  const supabase = createAdminClient()
  const session = await supabase
    .from('human_eval_sessions')
    .select('id, git_sha, started_at, submitted_at, csv')
    .eq('id', auth.sessionId)
    .maybeSingle()
  if (session.error || !session.data)
    return NextResponse.json(
      { error: `pass unreadable: ${session.error?.message ?? 'gone'}` },
      { status: 500 },
    )
  if (session.data.submitted_at === null)
    return NextResponse.json(
      {
        error:
          'this pass has not been submitted, so it has no CSV - submit it from /admin/tests/human-eval once every row is judged',
      },
      { status: 409 },
    )

  const filename = humanEvalCsvFilename({
    gitSha: session.data.git_sha,
    startedAt: session.data.started_at,
  })
  const attachment = (csv: string): NextResponse =>
    new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })

  // The stored file, byte for byte as the submit route wrote it. The BOM is
  // part of those bytes, which is why it is not added again here.
  if (session.data.csv !== null) return attachment(session.data.csv)

  const units = await supabase
    .from('human_eval_units')
    .select(HUMAN_EVAL_UNIT_COLUMNS)
    .eq('session_id', auth.sessionId)
  if (units.error)
    return NextResponse.json(
      { error: `rows unreadable: ${units.error.message}` },
      { status: 500 },
    )

  const views = sortUnitsByQuestionOrder(
    (units.data as HumanEvalUnitRow[]).map(unitViewFromRow),
  )
  // Fails CLOSED rather than serving a file with every reply cell blank. See
  // the header: submitting stores the file first, so this is unreachable
  // except by hand.
  if (views.some((unit) => unit.answersAbsent))
    return NextResponse.json(
      {
        error:
          "this pass's replies are no longer stored and no CSV was saved with it, so the file cannot be rebuilt - whoever has the download from when it was submitted has the only copy",
      },
      { status: 409 },
    )

  return attachment(
    `${CSV_UTF8_BOM}${humanEvalRowsToCsv(humanEvalCsvRows(views))}`,
  )
}

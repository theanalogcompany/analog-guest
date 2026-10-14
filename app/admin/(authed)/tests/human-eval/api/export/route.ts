import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/db/admin'
import { CSV_UTF8_BOM } from '@/lib/eval/csv'
import { goldenInputCells } from '@/lib/eval/golden-csv'
import { unblind } from '@/lib/eval/human-eval'
import {
  humanEvalCsvFilename,
  humanEvalRowsToCsv,
  type HumanEvalCsvRow,
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

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
  const auth = await requireSessionAdmin(sessionId)
  if (!auth.ok) return auth.response

  const supabase = createAdminClient()
  const session = await supabase
    .from('human_eval_sessions')
    .select('id, git_sha, started_at, submitted_at')
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

  const units = await supabase
    .from('human_eval_units')
    .select(HUMAN_EVAL_UNIT_COLUMNS)
    .eq('session_id', auth.sessionId)
  if (units.error)
    return NextResponse.json(
      { error: `rows unreadable: ${units.error.message}` },
      { status: 500 },
    )

  const rows: HumanEvalCsvRow[] = sortUnitsByQuestionOrder(
    (units.data as HumanEvalUnitRow[]).map(unitViewFromRow),
  ).map((unit) => {
    const question = unit.question
    const input = goldenInputCells(question)
    // The one definition of "what this A/B answer says about the engines"
    // (lib/eval/human-eval.ts), so the file and the page cannot disagree
    // about which engine won a row.
    const read = unblind(unit)
    return {
      question_key: unit.questionKey,
      group: question?.group ?? 'orphan',
      question: question?.question ?? '(question no longer in the set)',
      history: input.history,
      inbound: input.inbound,
      v1_reply:
        unit.v1 === null
          ? 'UNREADABLE stored column'
          : unit.v1.ok
            ? unit.v1.bubbles.join('\n')
            : '',
      v2_reply:
        unit.v2 === null
          ? 'UNREADABLE stored column'
          : unit.v2.ok
            ? unit.v2.messages.join('\n')
            : '',
      shown_as_a: unit.aArm,
      a_verdict: unit.aVerdict ?? '',
      b_verdict: unit.bVerdict ?? '',
      v1_verdict: read.v1Verdict ?? '',
      v2_verdict: read.v2Verdict ?? '',
      better: read.better ?? '',
      why: unit.note,
      v1_substitute: unit.v1?.ok ? (unit.v1.substitute ?? '') : '',
      v2_gate: unit.v2?.ok ? (unit.v2.gateVerdict ?? '') : '',
      v1_ms: unit.v1 === null ? '' : String(unit.v1.durationMs),
      v2_ms: unit.v2 === null ? '' : String(unit.v2.durationMs),
      v1_error:
        unit.v1 !== null && !unit.v1.ok
          ? `${unit.v1.stage}: ${unit.v1.error}`
          : '',
      v2_error:
        unit.v2 !== null && !unit.v2.ok
          ? `${unit.v2.stage}: ${unit.v2.error}`
          : '',
      generated_at: unit.generatedAt,
      judged_at: unit.judgedAt ?? '',
    }
  })

  const filename = humanEvalCsvFilename({
    gitSha: session.data.git_sha,
    startedAt: session.data.started_at,
  })
  return new NextResponse(`${CSV_UTF8_BOM}${humanEvalRowsToCsv(rows)}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

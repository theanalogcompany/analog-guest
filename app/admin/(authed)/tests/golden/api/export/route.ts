import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/db/admin'
import { GOLDEN_QUESTIONS } from '@/lib/eval/golden-set'
import {
  goldenCsvFilename,
  goldenRowsToCsv,
  type GoldenCsvRow,
} from '@/lib/eval/golden-csv'
import { GoldenV1Schema, GoldenV2Schema } from '@/lib/schemas/golden'
import { requireTestsAdmin } from '../../../_lib/require-tests-admin'

// GET /admin/tests/golden/api/export?runId=<uuid> - one run as a CSV
// attachment, for reading the answers side by side in a spreadsheet.
//
// Lives at /admin/{surface}/api/{thing} and NOT /api/admin/...: the host gate
// in root middleware.ts 404s anything not starting with /admin on the admin
// apex, so the other path works locally and on previews and 404s in
// production.
//
// Carries its own auth gate. Route handlers under the (authed) group do not
// inherit the layout's - a download link is still a route handler, and
// without this it would serve a venue's replies unauthenticated.

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireTestsAdmin()
  if (!auth.ok) return auth.response

  const runId = new URL(request.url).searchParams.get('runId')
  if (
    runId === null ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      runId,
    )
  )
    return NextResponse.json({ error: 'runId must be a uuid' }, { status: 400 })

  const supabase = createAdminClient()
  const run = await supabase
    .from('golden_runs')
    .select('id, git_sha, started_at')
    .eq('id', runId)
    .maybeSingle()
  if (run.error)
    return NextResponse.json(
      { error: `run unreadable: ${run.error.message}` },
      { status: 500 },
    )
  if (!run.data)
    return NextResponse.json({ error: 'no such run' }, { status: 404 })

  const units = await supabase
    .from('golden_run_units')
    .select('question_key, v1, v2')
    .eq('run_id', runId)
  if (units.error)
    return NextResponse.json(
      { error: `units unreadable: ${units.error.message}` },
      { status: 500 },
    )

  const byKey = new Map(GOLDEN_QUESTIONS.map((q) => [q.key, q]))
  const order = new Map(GOLDEN_QUESTIONS.map((q, i) => [q.key, i]))
  const rows: GoldenCsvRow[] = (units.data ?? [])
    .slice()
    .sort(
      (a, b) =>
        (order.get(a.question_key) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.question_key) ?? Number.MAX_SAFE_INTEGER),
    )
    .map((row) => {
      const question = byKey.get(row.question_key) ?? null
      const v1 = GoldenV1Schema.safeParse(row.v1)
      const v2 = GoldenV2Schema.safeParse(row.v2)
      // A column that will not parse becomes an explicit cell, never a blank
      // one: a blank reads as "the engine said nothing", which is a different
      // and false claim.
      const v1Data = v1.success ? v1.data : null
      const v2Data = v2.success ? v2.data : null
      return {
        question_key: row.question_key,
        group: question?.group ?? 'orphan',
        question: question?.question ?? '(question no longer in the set)',
        // The input, beside the answers. An orphan key has no code definition
        // left, so its transcript is genuinely unknown rather than empty -
        // said so, never rendered as a cold open it may not have been.
        history:
          question === null
            ? '(unknown - question no longer in the set)'
            : (question.history ?? [])
                .map(
                  (t) => `${t.role === 'user' ? 'guest' : 'venue'}: ${t.text}`,
                )
                .join('\n'),
        inbound:
          question === null
            ? ''
            : (question.messages ?? [question.question]).join('\n'),
        media: question?.mediaUrls?.join('\n') ?? '',
        v1_reply:
          v1Data === null
            ? 'UNREADABLE stored column'
            : v1Data.ok
              ? v1Data.bubbles.join('\n')
              : '',
        v2_reply:
          v2Data === null
            ? 'UNREADABLE stored column'
            : v2Data.ok
              ? v2Data.messages.join('\n')
              : '',
        v1_category: v1Data?.ok ? v1Data.category : '',
        v1_recognition_state: v1Data?.ok ? v1Data.recognitionState : '',
        v1_substitute: v1Data?.ok ? (v1Data.substitute ?? '') : '',
        v2_state: v2Data?.ok ? v2Data.stateKey : '',
        v2_gate: v2Data?.ok ? (v2Data.gateVerdict ?? '') : '',
        v2_gate_matched: v2Data?.ok ? v2Data.gateMatched.join(' ') : '',
        v1_ms: v1Data === null ? '' : String(v1Data.durationMs),
        v2_ms: v2Data === null ? '' : String(v2Data.durationMs),
        v1_error:
          v1Data !== null && !v1Data.ok
            ? `${v1Data.stage}: ${v1Data.error}`
            : '',
        v2_error:
          v2Data !== null && !v2Data.ok
            ? `${v2Data.stage}: ${v2Data.error}`
            : '',
      }
    })

  const filename = goldenCsvFilename({
    gitSha: run.data.git_sha,
    startedAt: run.data.started_at,
  })
  // The leading BOM is what makes Excel read the file as UTF-8 rather than as
  // the local codepage; without it a curly apostrophe in a reply - and the
  // voice pack is full of them - renders as mojibake. Added here rather than
  // in the serializer so `goldenRowsToCsv` stays plain CSV.
  return new NextResponse(`﻿${goldenRowsToCsv(rows)}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

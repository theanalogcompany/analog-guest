import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/db/admin'
import { humanEvalQuestions } from '@/lib/eval/human-eval'
import { GoldenV1Schema, GoldenV2Schema } from '@/lib/schemas/golden'
import {
  HUMAN_EVAL_UNIT_COLUMNS,
  unitViewFromRow,
  type HumanEvalUnitRow,
} from '../../_lib/map-unit'
import { parseJsonBody } from '../../_lib/parse-body'
import {
  refuseIfSubmitted,
  requireSessionAdmin,
} from '../../_lib/require-pass-admin'

// POST /admin/tests/human-eval/api/units - store one question's pair of
// answers, scrambled.
//
// WRITTEN THE MOMENT THE PAIR LANDS, one request per question, rather than
// once at the end of a pass. A pass is up to 58 questions times two live
// generations and takes minutes; losing it to a reload, a dev-server restart
// or a late failure in the cheap half is the specific failure the measurement
// convention's checkpoint rule exists for (scripts/CLAUDE.md #2). There is no
// JSONL behind a browser, so these rows are the only record.
//
// THE SERVER PICKS THE SCRAMBLE. Not because the client could not - it holds
// both replies either way, so blinding is a property of what the UI renders -
// but because the coin and the row that records it then cannot disagree. One
// coin, one writer, recorded with the answers it ordered.
//
// RE-GENERATING A QUESTION CLEARS ITS VERDICTS, and re-flips the coin. A
// verdict is a judgment of a reply; when the reply changes the judgment is not
// about anything. Keeping it would silently attribute an old verdict to a new
// answer, which is worse than making the rater judge the row again.

export const dynamic = 'force-dynamic'

const PostBodySchema = z.object({
  sessionId: z.string().uuid(),
  questionKey: z.string().min(1).max(64),
  // The same shapes the golden set stores, validated at the boundary rather
  // than trusted: these columns are read back through these schemas, and a
  // row that will not parse is a reply nobody can judge.
  v1: GoldenV1Schema,
  v2: GoldenV2Schema,
})

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = await parseJsonBody(request, PostBodySchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.body

  const auth = await requireSessionAdmin(body.sessionId)
  if (!auth.ok) return auth.response
  // A submitted pass takes no new answers either. Re-generating one would
  // replace a reply the exported CSV already quoted, leaving the file and the
  // rows disagreeing about what was judged.
  const frozen = refuseIfSubmitted(auth)
  if (frozen !== null) return frozen

  // Refused by name, and this is not a formality: a scenario only one engine
  // can answer has no pair to scramble, so storing one would put a reply in
  // column A and a labelled gap in column B - which identifies the arm and is
  // not a comparison. `humanEvalQuestions` is the one definition of what a
  // blind pass may cover.
  if (!humanEvalQuestions().some((q) => q.key === body.questionKey))
    return NextResponse.json(
      {
        error: `'${body.questionKey}' is not a question a blind pass can use - either it is not in the golden set, or only one engine can be asked it`,
      },
      { status: 400 },
    )

  const supabase = createAdminClient()
  const stored = await supabase
    .from('human_eval_units')
    .upsert(
      {
        session_id: auth.sessionId,
        question_key: body.questionKey,
        // The coin. `Math.random` is the right tool here: nothing about this
        // needs to be reproducible, and a seeded order would be a scramble
        // someone could predict from the question key.
        a_arm: Math.random() < 0.5 ? 'v1' : 'v2',
        v1: body.v1,
        v2: body.v2,
        // Explicit nulls, not omitted fields: on the conflict path this row
        // already exists and these are the columns that must not survive a new
        // pair of answers. An omitted key in an upsert leaves the old value.
        a_verdict: null,
        b_verdict: null,
        preference: null,
        note: null,
        generated_at: new Date().toISOString(),
        judged_at: null,
      },
      { onConflict: 'session_id,question_key' },
    )
    .select(HUMAN_EVAL_UNIT_COLUMNS)
    .single()
  if (stored.error || !stored.data)
    return NextResponse.json(
      {
        error: `could not store the pair (migration 083 applied?): ${stored.error?.message ?? 'no row returned'}`,
      },
      { status: 500 },
    )

  return NextResponse.json({
    unit: unitViewFromRow(stored.data as HumanEvalUnitRow),
  })
}

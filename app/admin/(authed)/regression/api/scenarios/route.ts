import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/db/admin'
import { RegressionScenarioSchema } from '@/lib/schemas/regression'
import { requireRegressionAdmin } from '../../_lib/require-regression-admin'

// POST /admin/regression/api/scenarios - add a scenario.
//
// Strict boundary (the admin write boundary is stricter than the live read
// boundary): the whole body must parse as a RegressionScenario; unknown keys
// are rejected rather than dropped. 23505 on the key is an outcome, not an
// error - the UI tells the operator the key is taken.

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireRegressionAdmin()
  if (!auth.ok) return auth.response

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const parsed = RegressionScenarioSchema.strict().safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      },
      { status: 400 },
    )
  }

  const supabase = createAdminClient()
  const { error } = await supabase.from('regression_scenarios').insert({
    key: parsed.data.key,
    lesson: parsed.data.lesson,
    script: parsed.data.script,
    target: parsed.data.target,
    expect_first_name: parsed.data.expectFirstName,
    no_turn_one_name_ask: parsed.data.noTurnOneNameAsk,
    expect_reply_contains: parsed.data.expectReplyContains,
    forbid_policy_keys: parsed.data.forbidPolicyKeys,
    enabled: parsed.data.enabled,
  })
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `scenario key "${parsed.data.key}" already exists` },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true }, { status: 201 })
}

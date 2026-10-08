import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/db/admin'
import { REGRESSION_SCENARIOS } from '@/lib/eval/regression-scenarios'
import { requireRegressionAdmin } from '../../../_lib/require-regression-admin'

// PATCH/DELETE /admin/regression/api/scenarios/[key] - the enabled overlay.
//
// There is no POST. A scenario exists in REGRESSION_SCENARIOS
// (lib/eval/regression-scenarios.ts) or it does not exist, so creating one
// is a code edit reviewed in a PR, never a row typed into this surface
// (decision 0011, migration 077). What is left is the one lever a table can
// pull that code cannot: flipping `enabled` without a deploy.
//
// PATCH upserts {key, enabled} for a code-defined key. The row carries no
// definition - those columns are dead as of 077 - so this writes nothing
// that could later be read as authoritative.
//
// DELETE clears the overlay ROW, which is not "delete the scenario": for a
// code-defined key the code's own `enabled` takes over again, and for an
// orphan key the stale row goes away. Naming it anything stronger would be
// a claim the route cannot honour.

const PatchBodySchema = z.object({ enabled: z.boolean() }).strict()

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ key: string }>
}

export async function PATCH(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const auth = await requireRegressionAdmin()
  if (!auth.ok) return auth.response
  const { key } = await params

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const parsed = PatchBodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'body must be exactly {enabled: boolean}' },
      { status: 400 },
    )
  }

  // Only a code-defined key can be toggled. An overlay row for anything else
  // would never run, so accepting the write would be theatre.
  if (!REGRESSION_SCENARIOS.some((s) => s.key === key)) {
    return NextResponse.json(
      {
        error: `"${key}" is not a scenario in lib/eval/regression-scenarios.ts - nothing to enable or disable`,
      },
      { status: 404 },
    )
  }

  const supabase = createAdminClient()
  const { error } = await supabase.from('regression_scenarios').upsert(
    {
      key,
      enabled: parsed.data.enabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' },
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const auth = await requireRegressionAdmin()
  if (!auth.ok) return auth.response
  const { key } = await params

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('regression_scenarios')
    .delete()
    .eq('key', key)
    .select('key')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: 'no overlay row for that key' },
      { status: 404 },
    )
  }
  return NextResponse.json({ ok: true })
}

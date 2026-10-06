import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/db/admin'
import { requireRegressionAdmin } from '../../../_lib/require-regression-admin'

// PATCH/DELETE /admin/regression/api/scenarios/[key].
//
// PATCH toggles `enabled` - the soft delete, and the default path in the UI:
// a scenario that caught something once should not vanish silently. DELETE
// is the explicit hard remove; historical run verdicts keep the key as text,
// so a removed scenario's past results stay readable.

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

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('regression_scenarios')
    .update({
      enabled: parsed.data.enabled,
      updated_at: new Date().toISOString(),
    })
    .eq('key', key)
    .select('key')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'scenario not found' }, { status: 404 })
  }
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
    return NextResponse.json({ error: 'scenario not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}

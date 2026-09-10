import { NextResponse } from 'next/server'
import { requireMechanicAdmin } from '@/lib/auth'
import { MechanicPatchSchema } from '@/lib/schemas'
import { deactivateMechanic, editMechanic } from '../../../../_lib/mechanics'

// PATCH/DELETE /admin/venues/api/mechanics/[mechanicId] — edit or deactivate
// a mechanic. DELETE deactivates (is_active=false, deactivated_at=now()),
// never a hard DELETE — engagement_events.mechanic_id FK-references
// mechanic rows, so a real delete would orphan or cascade-destroy
// redemption history.

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ mechanicId: string }>
}

export async function PATCH(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { mechanicId } = await params
  const auth = await requireMechanicAdmin(mechanicId)
  if (!auth.ok) return auth.response

  let body: ReturnType<typeof MechanicPatchSchema.parse>
  try {
    const raw = await request.json()
    const parsed = MechanicPatchSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid body', detail: parsed.error.message },
        { status: 400 },
      )
    }
    body = parsed.data
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const result = await editMechanic({ mechanicId, patch: body })
  if (!result.ok) {
    const status =
      result.errorCode === 'not_found'
        ? 404
        : result.errorCode === 'invalid_after_merge' || result.errorCode === 'no_op'
          ? 400
          : 500
    return NextResponse.json(
      { error: 'mechanic edit failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }

  return NextResponse.json({ success: true, mechanicId: result.mechanicId })
}

export async function DELETE(
  _request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { mechanicId } = await params
  const auth = await requireMechanicAdmin(mechanicId)
  if (!auth.ok) return auth.response

  const result = await deactivateMechanic(mechanicId)
  if (!result.ok) {
    const status = result.errorCode === 'not_found' ? 404 : 500
    return NextResponse.json(
      { error: 'mechanic deactivate failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }

  return NextResponse.json({ success: true, deactivated: true })
}

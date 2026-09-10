import { NextResponse } from 'next/server'
import { requireVenueAdmin } from '@/lib/auth'
import { MechanicCreateSchema } from '@/lib/schemas'
import { addMechanic } from '../../../../../_lib/mechanics'

// POST /admin/venues/api/venues/[venueId]/mechanics — add a new mechanic.
// Every field is required (MechanicCreateSchema, not the .partial() patch
// shape) — a new mechanic starts fully parameterized rather than
// accumulating the same gaps Readiness exists to flag.

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  const { venueId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  let body: ReturnType<typeof MechanicCreateSchema.parse>
  try {
    const raw = await request.json()
    const parsed = MechanicCreateSchema.safeParse(raw)
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

  const result = await addMechanic({ venueId, mechanic: body })
  if (!result.ok) {
    return NextResponse.json(
      { error: 'mechanic add failed', detail: result.error, errorCode: result.errorCode },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true, mechanicId: result.mechanicId })
}

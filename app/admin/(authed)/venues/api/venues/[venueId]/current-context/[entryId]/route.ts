import { NextResponse } from 'next/server'
import { requireVenueAdmin } from '@/lib/auth'
import { dropCurrentContextEntry } from '../../../../../../_lib/current-context'

// DELETE /admin/venues/api/venues/[venueId]/current-context/[entryId] —
// "Drop" from the expiry queue, or an early removal of a still-active
// entry — same operation either way, per §2: "Drop — remove the entry."

export const dynamic = 'force-dynamic'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ venueId: string; entryId: string }> },
): Promise<NextResponse> {
  const { venueId, entryId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  const result = await dropCurrentContextEntry({ venueId, entryId })
  if (!result.ok) {
    const status = result.errorCode === 'not_found' ? 404 : 500
    return NextResponse.json(
      { error: 'currentContext drop failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }

  return NextResponse.json({ success: true, dropped: true })
}

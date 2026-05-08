import { NextResponse } from 'next/server'
import { requireVenueAdmin } from '@/lib/auth'
import { findActiveClusters } from '@/lib/voices'

// GET /admin/voices/api/patterns/[venueId] — re-derive all confirmed
// pattern clusters across the venue's unresolved edit_only critique
// pool. Called from the rail-rules tab on every load to compute the
// banner count + panel contents.
//
// Cost: one Sonnet verification call per candidate cluster. Documented
// in CLAUDE.md alongside the persist-cluster_signature follow-up TODO.

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  const { venueId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  const clusters = await findActiveClusters(venueId)
  return NextResponse.json({ success: true, clusters })
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'

// POST /admin/voices/api/patterns/[venueId]/dismiss — mark cluster member
// critiques as dismissed so the cluster doesn't re-trigger on subsequent
// rail loads. Doesn't write any rule.
//
// Client refetches via GET on success.

const PostBodySchema = z.object({
  critiqueIds: z.array(z.string().uuid()).min(1),
})

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  const { venueId } = await params
  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  let body: z.infer<typeof PostBodySchema>
  try {
    const raw = await request.json()
    const parsed = PostBodySchema.safeParse(raw)
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

  const supabase = createAdminClient()
  const { error: updErr } = await supabase
    .from('voice_critiques')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('venue_id', venueId)
    .in('id', body.critiqueIds)
  if (updErr) {
    return NextResponse.json(
      { error: 'critique dismiss write failed', detail: updErr.message },
      { status: 500 },
    )
  }

  return NextResponse.json({
    success: true,
    dismissed: body.critiqueIds.length,
  })
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { dedupeAndAppendAntiPatterns } from '@/lib/voice-training'

// POST /admin/voices/api/patterns/[venueId]/promote — promote a confirmed
// pattern cluster into a venue rule. Two effects in serial:
//
//   1. Append the synthesized rule to brand_persona.voiceAntiPatterns
//      with source='auto' — that's the source pill that distinguishes
//      promoted-from-cluster rules from manually-typed ones in the rail.
//   2. Mark all member critiques `promoted_at = now()` so the cluster
//      stops surfacing in subsequent GET /patterns calls.
//
// Client refetches via GET on success — banner count decrements there.

const PostBodySchema = z.object({
  critiqueIds: z.array(z.string().uuid()).min(1),
  ruleText: z.string().min(1),
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

  // 1. Append the rule
  let added: string[]
  try {
    const result = await dedupeAndAppendAntiPatterns(
      venueId,
      [body.ruleText.trim()],
      { source: 'auto', authorOperatorId: auth.operatorId },
    )
    added = result.added
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: 'anti-pattern append failed', detail: errMsg },
      { status: 500 },
    )
  }

  // 2. Mark member critiques promoted. Scoped to this venue so a stale
  // member id from a different venue can't be flipped.
  const supabase = createAdminClient()
  const { error: updErr } = await supabase
    .from('voice_critiques')
    .update({ promoted_at: new Date().toISOString() })
    .eq('venue_id', venueId)
    .in('id', body.critiqueIds)
  if (updErr) {
    return NextResponse.json(
      { error: 'critique promote write failed', detail: updErr.message },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true, added })
}

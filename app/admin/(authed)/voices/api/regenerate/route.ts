import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { regenerateWithCritique } from '@/lib/voices'

// POST /admin/voices/api/regenerate — runs the regen helper for one
// flagged outbound + critique. Returns one attempt; the playground
// accumulates attempts client-side across multiple POSTs.
//
// No PostHog, no Langfuse, no alerts. The operator is staring at the
// screen — they ARE the observability surface for regen.

const PostBodySchema = z.object({
  venueId: z.string().uuid(),
  originalMessageId: z.string().uuid(),
  critique: z.string().min(1),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
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

  const auth = await requireVenueAdmin(body.venueId)
  if (!auth.ok) return auth.response

  const result = await regenerateWithCritique({
    venueId: body.venueId,
    originalMessageId: body.originalMessageId,
    critique: body.critique,
  })
  if (!result.ok) {
    const status =
      result.errorCode === 'message_not_found' ||
      result.errorCode === 'inbound_not_found'
        ? 404
        : result.errorCode === 'not_an_outbound_reply'
          ? 400
          : 500
    return NextResponse.json(
      { error: 'regenerate failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }

  return NextResponse.json({
    success: true,
    body: result.data.body,
    voiceFidelity: result.data.voiceFidelity,
    attempts: result.data.attempts,
    attemptScores: result.data.attemptScores,
    generatedAt: result.data.generatedAt.toISOString(),
  })
}

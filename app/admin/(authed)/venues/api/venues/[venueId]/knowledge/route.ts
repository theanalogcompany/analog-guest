import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { PrimaryTagSchema } from '@/lib/schemas'
import { addKnowledgeEntry } from '../../../../../_lib/knowledge-corpus'

// POST /admin/venues/api/venues/[venueId]/knowledge — ad-hoc knowledge_corpus
// addition, one per named §2 section that renders knowledge chunks. Mirrors
// /admin/voices/api/venues/[venueId]/corpus (TAC-343 plan review).

const PostBodySchema = z.object({
  content: z.string().min(1),
  primaryTags: z.array(PrimaryTagSchema).min(1),
  secondaryTags: z.array(z.string()).default([]),
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

  const result = await addKnowledgeEntry({
    venueId,
    content: body.content,
    primaryTags: body.primaryTags,
    secondaryTags: body.secondaryTags,
    addedByOperatorId: auth.operatorId,
  })
  if (!result.ok) {
    const status = result.errorCode === 'embed_failed' ? 502 : 500
    return NextResponse.json(
      { error: 'knowledge add failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }

  return NextResponse.json({
    success: true,
    corpusId: result.corpusId,
    embeddedChunkCount: result.embeddedChunkCount,
  })
}

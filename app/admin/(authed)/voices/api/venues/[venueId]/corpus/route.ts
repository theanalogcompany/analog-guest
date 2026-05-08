import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { addCorpusEntry, ADD_CORPUS_SOURCE_TYPES } from '@/lib/voice-training'

// POST /admin/voices/api/venues/[venueId]/corpus — ad-hoc voice_corpus
// addition from the rail's "+ Add entry" affordance.
//
// Distinct from the cc-review channel: this path uses 'manual_entry' /
// 'sample_text' / 'past_message' source_type, has no source_ref (no
// idempotency key — duplicates are caught at the operator's eye), and
// stamps added_by_operator_id. cc-review remains on 'operator_edit' via
// upsertCorpusEdit.

const PostBodySchema = z.object({
  content: z.string().min(1),
  sourceType: z.enum(ADD_CORPUS_SOURCE_TYPES),
  tags: z.array(z.string()).default([]),
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

  const result = await addCorpusEntry({
    venueId,
    content: body.content,
    sourceType: body.sourceType,
    tags: body.tags,
    addedByOperatorId: auth.operatorId,
  })
  if (!result.ok) {
    const status = result.errorCode === 'embed_failed' ? 502 : 500
    return NextResponse.json(
      {
        error: 'corpus add failed',
        detail: result.error,
        errorCode: result.errorCode,
      },
      { status },
    )
  }

  return NextResponse.json({
    success: true,
    corpusId: result.corpusId,
    embeddedChunkCount: result.embeddedChunkCount,
  })
}

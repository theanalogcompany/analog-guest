import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireKnowledgeEntryAdmin } from '@/lib/auth'
import { PrimaryTagSchema } from '@/lib/schemas'
import { editKnowledgeEntry, removeKnowledgeEntry } from '../../../../_lib/knowledge-corpus'

// PATCH/DELETE /admin/venues/api/knowledge/[entryId] — edit or remove an
// existing knowledge_corpus row. Mirrors /admin/voices/api/corpus/[entryId].
// Venue allowlist enforced inside requireKnowledgeEntryAdmin (looks up the
// entry's venue_id before any mutation).

const PatchBodySchema = z
  .object({
    content: z.string().min(1).optional(),
    primaryTags: z.array(PrimaryTagSchema).min(1).optional(),
    secondaryTags: z.array(z.string()).optional(),
  })
  .refine(
    (b) => b.content !== undefined || b.primaryTags !== undefined || b.secondaryTags !== undefined,
    { message: 'pass at least one of content, primaryTags, or secondaryTags' },
  )

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ entryId: string }>
}

export async function PATCH(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { entryId } = await params
  const auth = await requireKnowledgeEntryAdmin(entryId)
  if (!auth.ok) return auth.response

  let body: z.infer<typeof PatchBodySchema>
  try {
    const raw = await request.json()
    const parsed = PatchBodySchema.safeParse(raw)
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

  const result = await editKnowledgeEntry({
    corpusId: entryId,
    content: body.content,
    primaryTags: body.primaryTags,
    secondaryTags: body.secondaryTags,
  })
  if (!result.ok) {
    const status = result.errorCode === 'embed_failed' ? 502 : 500
    return NextResponse.json(
      { error: 'knowledge edit failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }
  return NextResponse.json({
    success: true,
    corpusId: result.corpusId,
    reEmbedded: result.reEmbedded,
  })
}

export async function DELETE(
  _request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { entryId } = await params
  const auth = await requireKnowledgeEntryAdmin(entryId)
  if (!auth.ok) return auth.response

  const result = await removeKnowledgeEntry(entryId)
  if (!result.ok) {
    const status = result.errorCode === 'not_found' ? 404 : 500
    return NextResponse.json(
      { error: 'knowledge delete failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }
  return NextResponse.json({ success: true, deleted: true })
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireCorpusEntryAdmin } from '@/lib/auth'
import { editCorpusEntry, removeCorpusEntry } from '@/lib/voice-training'

// PATCH/DELETE /admin/voices/api/corpus/[entryId] — edit or remove an
// existing voice_corpus row.
//
// Venue allowlist enforced inside requireCorpusEntryAdmin (looks up the
// entry's venue_id before any mutation). PATCH re-embeds via Voyage when
// content changes; tags-only updates skip the embed roundtrip.

const PatchBodySchema = z
  .object({
    content: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
  })
  .refine((b) => b.content !== undefined || b.tags !== undefined, {
    message: 'pass at least one of content or tags',
  })

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ entryId: string }>
}

export async function PATCH(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { entryId } = await params
  const auth = await requireCorpusEntryAdmin(entryId)
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

  const result = await editCorpusEntry({
    corpusId: entryId,
    content: body.content,
    tags: body.tags,
  })
  if (!result.ok) {
    const status = result.errorCode === 'embed_failed' ? 502 : 500
    return NextResponse.json(
      { error: 'corpus edit failed', detail: result.error, errorCode: result.errorCode },
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
  const auth = await requireCorpusEntryAdmin(entryId)
  if (!auth.ok) return auth.response

  const result = await removeCorpusEntry(entryId)
  if (!result.ok) {
    const status = result.errorCode === 'not_found' ? 404 : 500
    return NextResponse.json(
      { error: 'corpus delete failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }
  return NextResponse.json({ success: true, deleted: true })
}

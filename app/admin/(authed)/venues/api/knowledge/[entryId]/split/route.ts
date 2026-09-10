import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireKnowledgeEntryAdmin } from '@/lib/auth'
import { PrimaryTagSchema } from '@/lib/schemas'
import { splitKnowledgeEntry } from '../../../../../_lib/knowledge-corpus'

// POST /admin/venues/api/knowledge/[entryId]/split — break one
// knowledge_corpus row into N. Operator-driven: the UI seeds N textareas
// from a naive paragraph split as a starting suggestion, the operator edits
// before confirming, and this route just embeds whatever final strings are
// submitted (TAC-343 plan review — chunkText() is not a subject-boundary
// detector, splitting which claim goes where is a judgment call).

const PostBodySchema = z.object({
  pieces: z
    .array(
      z.object({
        content: z.string().min(1),
        primaryTags: z.array(PrimaryTagSchema).min(1),
        secondaryTags: z.array(z.string()).default([]),
      }),
    )
    .min(2),
})

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ entryId: string }> },
): Promise<NextResponse> {
  const { entryId } = await params
  const auth = await requireKnowledgeEntryAdmin(entryId)
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

  // venueId is resolved server-side from the entry itself, never trusted
  // from the client, per requireKnowledgeEntryAdmin's contract.
  const result = await splitKnowledgeEntry({
    originalId: entryId,
    venueId: auth.venueId,
    pieces: body.pieces,
  })
  if (!result.ok) {
    const status = result.errorCode === 'embed_failed' ? 502 : result.errorCode === 'invalid_input' ? 400 : 500
    return NextResponse.json(
      { error: 'knowledge split failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }

  return NextResponse.json({ success: true, newIds: result.newIds })
}

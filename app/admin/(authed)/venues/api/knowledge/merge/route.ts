import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireKnowledgeEntriesAdmin } from '@/lib/auth'
import { PrimaryTagSchema } from '@/lib/schemas'
import { mergeKnowledgeEntries } from '../../../../_lib/knowledge-corpus'

// POST /admin/venues/api/knowledge/merge — merge N knowledge_corpus rows
// into one. Flat route (not `[entryId]`-scoped) since it takes multiple ids
// in the body. venueId is resolved server-side from the entries themselves
// via requireKnowledgeEntriesAdmin, never trusted from the client.

const PostBodySchema = z.object({
  originalIds: z.array(z.string().uuid()).min(2),
  content: z.string().min(1),
  primaryTags: z.array(PrimaryTagSchema).min(1),
  secondaryTags: z.array(z.string()).default([]),
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

  const auth = await requireKnowledgeEntriesAdmin(body.originalIds)
  if (!auth.ok) return auth.response

  const result = await mergeKnowledgeEntries({
    originalIds: auth.entryIds,
    venueId: auth.venueId,
    content: body.content,
    primaryTags: body.primaryTags,
    secondaryTags: body.secondaryTags,
  })
  if (!result.ok) {
    const status = result.errorCode === 'embed_failed' ? 502 : result.errorCode === 'invalid_input' ? 400 : 500
    return NextResponse.json(
      { error: 'knowledge merge failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }

  return NextResponse.json({ success: true, newId: result.newId })
}

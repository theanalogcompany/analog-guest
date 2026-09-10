import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireVenueAdmin } from '@/lib/auth'
import { PrimaryTagSchema } from '@/lib/schemas'
import { promoteCurrentContextEntry } from '../../../../../../../_lib/current-context'

// POST /admin/venues/api/venues/[venueId]/current-context/[entryId]/promote
// — convert an expired/malformed currentContext entry into a permanent
// knowledge_corpus entry. The operator picks the primary tag at promote
// time (§2: "this is where the tag belongs... the only place a tag is
// actually required"), validated against the canonical list, never free
// text.

const PostBodySchema = z.object({
  primaryTag: PrimaryTagSchema,
  secondaryTags: z.array(z.string()).default([]),
})

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string; entryId: string }> },
): Promise<NextResponse> {
  const { venueId, entryId } = await params
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

  const result = await promoteCurrentContextEntry({
    venueId,
    entryId,
    primaryTag: body.primaryTag,
    secondaryTags: body.secondaryTags,
  })
  if (!result.ok) {
    const status =
      result.errorCode === 'not_found' ? 404 : result.errorCode === 'embed_failed' ? 502 : 500
    return NextResponse.json(
      { error: 'currentContext promote failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }

  return NextResponse.json({ success: true, knowledgeCorpusId: result.knowledgeCorpusId })
}

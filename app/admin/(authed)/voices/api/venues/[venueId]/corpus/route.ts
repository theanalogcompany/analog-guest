import { NextResponse } from 'next/server'
import { z } from 'zod'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { addCorpusEntry, ADD_CORPUS_SOURCE_TYPES } from '@/lib/voice-training'

// POST /admin/voices/api/corpus/[venueId] — ad-hoc voice_corpus addition
// from the rail's "+ Add entry" affordance. THE-237.
//
// Distinct from the cc-review channel: this path uses 'manual_entry' /
// 'sample_text' / 'past_message' source_type, has no source_ref (no
// idempotency key — duplicates are caught at the operator's eye), and
// stamps added_by_operator_id. cc-review remains on 'operator_edit' via
// upsertCorpusEdit.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  // ---- auth ----
  let operatorId: string
  let allowedVenueIds: string[]
  try {
    const supabaseSession = await createServerClient()
    const {
      data: { session },
    } = await supabaseSession.auth.getSession()
    if (!session) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    const op = await verifyAnalogAdminAccess(session.user.id)
    operatorId = op.operatorId
    allowedVenueIds = op.allowedVenueIds
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: 'auth check failed' }, { status: 500 })
  }

  // ---- params + body ----
  const { venueId } = await params
  if (!UUID_RE.test(venueId)) {
    return NextResponse.json({ error: 'invalid venueId' }, { status: 400 })
  }
  if (allowedVenueIds.length > 0 && !allowedVenueIds.includes(venueId)) {
    return NextResponse.json({ error: 'venue not allowed' }, { status: 403 })
  }

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

  // ---- write ----
  const result = await addCorpusEntry({
    venueId,
    content: body.content,
    sourceType: body.sourceType,
    tags: body.tags,
    addedByOperatorId: operatorId,
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

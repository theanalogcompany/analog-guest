import { NextResponse } from 'next/server'
import { z } from 'zod'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import { editCorpusEntry, removeCorpusEntry } from '@/lib/voice-training'

// PATCH/DELETE /admin/voices/api/corpus/[entryId] — edit or remove an
// existing voice_corpus row. THE-237.
//
// Venue allowlist enforced by looking up the entry's venue_id before any
// mutation. PATCH re-embeds via Voyage when content changes; tags-only
// updates skip the embed roundtrip.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

async function authAndAuthorize(
  request: Request,
  entryId: string,
): Promise<
  | { ok: true; operatorId: string; venueId: string }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const supabaseSession = await createServerClient()
  const {
    data: { session },
  } = await supabaseSession.auth.getSession()
  if (!session) {
    return { ok: false, status: 401, body: { error: 'unauthorized' } }
  }
  let op
  try {
    op = await verifyAnalogAdminAccess(session.user.id)
  } catch (e) {
    if (e instanceof AuthError) {
      return { ok: false, status: e.status, body: { error: e.message } }
    }
    return { ok: false, status: 500, body: { error: 'auth check failed' } }
  }

  if (!UUID_RE.test(entryId)) {
    return { ok: false, status: 400, body: { error: 'invalid entryId' } }
  }

  const supabase = createAdminClient()
  const { data: row, error: lookupErr } = await supabase
    .from('voice_corpus')
    .select('id, venue_id')
    .eq('id', entryId)
    .maybeSingle()
  if (lookupErr) {
    return {
      ok: false,
      status: 500,
      body: { error: 'corpus entry lookup failed', detail: lookupErr.message },
    }
  }
  if (!row) {
    return { ok: false, status: 404, body: { error: 'corpus entry not found' } }
  }
  if (op.allowedVenueIds.length > 0 && !op.allowedVenueIds.includes(row.venue_id)) {
    return { ok: false, status: 403, body: { error: 'venue not allowed' } }
  }
  return { ok: true, operatorId: op.operatorId, venueId: row.venue_id }
}

export async function PATCH(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { entryId } = await params
  const auth = await authAndAuthorize(request, entryId)
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })

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
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { entryId } = await params
  const auth = await authAndAuthorize(request, entryId)
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })

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

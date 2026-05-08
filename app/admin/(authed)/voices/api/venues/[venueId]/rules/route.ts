import { NextResponse } from 'next/server'
import { z } from 'zod'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { dedupeAndAppendAntiPatterns, removeAntiPattern } from '@/lib/voice-training'

// POST/DELETE /admin/voices/api/rules/[venueId] — venue anti-pattern adds
// and exact-text removes from the rail's Rules pane. THE-237.
//
// Adds use dedupeAndAppendAntiPatterns with source='manual' and the operator
// UUID, matching the cc-review path. Removes are exact-text matches —
// operators delete what they see (see remove-anti-pattern.ts for rationale).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PostBodySchema = z.object({
  // Trim outer whitespace per agreed convention; inner text stays as typed.
  ruleText: z.string().min(1).transform((s) => s.trim()),
})

const DeleteBodySchema = z.object({
  ruleText: z.string().min(1),
})

export const dynamic = 'force-dynamic'

async function auth(
  request: Request,
  venueId: string,
): Promise<
  | { ok: true; operatorId: string }
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
  if (!UUID_RE.test(venueId)) {
    return { ok: false, status: 400, body: { error: 'invalid venueId' } }
  }
  if (op.allowedVenueIds.length > 0 && !op.allowedVenueIds.includes(venueId)) {
    return { ok: false, status: 403, body: { error: 'venue not allowed' } }
  }
  return { ok: true, operatorId: op.operatorId }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  const { venueId } = await params
  const a = await auth(request, venueId)
  if (!a.ok) return NextResponse.json(a.body, { status: a.status })

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

  if (body.ruleText.length === 0) {
    return NextResponse.json(
      { error: 'ruleText is empty after trim' },
      { status: 400 },
    )
  }

  try {
    const result = await dedupeAndAppendAntiPatterns(venueId, [body.ruleText], {
      source: 'manual',
      authorOperatorId: a.operatorId,
    })
    return NextResponse.json({ success: true, added: result.added })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: 'rule add failed', detail: errMsg },
      { status: 500 },
    )
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  const { venueId } = await params
  const a = await auth(request, venueId)
  if (!a.ok) return NextResponse.json(a.body, { status: a.status })

  let body: z.infer<typeof DeleteBodySchema>
  try {
    const raw = await request.json()
    const parsed = DeleteBodySchema.safeParse(raw)
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

  const result = await removeAntiPattern(venueId, body.ruleText)
  if (!result.ok) {
    const status = result.errorCode === 'not_found' ? 404 : 500
    return NextResponse.json(
      { error: 'rule delete failed', detail: result.error, errorCode: result.errorCode },
      { status },
    )
  }
  return NextResponse.json({
    success: true,
    removed: true,
    remainingCount: result.remainingCount,
  })
}

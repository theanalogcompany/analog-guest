import { NextResponse } from 'next/server'
import { z } from 'zod'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { classifyCritique } from '@/lib/voices'

// POST /admin/voices/api/classify-critique — fires when the commit modal
// opens. Sonnet decides whether the critique is one-shot (edit_only) or
// a generalizable rule (edit_and_rule) and synthesizes a candidate rule
// text. Operator sees + can override both fields before commit fires.
//
// Not venue-scoped at the request boundary — the inputs are all free
// text, no DB lookups. A logged-in analog admin gate is sufficient.

const PostBodySchema = z.object({
  critique: z.string().min(1),
  badResponse: z.string().min(1),
  goodResponse: z.string().min(1),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  // Auth — analog admin scope only, no per-venue check needed.
  try {
    const supabase = await createServerClient()
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await verifyAnalogAdminAccess(session.user.id)
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: 'auth check failed' }, { status: 500 })
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

  const result = await classifyCritique(body)
  if (!result.ok) {
    return NextResponse.json(
      { error: 'classify failed', detail: result.error },
      { status: 502 },
    )
  }

  return NextResponse.json({
    success: true,
    kind: result.data.kind,
    ...(result.data.ruleText ? { ruleText: result.data.ruleText } : {}),
  })
}

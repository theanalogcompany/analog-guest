import { NextResponse } from 'next/server'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { fetchTrace } from '@/lib/observability'

// Server-only proxy for Langfuse trace fetches initiated from the browser.
// Reasons we don't expose Langfuse keys to the client:
//   1. The secret key is a write-capable credential — never ship it
//      browser-side.
//   2. Centralized point to enforce admin auth before any fetch goes out.
//
// Cookie-session auth (mirrors verify-analog-admin's session entry point).
// Returns 401 / 403 with a JSON body for client-side affordance; 200 with
// the trace JSON on success; 404 when the trace truly doesn't exist (or the
// wrapper is in no-op mode and returned null).

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ traceId: string }> },
): Promise<NextResponse> {
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

  const { traceId } = await params
  const trace = await fetchTrace(traceId)
  if (!trace) {
    return NextResponse.json({ error: 'trace not found' }, { status: 404 })
  }
  return NextResponse.json({ trace })
}

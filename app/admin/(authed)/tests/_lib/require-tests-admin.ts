// Cookie-session analog-admin gate for the route handlers under /admin/tests.
//
// The lib/auth require-* helpers are all resource-scoped (venue, corpus
// entry, ...); a test scenario and a golden-set run are fleet-global, and
// adding a fleet-level helper to lib/auth is hard-stop territory. So this
// composes the SAME gate the (authed) layout runs - devAuthBypass, then
// cookie session, then verifyAnalogAdminAccess - from lib/auth's existing
// exports, shaped like RequireAdminResult so the routes read like their
// siblings.
//
// Route handlers under the (authed) group do NOT inherit the layout's gate
// (layouts wrap pages, not routes) - every handler calls this itself. That
// includes the golden-set CSV export, which is a GET: a download link is
// still a route handler and still unauthenticated without this.
//
// Shared across every surface under tests/ rather than one copy per surface.
// `regression/_lib/require-regression-admin.ts` is the same gate and becomes
// a re-export of this one when the regression surface moves under tests/.

import { NextResponse } from 'next/server'
import { AuthError, devAuthBypass, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'

export type RequireTestsAdminResult =
  { ok: true; operatorId: string } | { ok: false; response: NextResponse }

export async function requireTestsAdmin(): Promise<RequireTestsAdminResult> {
  const bypass = await devAuthBypass()
  if (bypass) return { ok: true, operatorId: bypass.operatorId }

  try {
    const supabase = await createServerClient()
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
      }
    }
    const op = await verifyAnalogAdminAccess(session.user.id)
    return { ok: true, operatorId: op.operatorId }
  } catch (e) {
    if (e instanceof AuthError) {
      return {
        ok: false,
        response: NextResponse.json({ error: e.message }, { status: e.status }),
      }
    }
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'auth check failed' },
        { status: 500 },
      ),
    }
  }
}

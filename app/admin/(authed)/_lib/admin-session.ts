import { cache } from 'react'
import { AuthError, devAuthBypass, verifyAnalogAdminAccess } from '@/lib/auth'
import type { VenueScope } from '@/lib/auth/venue-scope'
import { createServerClient } from '@/lib/db/server'
import { mark } from './request-timing'

// The (authed) gate, resolved once per request.
//
// WHAT IT FIXES. The layout gates the route, then every page repeated the
// identical sequence - devAuthBypass, cookie session, verifyAnalogAdminAccess -
// because the layout confirms analog-admin status but not WHICH venues, and a
// page needs the scope. verifyAnalogAdminAccess is itself two queries (the
// operator row, then the venue allowlist), so each page load made six round
// trips where three would do. Nothing was memoized, so nothing noticed.
//
// cache() makes the second call free: the layout and the page render in one
// pass, so they share one execution. It does NOT cache across requests, which
// is what keeps this a deduplication rather than a weakening of the gate -
// every request still resolves the session and re-reads the admin flag.
//
// WHY IT LIVES HERE AND NOT IN lib/auth. Same reasoning as
// tests/_lib/require-tests-admin.ts, which composes this same gate for route
// handlers: a fleet-level helper inside lib/auth is hard-stop territory. This
// calls lib/auth's existing exports and changes no auth logic.
//
// A STATE, NOT A THROW. Callers disagree about what a failure means - the
// layout renders NotAuthorized in place while a page redirects to /admin - so
// this returns which state holds and lets each caller map it. Unexpected
// errors still propagate: a 403 is a decision, a failed operator lookup is a
// fault, and collapsing them would turn a database problem into a silent
// "not an admin".

export type AdminSession =
  | {
      kind: 'admin'
      email: string
      operatorId: string
      venueScope: VenueScope
      // The local-dev bypass stood in for a session. Carried so the shell can
      // keep saying so on screen.
      bypassed: boolean
    }
  | { kind: 'no-session' }
  | { kind: 'not-admin'; email: string }

export const resolveAdminSession = cache(async (): Promise<AdminSession> => {
  // Local-dev bypass (lib/auth/dev-bypass.ts): triple-guarded, null anywhere
  // but a developer's own `next dev` on localhost.
  const bypass = await devAuthBypass()
  if (bypass) {
    mark('auth')
    return {
      kind: 'admin',
      email: 'AUTH DISABLED - LOCAL DEV',
      operatorId: bypass.operatorId,
      venueScope: bypass.venueScope,
      bypassed: true,
    }
  }

  const supabase = await createServerClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) {
    mark('auth')
    return { kind: 'no-session' }
  }

  const email = session.user.email ?? '(unknown email)'
  try {
    const operator = await verifyAnalogAdminAccess(session.user.id)
    mark('auth')
    return {
      kind: 'admin',
      email,
      operatorId: operator.operatorId,
      venueScope: operator.venueScope,
      bypassed: false,
    }
  } catch (err) {
    mark('auth')
    if (err instanceof AuthError && err.status === 403) {
      return { kind: 'not-admin', email }
    }
    throw err
  }
})

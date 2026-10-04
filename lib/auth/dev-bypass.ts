// Local-development auth bypass. Owner-approved 2026-10-04 (explicit waiver
// of the lib/auth hard stop, for this change only): magic-link sign-in makes
// local admin testing impossible when the operator's inbox is not at hand,
// so an EXPLICIT opt-in can stand in for a session - on this machine only.
//
// The bypass activates only when ALL of these hold, checked in order:
//
//   1. ADMIN_AUTH_DISABLED=1 - set per shell session, NEVER stored in
//      .env.local (the standing rule: that file is operator-owned and this
//      flag must not survive the terminal that set it).
//   2. No Vercel marker in the environment. Any deployed environment refuses
//      outright, before weaker signals are even consulted.
//   3. NODE_ENV === 'development' - i.e. `next dev`. Vercel never runs
//      `next dev`, so this is defense in depth behind (2), not the defense.
//   4. The request's Host (and x-forwarded-host when present) is localhost.
//
// Failure direction: CLOSED. Any guard failing returns null and the caller
// falls through to the real cookie-session gate - the bypass can only ever
// widen access on a developer's own `next dev` process.
//
// The synthetic operator carries a sentinel operatorId (all zeros). Nothing
// in the playground writes it (runTurn is dry-run), but an admin WRITE route
// exercised under the bypass would stamp the sentinel where it stamps
// operatorId - visible, greppable, and honest about its origin.

import { headers } from 'next/headers'
import { ALL_VENUES } from './venue-scope'
import type { AnalogAdminOperator } from './verify-analog-admin'

export const DEV_BYPASS_OPERATOR_ID = '00000000-0000-0000-0000-000000000000'

// Checked as a family: Vercel sets all of these, but one is enough to refuse.
const VERCEL_MARKERS = [
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'NEXT_PUBLIC_VERCEL_ENV',
] as const

function isLocalhost(hostHeader: string | null): boolean {
  if (!hostHeader) return false
  const host = hostHeader.trim().toLowerCase()
  // Strip the port; bracketed IPv6 keeps its brackets.
  const bare = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0]
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '[::1]'
}

let warnedThisProcess = false

/**
 * The synthetic analog-admin principal, or null when any guard fails.
 * Callers treat null as "no bypass" and run the real gate; they never
 * branch on WHY it was null.
 */
export async function devAuthBypass(): Promise<AnalogAdminOperator | null> {
  if (process.env.ADMIN_AUTH_DISABLED !== '1') return null

  for (const marker of VERCEL_MARKERS) {
    const value = process.env[marker]
    if (value !== undefined && value !== '') {
      console.error(
        `[dev-bypass] ADMIN_AUTH_DISABLED=1 but ${marker} is set - this is a deployed environment; refusing the bypass`,
      )
      return null
    }
  }

  if (process.env.NODE_ENV !== 'development') return null

  const requestHeaders = await headers()
  if (!isLocalhost(requestHeaders.get('host'))) return null
  const forwardedHost = requestHeaders.get('x-forwarded-host')
  if (forwardedHost !== null && !isLocalhost(forwardedHost)) return null

  // Once per process; the persistent UI banner (DevAuthBanner) is the
  // per-request loudness.
  if (!warnedThisProcess) {
    warnedThisProcess = true
    console.warn(
      '[dev-bypass] AUTH DISABLED - LOCAL DEV. Every /admin request on this dev server is treated as a fleet-wide analog admin.',
    )
  }

  return {
    operatorId: DEV_BYPASS_OPERATOR_ID,
    venueScope: ALL_VENUES,
    isAnalogAdmin: true,
  }
}

import { redirect } from 'next/navigation'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { AuthError, devAuthBypass, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { type VenueScope } from '@/lib/auth/venue-scope'
import { loadVenues } from '../_lib/load-venues'
import { PlaygroundClient } from './playground-client'

// The v2 playground (phase 5 of the relationship-engine redesign,
// lib/relationship/CLAUDE.md): a debug chat against runTurn. Dry run by
// design - it reads prod data and calls real models but writes nothing, so
// an operator can poke at any venue's v2 behaviour before the per-venue
// flag ever flips.
//
// Session + allowlist resolve here rather than in the (authed) layout, which
// confirms analog-admin status but not WHICH venues - same split as
// intentions/page.tsx and venues/page.tsx. The venue list is the only
// server-loaded data; guests, timelines and runs go through
// /admin/playground/api/* so the chat survives every selection change.

export const dynamic = 'force-dynamic'

export default async function PlaygroundPage() {
  let venueScope: VenueScope
  // Local-dev bypass (lib/auth/dev-bypass.ts): triple-guarded, null anywhere
  // but a developer's own `next dev` on localhost.
  const bypass = await devAuthBypass()
  if (bypass) {
    venueScope = bypass.venueScope
  } else {
    const supabase = await createServerClient()
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) redirect('/admin/sign-in')

    try {
      const op = await verifyAnalogAdminAccess(session.user.id)
      venueScope = op.venueScope
    } catch (e) {
      if (e instanceof AuthError && e.status === 403) redirect('/admin')
      throw e
    }
  }

  const venues = await loadVenues(venueScope)

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        eyebrow={<Eyebrow>Command Center</Eyebrow>}
        title="Playground"
        subtitle="v2 relationship engine · dry run · reads prod, writes nothing"
      />
      <PlaygroundClient venues={venues} />
    </div>
  )
}

import { redirect } from 'next/navigation'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { AuthError, devAuthBypass, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { type VenueScope } from '@/lib/auth/venue-scope'
import { loadVenues } from '../_lib/load-venues'
import { PlaygroundClient } from './playground-client'

// The playground (phase 5 of the relationship-engine redesign,
// lib/relationship/CLAUDE.md): a debug chat that runs v1 and v2 on the same
// inbound, concurrently, and renders the two replies side by side - so the
// question "does v2 regress against v1" is answerable before the per-venue
// flag ever flips.
//
// NOTHING IS SENT on either arm. It is not, however, write-free, and the
// distinction is worth stating where someone reads it: v1 builds its context
// from the database (buildRuntimeContext), so the sandbox arm materializes
// its transcript against a per-venue synthetic guest. See
// api/run/v1-arm.ts for the scope of those writes and why they are not a
// hand-built context instead.
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
        subtitle="v1 vs v2 · dry run · real models, nothing sent"
      />
      <PlaygroundClient venues={venues} />
    </div>
  )
}

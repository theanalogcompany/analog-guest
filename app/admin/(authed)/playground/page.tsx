import { redirect } from 'next/navigation'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { resolveAdminSession } from '../_lib/admin-session'
import { loadVenues } from '../_lib/load-venues'
import { mark, reportRequestTiming } from '../_lib/request-timing'
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
// The allowlist comes from _lib/admin-session.ts, already resolved for this
// request by the (authed) layout, which confirms analog-admin status but not
// WHICH venues. The venue list is the only server-loaded data; guests,
// timelines and runs go through /admin/playground/api/* so the chat survives
// every selection change.

export const dynamic = 'force-dynamic'

export default async function PlaygroundPage() {
  const session = await resolveAdminSession()
  if (session.kind === 'no-session') redirect('/admin/sign-in')
  if (session.kind === 'not-admin') redirect('/admin')

  const venues = await loadVenues(session.venueScope)
  mark('venues')

  reportRequestTiming('/admin/playground')

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

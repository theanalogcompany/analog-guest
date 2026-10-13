import { redirect } from 'next/navigation'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { AuthError, devAuthBypass, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { type VenueScope } from '@/lib/auth/venue-scope'
import { loadVenues } from '../_lib/load-venues'
import { EMPTY_STORED_V1, loadStoredV1 } from './_lib/load-stored-v1'
import { PromptLabClient } from './prompt-lab-client'

// The prompt lab: one prompt under edit, the whole golden set beside it.
//
// WHY IT IS NOT THE PLAYGROUND. The playground answers "what does v2 say to
// this guest, in this conversation" - one thread, a rolling session, v1 as an
// optional second arm. This answers the other question: "does the prompt I am
// editing hold up across every scenario we care about". The unit of work is
// the PROMPT, run against 67 fixed single-turn scenarios, which is why the
// questions are built in and the conversation is not editable.
//
// v1 IS READ, NEVER CALLED. The column comes out of `golden_runs` -
// `_lib/load-stored-v1.ts` says what that costs and the page renders it. A
// live v1 arm per question would double a 62-generation sweep to re-derive
// answers already on disk, and v1 moves slowly enough that the stored one is
// the useful one. v2 is a real live call every time.
//
// Session + allowlist resolve here rather than in the (authed) layout - same
// split as playground/page.tsx, which confirms analog-admin status but not
// WHICH venues.
//
// The venue comes from `?venue=` rather than client state because the stored
// v1 column is server-loaded per venue: a client-side venue switch would leave
// a v1 column belonging to a different venue on screen beside v2 answers from
// the new one.

export const dynamic = 'force-dynamic'

export default async function PromptLabPage({
  searchParams,
}: {
  searchParams: Promise<{ venue?: string }>
}) {
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
  const requested = (await searchParams).venue ?? null
  // Scoped against the loaded list rather than trusted: `?venue=` is a URL
  // parameter, and `loadVenues` is what applied the allowlist.
  const venueId =
    requested !== null && venues.some((v) => v.venueId === requested)
      ? requested
      : (venues[0]?.venueId ?? null)

  const storedV1 =
    venueId === null ? EMPTY_STORED_V1 : await loadStoredV1(venueId)

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        eyebrow={<Eyebrow>Command Center</Eyebrow>}
        title="Prompt lab"
        subtitle="one prompt · the golden set · v2 live against stored v1"
      />
      <PromptLabClient venues={venues} venueId={venueId} storedV1={storedV1} />
    </div>
  )
}

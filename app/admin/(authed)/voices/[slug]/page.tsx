import { notFound, redirect } from 'next/navigation'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { VoicesClient } from './voices-client'
import { loadVoicePage } from './_lib/load-voice-page'

// THE-237 (PR-B): per-voice workbench. Server orchestrator pulls everything
// the client needs in one round trip — venue, persona, corpus, threads,
// optionally a selected guest's full bubble thread.
//
// Data freshness pattern for mutations:
//   1. Client-side handler `await fetch(/admin/voices/api/.../...)`
//   2. On success: `router.refresh()` from `next/navigation`
//   3. App Router re-runs this server component — `loadVoicePage` runs
//      again, fresh persona/corpus/threads land in props
//   4. The (authed) layout above also re-runs, so the sidebar voice list
//      picks up any voiceName change in the same refresh
//   5. React reconciles — child components receive new props
//
// No router.refresh() needed for the threads-list realtime feed; that
// subscription lives in voices-client and updates incrementally on
// inbound/outbound message inserts.
//
// Allowlist enforcement: layout has already verified analog admin and
// resolved allowedVenueIds. We re-check here against the loaded venue's
// id since `[slug]` is operator-supplied.

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ guest?: string }>
}

export default async function VoicePage({ params, searchParams }: PageProps) {
  const { slug } = await params
  const { guest } = await searchParams

  const supabase = await createServerClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) redirect('/admin/sign-in')

  let allowedVenueIds: string[]
  try {
    const op = await verifyAnalogAdminAccess(session.user.id)
    allowedVenueIds = op.allowedVenueIds
  } catch (e) {
    if (e instanceof AuthError && e.status === 403) redirect('/admin')
    throw e
  }

  const data = await loadVoicePage({ slug, selectedGuestId: guest ?? null })
  if (!data) notFound()

  if (
    allowedVenueIds.length > 0 &&
    !allowedVenueIds.includes(data.venue.id)
  ) {
    notFound()
  }

  return (
    // -mx-8 -my-10 cancels admin-shell's default px-8 py-10 padding so the
    // workbench renders edge-to-edge inside <main>'s box, matching the
    // mockup. Same pattern the conversations viewer uses.
    <div className="-mx-8 -my-10 h-[calc(100dvh-3.5rem)]">
      <VoicesClient
        key={`${data.venue.id}:${data.selectedGuest?.id ?? 'none'}`}
        data={data}
      />
    </div>
  )
}

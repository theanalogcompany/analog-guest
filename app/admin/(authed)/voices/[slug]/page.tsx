import { notFound, redirect } from 'next/navigation'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { VoicesClient } from './voices-client'
import { loadVoicePage } from './_lib/load-voice-page'

// Per-voice workbench. Server orchestrator pulls everything
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
    // Full-bleed wrapper: `position: fixed` escapes the admin shell's
    // `<main>` max-w-5xl container so the 280/1fr/400 workbench can use
    // the full viewport width. `left` tracks the shadcn Sidebar's expanded
    // width via the inherited `--sidebar-width` var (set by SidebarProvider,
    // 16rem) — the TAC-306 shell reskin replaced the old fixed `w-56` nav, so
    // a hardcoded `left-56` (14rem) clipped this content under the wider
    // sidebar. `top-14` still mirrors the topbar's `h-14`. Known minor:
    // collapsing the sidebar (⌘B) leaves harmless paper whitespace on the
    // left here since `--sidebar-width` doesn't shrink to the icon width — a
    // collapse-aware fix would need useSidebar() inside the client tree.
    <div className="fixed left-[var(--sidebar-width)] top-14 right-0 bottom-0 bg-paper">
      <VoicesClient
        key={`${data.venue.id}:${data.selectedGuest?.id ?? 'none'}`}
        data={data}
      />
    </div>
  )
}

import { redirect } from 'next/navigation'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { AdminShell } from '../_components/admin-shell'
import { NotAuthorized } from '../_components/not-authorized'
import { loadVoices } from './_lib/load-voices'

// Auth gate for the protected admin tree. Lives under a (authed) route
// group so /admin/sign-in and /admin/auth/callback (siblings outside this
// group) bypass it without redirect loops.
//
// Three states:
//   - no session              → redirect to /admin/sign-in
//   - session, not analog admin → render <NotAuthorized> in place
//   - session + analog admin  → render <AdminShell>{children}</AdminShell>
//
// Authenticated-but-not-authorized renders rather than redirects: the user
// has identity, just not authorization. Sending them back to sign-in
// would muddle the failure state.
//
// THE-237: voices for the sidebar voice-list group are loaded here once
// per RSC render. Mutations on `/admin/voices/[slug]` call router.refresh()
// to re-render the layout — which re-runs this loader and gives the
// sidebar fresh data without a full reload. (Same propagation pattern
// for topbar tab counts and Last-refined; those live on the per-voice
// page, also server-rendered, also re-fetched on router.refresh.)

export default async function AuthedAdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createServerClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session) {
    redirect('/admin/sign-in')
  }

  let allowedVenueIds: string[]
  try {
    const op = await verifyAnalogAdminAccess(session.user.id)
    allowedVenueIds = op.allowedVenueIds
  } catch (err) {
    if (err instanceof AuthError && err.status === 403) {
      return <NotAuthorized email={session.user.email ?? '(unknown email)'} />
    }
    throw err
  }

  const voices = await loadVoices(allowedVenueIds)

  return (
    <AdminShell email={session.user.email ?? '(unknown email)'} voices={voices}>
      {children}
    </AdminShell>
  )
}

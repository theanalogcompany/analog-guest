import { redirect } from 'next/navigation'
import { AdminShell } from '../_components/admin-shell'
import { DevAuthBanner } from '../_components/dev-auth-banner'
import { NotAuthorized } from '../_components/not-authorized'
import { resolveAdminSession } from './_lib/admin-session'

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
// The gate itself is _lib/admin-session.ts, resolved once per request and
// shared with the pages below - which need the venue scope this confirms, and
// used to re-derive it with a second copy of the same three round trips.

export default async function AuthedAdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await resolveAdminSession()

  if (session.kind === 'no-session') {
    redirect('/admin/sign-in')
  }
  if (session.kind === 'not-admin') {
    return <NotAuthorized email={session.email} />
  }

  return (
    <AdminShell email={session.email}>
      {session.bypassed ? <DevAuthBanner /> : null}
      {children}
    </AdminShell>
  )
}

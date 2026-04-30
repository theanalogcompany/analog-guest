import { redirect } from 'next/navigation'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { AdminShell } from '../_components/admin-shell'
import { NotAuthorized } from '../_components/not-authorized'

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

  try {
    await verifyAnalogAdminAccess(session.user.id)
  } catch (err) {
    if (err instanceof AuthError && err.status === 403) {
      return <NotAuthorized email={session.user.email ?? '(unknown email)'} />
    }
    throw err
  }

  return (
    <AdminShell email={session.user.email ?? '(unknown email)'}>
      {children}
    </AdminShell>
  )
}

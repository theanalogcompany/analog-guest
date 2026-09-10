import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { loadVenues } from '../_lib/load-venues'

// TAC-343 Stage A: /admin/venues list page. Read-only. Mirrors
// voices/page.tsx's structure — session + allowlist resolved here (the
// (authed) layout only confirms analog-admin status, not which venues are
// allowed), loader does the allowlist-scoped query.

export const dynamic = 'force-dynamic'

export default async function VenuesIndexPage() {
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

  const venues = await loadVenues(allowedVenueIds)

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        eyebrow={<Eyebrow>Command Center</Eyebrow>}
        title="Venues"
        subtitle={
          venues.length === 0
            ? 'No venues yet.'
            : `${venues.length} venue${venues.length === 1 ? '' : 's'}`
        }
      />

      {venues.length === 0 ? (
        <p className="text-sm text-ink-soft max-w-md">No venues yet.</p>
      ) : (
        <ul className="flex flex-col">
          {venues.map((v) => (
            <li key={v.slug}>
              <Link
                href={`/admin/venues/${v.slug}`}
                className="flex items-baseline justify-between py-4 border-b border-stone-light/60 hover:bg-highlight transition-colors group"
              >
                <span className="font-fraunces font-fraunces-display italic text-2xl text-ink leading-none">
                  {v.name}
                </span>
                <span className="text-xs text-ink-faint group-hover:text-clay transition-colors">
                  {v.timezone}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

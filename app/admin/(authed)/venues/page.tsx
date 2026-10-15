import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { resolveAdminSession } from '../_lib/admin-session'
import { loadVenues } from '../_lib/load-venues'
import { mark, reportRequestTiming } from '../_lib/request-timing'

// TAC-343 Stage A: /admin/venues list page. Read-only. Mirrors
// voices/page.tsx's structure — the allowlist comes from the gate the
// (authed) layout already resolved for this request (it confirms
// analog-admin status, not which venues are allowed), loader does the
// allowlist-scoped query.

export const dynamic = 'force-dynamic'

export default async function VenuesIndexPage() {
  const session = await resolveAdminSession()
  if (session.kind === 'no-session') redirect('/admin/sign-in')
  if (session.kind === 'not-admin') redirect('/admin')

  const venues = await loadVenues(session.venueScope)
  mark('venues')

  reportRequestTiming('/admin/venues')

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

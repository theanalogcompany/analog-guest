import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { loadVoices } from '../_lib/load-voices'

// THE-237: Voices list page. Header + alphabetical list of voices.
// `loadVoices` is shared with the layout; both call it independently and
// don't depend on each other beyond the cookie-session auth resolved here.

export const dynamic = 'force-dynamic'

export default async function VoicesIndexPage() {
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

  const voices = await loadVoices(allowedVenueIds)

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        eyebrow={<Eyebrow>Command Center</Eyebrow>}
        title="Voices"
        subtitle={
          voices.length === 0
            ? 'No voices yet.'
            : `${voices.length} voice${voices.length === 1 ? '' : 's'}`
        }
      />

      {voices.length === 0 ? (
        <p className="text-sm text-ink-soft max-w-md">
          No voices yet. Voices materialize when a venue&apos;s persona has at
          least a <span className="font-mono text-xs">voiceName</span> set or
          any anti-pattern present.
        </p>
      ) : (
        <ul className="flex flex-col">
          {voices.map((v) => (
            <li key={v.slug}>
              <Link
                href={`/admin/voices/${v.slug}`}
                className="flex items-baseline justify-between py-4 border-b border-stone-light/60 hover:bg-highlight transition-colors group"
              >
                <span className="flex items-baseline gap-3">
                  <span
                    className="font-fraunces italic text-2xl text-ink leading-none"
                    style={{ fontVariationSettings: 'var(--fraunces)' }}
                  >
                    {v.displayLabel}
                  </span>
                  {v.fallbackToVenueName && (
                    <Eyebrow>unnamed · venue fallback</Eyebrow>
                  )}
                </span>
                <span className="text-xs text-ink-faint group-hover:text-clay transition-colors">
                  {v.fallbackToVenueName ? '' : `${v.venueName} · `}open
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

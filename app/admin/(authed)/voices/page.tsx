import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { loadVoices } from '../_lib/load-voices'

// Voices list page. Header + alphabetical list of voices.
//
// Wraps in a full-bleed fixed-position shell so the page escapes admin-
// shell's max-w-5xl container, matching the per-voice workbench.
// Inner content stays at `max-w-5xl mx-auto` for row readability — full-
// bleed gives the future surface (filters, side panels) room to spread,
// while today's list rows stay comfortably narrow.

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
    // Full-bleed fixed wrapper escapes admin-shell's max-w-5xl. Coords
    // mirror the sidebar (`w-56`) and topbar (`h-14`); coupling tracked
    // alongside the per-voice workbench follow-up.
    <div className="fixed left-56 top-14 right-0 bottom-0 bg-paper overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-10 flex flex-col gap-8">
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
            No voices yet. Voices materialize when a venue&apos;s persona has
            at least a <span className="font-mono text-xs">voiceName</span> set
            or any anti-pattern present.
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
                    <span className="font-fraunces font-fraunces-display italic text-2xl text-ink leading-none">
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
    </div>
  )
}

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { resolveAdminSession } from '../_lib/admin-session'
import { loadVoices } from '../_lib/load-voices'
import { mark, reportRequestTiming } from '../_lib/request-timing'

// Voices list page. Header + alphabetical list of voices.
//
// Wraps in a full-bleed fixed-position shell so the page escapes admin-
// shell's max-w-5xl container, matching the per-voice workbench.
// Inner content stays at `max-w-5xl mx-auto` for row readability — full-
// bleed gives the future surface (filters, side panels) room to spread,
// while today's list rows stay comfortably narrow.

export const dynamic = 'force-dynamic'

export default async function VoicesIndexPage() {
  const session = await resolveAdminSession()
  if (session.kind === 'no-session') redirect('/admin/sign-in')
  if (session.kind === 'not-admin') redirect('/admin')

  const voices = await loadVoices(session.venueScope)
  mark('voices')

  reportRequestTiming('/admin/voices')

  return (
    // Full-bleed fixed wrapper escapes admin-shell's max-w-5xl. `left` tracks
    // the shadcn Sidebar's expanded width via the inherited `--sidebar-width`
    // var (TAC-306 shell reskin — the old `left-56` mirrored the prior fixed
    // `w-56` nav and now clips under the wider sidebar). `top-14` mirrors the
    // topbar's `h-14`.
    <div className="fixed left-[var(--sidebar-width)] top-14 right-0 bottom-0 bg-paper overflow-y-auto">
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

import Link from 'next/link'
import { SectionShell } from './section-shell'

// Link-out only. This page must never write brand_persona or voice_corpus —
// /admin/voices/[slug] already owns those with its own API routes and its
// own edit surface. Per §2: "Voice links out."
export function VoiceLinkSection({ slug }: { slug: string }) {
  return (
    <SectionShell title="Voice" subtitle="persona, voice corpus">
      <p className="text-sm text-ink-soft">
        Persona and voice corpus are edited on the Voices surface, not here.
      </p>
      <Link
        href={`/admin/voices/${slug}`}
        className="mt-2 inline-block text-sm text-clay underline underline-offset-2 hover:text-ink"
      >
        Open {slug} in Voices →
      </Link>
    </SectionShell>
  )
}

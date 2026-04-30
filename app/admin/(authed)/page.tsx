import { Eyebrow, SectionHeader } from '@/lib/ui'

// /admin landing. Direct register: name what this is, point at the next
// thing the operator might want. No marketing copy, no welcome banner.

export default function AdminLandingPage() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow>Overview</Eyebrow>
        <SectionHeader
          title="Command Center"
          subtitle="Internal admin surface for the analog operator network."
        />
      </div>

      <div className="text-sm text-ink-soft max-w-prose leading-relaxed">
        Surfaces will land here as they ship: conversation viewer, guest
        detail, venue config, operator onboarding. For now: check Health to
        confirm the underlying systems are reachable.
      </div>
    </div>
  )
}

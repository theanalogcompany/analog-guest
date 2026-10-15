import { Eyebrow, SectionHeader } from '@/lib/ui'
import { resolveAdminSession } from './_lib/admin-session'
import { reportRequestTiming } from './_lib/request-timing'

// /admin landing. Direct register: name what this is, point at the next
// thing the operator might want. No marketing copy, no welcome banner.
//
// It loads nothing, which is exactly why it is worth timing: its server time
// IS the gate plus cold start, with no page work mixed in, so it is the floor
// every other admin page pays. Awaiting the session is what makes that true -
// the layout and a page render concurrently, so reporting without awaiting
// would log a breakdown taken before the gate had finished.

export default async function AdminLandingPage() {
  await resolveAdminSession()
  reportRequestTiming('/admin')

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
        Surfaces will land here as they ship: conversation viewer, guest detail,
        venue config, operator onboarding. For now: check Health to confirm the
        underlying systems are reachable.
      </div>
    </div>
  )
}

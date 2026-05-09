import { Card, Eyebrow, SectionHeader } from '@/lib/ui'
import { TUNABLES } from '@/lib/tunables/manifest'
import { TunablesTable } from './_components/tunables-table'

// Read-only viewer for the tunables manifest (TAC-183). Auth is gated by the
// (authed) layout — no per-route auth code here. The manifest is a static
// import; no DB calls, no Langfuse, no Supabase. Filter + search state lives
// in the URL via the client component.

export const dynamic = 'force-static'

export default function TunablesPage() {
  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        eyebrow={<Eyebrow>Command Center</Eyebrow>}
        title="Tunables"
        subtitle={`${TUNABLES.length} operational levers · read-only`}
      />
      <Card>
        <TunablesTable tunables={[...TUNABLES]} />
      </Card>
    </div>
  )
}

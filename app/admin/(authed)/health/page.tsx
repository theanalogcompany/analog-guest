import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import { Eyebrow, HairlineRow, SectionHeader, StatusDot } from '@/lib/ui'
import { checkLangfuse } from './check-langfuse'

// /admin/health — three-row status panel. Server component; runs all
// checks at request time. Direct register throughout.
//
// Rows:
//   1. DB connectivity:  `select 1` via admin client.
//   2. Langfuse:         four-state env-presence + host check. See
//                        check-langfuse.ts for state semantics.
//   3. Current admin:    signed-in operator's email + admin status.
//                        Implicit sanity-check on the auth chain — if you
//                        see your email here, the cookie session resolved
//                        all the way through the gate.

interface CheckRow {
  label: string
  detail: string
  tone: 'good' | 'neutral' | 'bad'
}

async function checkDatabase(): Promise<CheckRow> {
  try {
    const supabase = createAdminClient()
    const { error } = await supabase.from('venues').select('id').limit(1)
    if (error) {
      return { label: 'Database', detail: error.message, tone: 'bad' }
    }
    return { label: 'Database', detail: 'Reachable', tone: 'good' }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { label: 'Database', detail: message, tone: 'bad' }
  }
}

async function checkCurrentAdmin(): Promise<CheckRow> {
  const supabase = await createServerClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const email = session?.user.email ?? '(unknown email)'
  return {
    label: 'Signed in as',
    detail: email,
    tone: 'good',
  }
}

export default async function HealthPage() {
  const rows: CheckRow[] = [
    await checkDatabase(),
    checkLangfuse(),
    await checkCurrentAdmin(),
  ]

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow>System</Eyebrow>
        <SectionHeader
          title="Health"
          subtitle="Real-time status of the systems the admin surface depends on."
        />
      </div>

      <div className="flex flex-col">
        {rows.map((row, i) => (
          <HairlineRow key={row.label} last={i === rows.length - 1}>
            <div className="flex items-center gap-4">
              <StatusDot tone={row.tone} label={row.tone} />
              <div className="flex-1 flex items-baseline justify-between gap-4">
                <span className="text-sm text-ink">{row.label}</span>
                <span className="text-sm text-ink-soft">{row.detail}</span>
              </div>
            </div>
          </HairlineRow>
        ))}
      </div>
    </div>
  )
}

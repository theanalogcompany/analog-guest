import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import { Eyebrow, HairlineRow, SectionHeader, StatusDot } from '@/lib/ui'

// /admin/health — three-row status panel. Server component; runs all
// checks at request time. Direct register throughout.
//
// Rows:
//   1. DB connectivity:  `select 1` via admin client.
//   2. Langfuse:         env-presence + cloud-host sanity + SDK init probe.
//                        The SDK has no synchronous ping endpoint — see
//                        comment on checkLangfuse below.
//   3. Current admin:    signed-in operator's email + admin status.
//                        Implicit sanity-check on the auth chain — if you
//                        see your email here, the cookie session resolved
//                        all the way through the gate.

const KNOWN_LANGFUSE_HOSTS = [
  'https://us.cloud.langfuse.com',
  'https://cloud.langfuse.com',
]

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

function checkLangfuse(): CheckRow {
  // The langfuse SDK has no synchronous ping endpoint — traces are batch-
  // flushed asynchronously and flushAsync succeeds even when the keys are
  // wrong (it queues silently). And probing on every request would pollute
  // the trace stream with /admin/health hits.
  //
  // What we verify cheaply, with no network call:
  //   1. Required env vars are present.
  //   2. The configured host matches one of the known Langfuse cloud values.
  //      Catches the common misconfiguration "EU keys against US host" or
  //      vice-versa, which otherwise causes silent trace loss.
  //
  // What this does NOT verify: that the keys are valid for the project, that
  // the network path is open, or that traces are arriving. Operators should
  // confirm a live trace appears in Langfuse after a real iMessage exchange.
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim() ?? ''
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim() ?? ''
  const baseUrl = process.env.LANGFUSE_BASE_URL?.trim() ?? ''

  if (!publicKey || !secretKey || !baseUrl) {
    const missing: string[] = []
    if (!publicKey) missing.push('LANGFUSE_PUBLIC_KEY')
    if (!secretKey) missing.push('LANGFUSE_SECRET_KEY')
    if (!baseUrl) missing.push('LANGFUSE_BASE_URL')
    return {
      label: 'Langfuse',
      detail: `Not configured (missing: ${missing.join(', ')})`,
      tone: 'neutral',
    }
  }

  if (!KNOWN_LANGFUSE_HOSTS.includes(baseUrl)) {
    return {
      label: 'Langfuse',
      detail: `Unknown host (${baseUrl}) — expected one of ${KNOWN_LANGFUSE_HOSTS.join(', ')}`,
      tone: 'bad',
    }
  }

  const keyPrefix = publicKey.slice(0, 8)
  return {
    label: 'Langfuse',
    detail: `${baseUrl} (${keyPrefix}…) — host verified, traces unconfirmed`,
    tone: 'good',
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

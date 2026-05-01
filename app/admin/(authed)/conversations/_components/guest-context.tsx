import { differenceInCalendarDays } from 'date-fns'
import { formatInTimeZone } from 'date-fns-tz'
import { Card, Eyebrow, StatePill } from '@/lib/ui'
import type { GuestState } from '@/lib/recognition'

// Compact guest context. Densified for the 240px context-row slot. Pulls
// from latest guest_states + lightweight rollups + the loaded conversation
// messages (for response rate). NOT a live recognition recompute.
//
// Color discipline (PR-3 lesson): inline `style` for any state-dependent
// color. StatePill encapsulates its own color logic — don't pass tokens
// through. Default text color inherits ink from body; only muted labels
// override.

interface GuestContextProps {
  guest: {
    id: string
    firstName: string | null
    lastName: string | null
    phoneNumber: string
    distanceMiles: number | null
    createdVia: string
  }
  state: GuestState | null
  /** From guests.last_visit_at (matched-transaction or operator-edited). Null when guest has zero visits. */
  lastVisitAt: Date | null
  /** Earliest signal we have on this guest at this venue (min message or transaction). */
  sinceAt: Date | null
  visitCountLast90Days: number
  spendCents90d: number
  /** Total spend / visit count in cents. Null when visits = 0. */
  avgPerVisitCents: number | null
  /** All-time message count for this venue+guest pair. */
  totalMessageCount: number
  /** 0–100. Computed from the loaded conversation; window documented in compute-message-stats.ts. */
  responseRatePct: number
  venueTimezone: string
}

export function GuestContext({
  guest,
  state,
  lastVisitAt,
  sinceAt,
  visitCountLast90Days,
  spendCents90d,
  avgPerVisitCents,
  totalMessageCount,
  responseRatePct,
  venueTimezone,
}: GuestContextProps) {
  const fullName = [guest.firstName, guest.lastName].filter(Boolean).join(' ') || '(unnamed)'
  const formattedPhone = formatPhone(guest.phoneNumber)
  const sinceLabel = sinceAt ? formatInTimeZone(sinceAt, venueTimezone, 'MMM d') : null

  const lastVisitLabel = lastVisitAt
    ? formatRelativeVisit(lastVisitAt, venueTimezone, new Date())
    : null

  const spendLabel =
    visitCountLast90Days > 0 && avgPerVisitCents !== null
      ? `${formatDollars(spendCents90d)} · avg ${formatDollars(avgPerVisitCents)}`
      : formatDollars(spendCents90d)

  const messagesLabel = `${totalMessageCount} · ${responseRatePct}% response rate`

  return (
    <Card variant="trace" className="h-full overflow-y-auto p-4 flex flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <Eyebrow>Guest</Eyebrow>
        {state ? <StatePill state={state} /> : null}
      </header>

      <div className="flex flex-col gap-1">
        <h3
          className="font-fraunces text-xl text-ink leading-tight italic"
          style={{ fontVariationSettings: 'var(--fraunces-text)' }}
        >
          {fullName}
        </h3>
        <div className="flex items-center gap-2 text-xs text-ink-soft">
          <span className="tabular-nums">{formattedPhone}</span>
          {sinceLabel ? (
            <>
              <span aria-hidden>·</span>
              <span>since {sinceLabel}</span>
            </>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1.5 text-sm">
        <Label>Last visit</Label>
        <Value>{lastVisitLabel ?? <Empty />}</Value>

        <Label>Visits 90d</Label>
        <Value>{visitCountLast90Days}</Value>

        <Label>Spend 90d</Label>
        <Value>{spendLabel}</Value>

        <Label>Messages</Label>
        <Value>{messagesLabel}</Value>
      </dl>
    </Card>
  )
}

// ---------------------------------------------------------------------------

function Label({ children }: { children: React.ReactNode }) {
  return (
    <dt className="text-ink-faint" style={{ fontWeight: 500 }}>
      {children}
    </dt>
  )
}

function Value({ children }: { children: React.ReactNode }) {
  return <dd className="text-ink min-w-0 break-words tabular-nums">{children}</dd>
}

function Empty() {
  return (
    <span className="text-ink-faint" style={{ fontStyle: 'italic' }}>
      —
    </span>
  )
}

// "yesterday · 8:15 am" / "today · 8:15 am" / "Mon · 8:15 am" (within last week) /
// "Mar 8 · 8:15 am" (older). Calendar-day diff uses the venue's local timezone
// so "today" matches the operator's intuition for a venue on a different
// timezone than the operator's browser.
function formatRelativeVisit(date: Date, tz: string, now: Date): string {
  const time = formatInTimeZone(date, tz, 'h:mm a').toLowerCase()
  // Calendar-day diff in venue tz: format both dates as YYYY-MM-DD in venue
  // tz, then compute the day delta from those wall-clock days.
  const dateLocal = formatInTimeZone(date, tz, 'yyyy-MM-dd')
  const nowLocal = formatInTimeZone(now, tz, 'yyyy-MM-dd')
  const days = differenceInCalendarDays(new Date(`${nowLocal}T00:00:00Z`), new Date(`${dateLocal}T00:00:00Z`))
  if (days === 0) return `today · ${time}`
  if (days === 1) return `yesterday · ${time}`
  if (days >= 2 && days <= 6) {
    return `${formatInTimeZone(date, tz, 'EEE')} · ${time}`
  }
  return `${formatInTimeZone(date, tz, 'MMM d')} · ${time}`
}

// "+17869530853" → "+1 786 953 0853" for legibility. Falls back to the raw
// string when the format doesn't match (international numbers etc).
function formatPhone(phone: string): string {
  const m = phone.match(/^\+1(\d{3})(\d{3})(\d{4})$/)
  if (!m) return phone
  return `+1 ${m[1]} ${m[2]} ${m[3]}`
}

function formatDollars(cents: number): string {
  const dollars = cents / 100
  return `$${dollars.toFixed(2)}`
}

import { Card, Eyebrow, StatusDot } from '@/lib/ui'
import type { BrandPersona, VenueInfo } from '@/lib/schemas'

// Compact venue context. Densified for the 240px context-row slot. Shows the
// fields most useful for debugging an active conversation: today's hours,
// timezone, persona tone, mechanic counts. Editing lives in THE-203.
//
// Color discipline (PR-3 lesson): inline `style` for any state-dependent
// color. No `hover:text-{token}` without a base color. Default text color
// inherits ink from body; only muted labels override.

interface VenueContextProps {
  venue: {
    id: string
    slug: string
    name: string
    timezone: string
    messagingPhone: string
    status: string
    isTest: boolean
  }
  persona: BrandPersona
  venueInfo: VenueInfo
  mechanics: Array<{
    id: string
    name: string
    minState: string
    redemptionPolicy: string
    redemptionWindowDays: number | null
  }>
  todayLocalIso: string  // venue-local YYYY-MM-DD computed server-side
}

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
// Short three-letter day labels for the "Hours · Fri" header line. Matches
// the mockup's compact form.
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

const STATUS_TONE: Record<string, 'good' | 'neutral' | 'bad'> = {
  active: 'good',
  pending: 'neutral',
  inactive: 'bad',
}

export function VenueContext({
  venue,
  persona,
  venueInfo,
  mechanics,
  todayLocalIso,
}: VenueContextProps) {
  const dayIndex = new Date(`${todayLocalIso}T12:00:00`).getDay()
  const todayDayKey = DAY_KEYS[dayIndex]
  const todayShort = DAY_SHORT[dayIndex]
  const todayHours = venueInfo.hours[todayDayKey] ?? 'Not set'
  const phoneTail = venue.messagingPhone.slice(-4)
  const tone = firstSentenceOrPhrase(persona.tone)

  const activeMechanicCount = mechanics.length
  const gatedMechanicCount = mechanics.filter((m) => m.minState !== 'new').length
  const mechanicsLabel =
    activeMechanicCount === 0
      ? 'none active'
      : gatedMechanicCount > 0
        ? `${activeMechanicCount} active · ${gatedMechanicCount} regulars-only`
        : `${activeMechanicCount} active`

  const statusTone = STATUS_TONE[venue.status] ?? 'neutral'

  return (
    <Card variant="trace" className="h-full overflow-y-auto p-4 flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <Eyebrow>Venue</Eyebrow>
        {phoneTail ? (
          <span className="text-xs text-ink-soft tabular-nums">···{phoneTail}</span>
        ) : null}
      </header>

      <div className="flex flex-col gap-1">
        <h3
          className="font-fraunces text-xl text-ink leading-tight italic"
          style={{ fontVariationSettings: 'var(--fraunces-text)' }}
        >
          {venue.name}
        </h3>
        <div className="flex items-center gap-2 text-xs text-ink-soft">
          <span>{venue.slug}</span>
          <span aria-hidden>·</span>
          <span className="flex items-center gap-1.5">
            <StatusDot tone={statusTone} label={`status: ${venue.status}`} />
            <span>{venue.status}</span>
          </span>
          {venue.isTest ? (
            <>
              <span aria-hidden>·</span>
              <span className="italic">is_test</span>
            </>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1.5 text-sm">
        <Label>{`Hours · ${todayShort}`}</Label>
        <Value>{todayHours}</Value>

        <Label>Timezone</Label>
        <Value>{venue.timezone}</Value>

        <Label>Tone</Label>
        <Value>
          <span className="italic text-ink-soft">{tone}</span>
        </Value>

        <Label>Mechanics</Label>
        <Value>{mechanicsLabel}</Value>
      </dl>
    </Card>
  )
}

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

// Trim a free-form persona tone string to its first sentence (or first ~80
// chars if no period). Avoids the card growing taller when a venue has a
// multi-paragraph tone description.
function firstSentenceOrPhrase(s: string): string {
  if (!s) return ''
  const periodIdx = s.indexOf('.')
  if (periodIdx > 0 && periodIdx < 120) return s.slice(0, periodIdx).trim()
  if (s.length <= 80) return s.trim()
  return `${s.slice(0, 77).trim()}…`
}

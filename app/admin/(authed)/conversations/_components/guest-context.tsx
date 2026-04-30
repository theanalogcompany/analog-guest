import { formatInTimeZone } from 'date-fns-tz'
import { Card, Eyebrow, HairlineRow, StatusDot } from '@/lib/ui'
import type { GuestState } from '@/lib/recognition'

// Read-only guest context. Pulls from latest guest_states row + lightweight
// rollups. NOT a live recompute — that's expensive and writes audit rows.
// THE-202 owns the full guest detail view; this card is just enough to ground
// the conversation you're looking at.
//
// StatusDot mapping is intentionally narrow per project decision: 'new' is
// neutral (not bad — every guest starts here), 'returning'/'regular'/
// 'raving_fan' are good. 'bad' tone is reserved for actually-wrong states
// (failed sends, errors). See THE-201 PR thread for context.

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
  recognitionScore: number | null
  lastVisitAt: Date | null
  visitCountLast90Days: number
  recentEvents: Array<{ eventType: string; createdAt: Date }>
  venueTimezone: string
}

const STATE_TONE: Record<GuestState, 'good' | 'neutral'> = {
  new: 'neutral',
  returning: 'good',
  regular: 'good',
  raving_fan: 'good',
}

export function GuestContext({
  guest,
  state,
  recognitionScore,
  lastVisitAt,
  visitCountLast90Days,
  recentEvents,
  venueTimezone,
}: GuestContextProps) {
  const fullName = [guest.firstName, guest.lastName].filter(Boolean).join(' ') || '(unnamed)'

  return (
    // h-full + overflow-y-auto so the card scrolls inside the 240px context
    // row when recent engagement events accumulate. p-4 (vs reading-width
    // p-6 used elsewhere) gives content more room within the 240px box
    // without losing card weight.
    <Card className="h-full overflow-y-auto p-4 flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Eyebrow>Guest</Eyebrow>
          <h3
            className="font-fraunces text-xl text-ink leading-tight"
            style={{ fontVariationSettings: 'var(--fraunces)' }}
          >
            {fullName}
          </h3>
          <span className="text-xs text-ink-soft tabular-nums">{guest.phoneNumber}</span>
        </div>
        {state ? (
          <div className="flex items-center gap-2">
            <StatusDot tone={STATE_TONE[state]} label={`recognition state: ${state}`} />
            <span className="text-sm text-ink">{state}</span>
            {recognitionScore !== null ? (
              <span className="text-xs text-ink-soft tabular-nums">({recognitionScore})</span>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-ink-soft italic">no state yet</span>
        )}
      </div>

      <div className="flex flex-col">
        <HairlineRow>
          <Row label="Last visit">
            {lastVisitAt
              ? formatInTimeZone(lastVisitAt, venueTimezone, 'MMM d, yyyy')
              : '—'}
          </Row>
        </HairlineRow>
        <HairlineRow>
          <Row label="Visits (90d)">{visitCountLast90Days}</Row>
        </HairlineRow>
        <HairlineRow>
          <Row label="Distance">
            {guest.distanceMiles !== null
              ? `${guest.distanceMiles.toFixed(1)} mi`
              : '—'}
          </Row>
        </HairlineRow>
        <HairlineRow last={recentEvents.length === 0}>
          <Row label="Created via">{guest.createdVia}</Row>
        </HairlineRow>
      </div>

      {recentEvents.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Eyebrow>Recent engagement</Eyebrow>
          <div className="flex flex-col">
            {recentEvents.map((e, i) => (
              <HairlineRow key={`${e.eventType}-${e.createdAt.toISOString()}`} last={i === recentEvents.length - 1}>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-sm text-ink">{e.eventType}</span>
                  <span className="text-xs text-ink-soft">
                    {formatInTimeZone(e.createdAt, venueTimezone, 'MMM d')}
                  </span>
                </div>
              </HairlineRow>
            ))}
          </div>
        </div>
      ) : null}

      <span className="text-xs text-ink-soft italic">
        View guest detail (THE-202) — coming soon.
      </span>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-sm text-ink-soft">{label}</span>
      <span className="text-sm text-ink text-right max-w-[60%]">{children}</span>
    </div>
  )
}

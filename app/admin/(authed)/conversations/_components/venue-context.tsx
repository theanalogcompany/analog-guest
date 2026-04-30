import { Card, Eyebrow, HairlineRow } from '@/lib/ui'
import type { BrandPersona, VenueInfo } from '@/lib/schemas'

// Read-only venue context shown alongside the conversation. Surface only
// what's most useful for debugging an active conversation — persona, today's
// hours, currently-eligible mechanics, active context notes. Editing lives in
// THE-203; that link is a placeholder until the route exists.

interface VenueContextProps {
  venue: { id: string; slug: string; name: string; timezone: string; messagingPhone: string }
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

export function VenueContext({
  venue,
  persona,
  venueInfo,
  mechanics,
  todayLocalIso,
}: VenueContextProps) {
  const todayDayKey = DAY_KEYS[new Date(todayLocalIso + 'T12:00:00').getDay()]
  const todayHours = venueInfo.hours[todayDayKey] ?? 'Not set'
  const phoneTail = venue.messagingPhone.slice(-4)
  const activeContext = venueInfo.currentContext.slice(0, 3)
  const topPhrases = persona.signaturePhrases.slice(0, 3)

  return (
    <Card className="p-6 flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Eyebrow>Venue</Eyebrow>
          <h3
            className="font-fraunces text-xl text-ink leading-tight"
            style={{ fontVariationSettings: 'var(--fraunces)' }}
          >
            {venue.name}
          </h3>
          <span className="text-xs text-ink-soft">{venue.slug}</span>
        </div>
        <span className="text-xs text-ink-soft tabular-nums">···{phoneTail}</span>
      </div>

      <div className="flex flex-col">
        <HairlineRow>
          <Row label="Timezone">{venue.timezone}</Row>
        </HairlineRow>
        <HairlineRow>
          <Row label={`Hours · ${capitalize(todayDayKey)}`}>{todayHours}</Row>
        </HairlineRow>
        <HairlineRow>
          <Row label="Tone">{persona.tone}</Row>
        </HairlineRow>
        <HairlineRow>
          <Row label="Formality">{persona.formality}</Row>
        </HairlineRow>
        <HairlineRow last={topPhrases.length === 0 && mechanics.length === 0 && activeContext.length === 0}>
          <Row label="Speaker framing">
            {persona.speakerFraming === 'named_person' && persona.speakerName
              ? `${persona.speakerName} (named person)`
              : persona.speakerFraming}
          </Row>
        </HairlineRow>
        {topPhrases.length > 0 ? (
          <HairlineRow last={mechanics.length === 0 && activeContext.length === 0}>
            <Row label="Signature phrases">
              <ul className="flex flex-col gap-0.5 text-right">
                {topPhrases.map((p) => (
                  <li key={p} className="italic">&ldquo;{p}&rdquo;</li>
                ))}
              </ul>
            </Row>
          </HairlineRow>
        ) : null}
      </div>

      {mechanics.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Eyebrow>Active mechanics</Eyebrow>
          <div className="flex flex-col">
            {mechanics.map((m, i) => (
              <HairlineRow key={m.id} last={i === mechanics.length - 1}>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-ink">{m.name}</span>
                  <span className="text-xs text-ink-soft">
                    Gate: {m.minState} · {m.redemptionPolicy}
                    {m.redemptionWindowDays !== null ? ` · ${m.redemptionWindowDays}d window` : ''}
                  </span>
                </div>
              </HairlineRow>
            ))}
          </div>
        </div>
      ) : null}

      {activeContext.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Eyebrow>Active context</Eyebrow>
          <div className="flex flex-col">
            {activeContext.map((c, i) => (
              <HairlineRow key={c.id} last={i === activeContext.length - 1}>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-ink">{c.content}</span>
                  <span className="text-xs text-ink-soft">{c.source}</span>
                </div>
              </HairlineRow>
            ))}
          </div>
        </div>
      ) : null}

      <span className="text-xs text-ink-soft italic">
        Edit venue (THE-203) — coming soon.
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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

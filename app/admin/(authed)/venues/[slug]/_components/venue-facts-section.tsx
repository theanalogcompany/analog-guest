import type { VenueInfo } from '@/lib/schemas'
import { HairlineRow } from '@/lib/ui'
import { EmptySectionNote, SectionShell } from './section-shell'

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <HairlineRow className="flex items-baseline justify-between gap-4">
      <span className="text-xs uppercase tracking-wide text-ink-faint">{label}</span>
      <span className="text-sm text-ink text-right">{value}</span>
    </HairlineRow>
  )
}

function formatAddress(address: VenueInfo['address']): string {
  const parts = [address.line1, address.line2, address.city, address.region, address.postalCode]
  return parts.filter(Boolean).join(', ')
}

export function VenueFactsSection({ venueInfo }: { venueInfo: VenueInfo }) {
  const { contact, hours, amenities } = venueInfo
  const hasAnyHours = Object.values(hours).some((v) => Boolean(v))
  const hasAnyAmenities = amenities && Object.values(amenities).some((v) => Boolean(v))

  return (
    <SectionShell title="Venue facts" subtitle="address, contact, hours, amenities">
      <div className="flex flex-col">
        <Fact label="Address" value={formatAddress(venueInfo.address)} />
        <Fact label="Phone" value={contact.publicPhone ?? null} />
        <Fact label="Email" value={contact.publicEmail ?? null} />
        <Fact label="Website" value={contact.website ?? null} />
        <Fact label="QR enrollment message" value={venueInfo.qrEnrollmentMessage ?? null} />
        {hasAnyHours && (
          <>
            <Fact label="Monday" value={hours.monday ?? null} />
            <Fact label="Tuesday" value={hours.tuesday ?? null} />
            <Fact label="Wednesday" value={hours.wednesday ?? null} />
            <Fact label="Thursday" value={hours.thursday ?? null} />
            <Fact label="Friday" value={hours.friday ?? null} />
            <Fact label="Saturday" value={hours.saturday ?? null} />
            <Fact label="Sunday" value={hours.sunday ?? null} />
            <Fact label="Hours notes" value={hours.notes ?? null} />
          </>
        )}
        {hasAnyAmenities && amenities && (
          <>
            <Fact label="Wifi" value={amenities.wifi === undefined ? null : amenities.wifi ? 'Yes' : 'No'} />
            <Fact
              label="Pet friendly"
              value={amenities.petFriendly === undefined ? null : amenities.petFriendly ? 'Yes' : 'No'}
            />
            <Fact label="Parking" value={amenities.parking ?? null} />
            <Fact label="Seating" value={amenities.seating ?? null} />
            <Fact label="Amenity notes" value={amenities.notes ?? null} />
          </>
        )}
        {!hasAnyHours &&
          !hasAnyAmenities &&
          !contact.publicPhone &&
          !contact.publicEmail &&
          !venueInfo.qrEnrollmentMessage && (
            <EmptySectionNote>Only the address is on file so far.</EmptySectionNote>
          )}
      </div>
    </SectionShell>
  )
}

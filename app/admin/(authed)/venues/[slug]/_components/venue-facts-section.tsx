'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
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

function FormField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs uppercase tracking-wide text-ink-faint">{label}</label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-auto bg-highlight py-1.5 text-sm"
      />
    </div>
  )
}

// venue_info's read-modify-write-validate-whole PATCH boundary means every
// field this form can edit must round-trip through the exact shape
// VenueInfoSchema expects — this component's local state mirrors that
// shape directly (address/contact/hours/amenities objects, not a flat
// field list) so the PATCH body needs no reshaping at submit time.
interface FormState {
  address: VenueInfo['address']
  contact: VenueInfo['contact']
  hours: VenueInfo['hours']
  amenities: NonNullable<VenueInfo['amenities']>
  qrEnrollmentMessage: string
}

function toFormState(venueInfo: VenueInfo): FormState {
  return {
    address: { ...venueInfo.address },
    contact: { ...venueInfo.contact },
    hours: { ...venueInfo.hours },
    amenities: { ...venueInfo.amenities },
    qrEnrollmentMessage: venueInfo.qrEnrollmentMessage ?? '',
  }
}

export function VenueFactsSection({
  venueId,
  venueInfo,
}: {
  venueId: string
  venueInfo: VenueInfo
}) {
  const router = useRouter()
  const { contact, hours, amenities } = venueInfo
  const hasAnyHours = Object.values(hours).some((v) => Boolean(v))
  const hasAnyAmenities = amenities && Object.values(amenities).some((v) => Boolean(v))

  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<FormState>(() => toFormState(venueInfo))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function startEdit() {
    setForm(toFormState(venueInfo))
    setEditing(true)
    setError(null)
  }

  async function submit() {
    if (!form.address.line1.trim() || !form.address.city.trim() || !form.address.region.trim() || !form.address.postalCode.trim()) {
      setError('Address line 1, city, region, and postal code are required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/venues/api/venues/${venueId}/venue-info`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: form.address,
          contact: form.contact,
          hours: form.hours,
          amenities: form.amenities,
          // Always sent, including empty string — VenueInfoSchema has no
          // .min(1) on this field, so an emptied input is a real "clear it"
          // intent, not "leave it alone." `|| undefined` here would instead
          // omit the key and silently keep the stale value on save, with no
          // way for an operator to ever clear it from this editor.
          qrEnrollmentMessage: form.qrEnrollmentMessage,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Save failed')
        return
      }
      setEditing(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <SectionShell title="Venue facts" subtitle="address, contact, hours, amenities">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <FormField
              label="Address line 1"
              value={form.address.line1}
              onChange={(v) => setForm((f) => ({ ...f, address: { ...f.address, line1: v } }))}
            />
            <FormField
              label="Address line 2"
              value={form.address.line2 ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, address: { ...f.address, line2: v || undefined } }))}
            />
            <FormField
              label="City"
              value={form.address.city}
              onChange={(v) => setForm((f) => ({ ...f, address: { ...f.address, city: v } }))}
            />
            <FormField
              label="Region"
              value={form.address.region}
              onChange={(v) => setForm((f) => ({ ...f, address: { ...f.address, region: v } }))}
            />
            <FormField
              label="Postal code"
              value={form.address.postalCode}
              onChange={(v) => setForm((f) => ({ ...f, address: { ...f.address, postalCode: v } }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              label="Phone"
              value={form.contact.publicPhone ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, contact: { ...f.contact, publicPhone: v || undefined } }))}
            />
            <FormField
              label="Email"
              value={form.contact.publicEmail ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, contact: { ...f.contact, publicEmail: v || undefined } }))}
            />
            <FormField
              label="Website"
              value={form.contact.website ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, contact: { ...f.contact, website: v || undefined } }))}
            />
            <FormField
              label="QR enrollment message"
              value={form.qrEnrollmentMessage}
              onChange={(v) => setForm((f) => ({ ...f, qrEnrollmentMessage: v }))}
            />
          </div>
          <p className="text-xs uppercase tracking-wide text-ink-faint">Hours</p>
          <div className="grid grid-cols-2 gap-3">
            {(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const).map(
              (day) => (
                <FormField
                  key={day}
                  label={day[0].toUpperCase() + day.slice(1)}
                  value={form.hours[day] ?? ''}
                  onChange={(v) => setForm((f) => ({ ...f, hours: { ...f.hours, [day]: v || undefined } }))}
                />
              ),
            )}
            <FormField
              label="Hours notes"
              value={form.hours.notes ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, hours: { ...f.hours, notes: v || undefined } }))}
            />
          </div>
          <p className="text-xs uppercase tracking-wide text-ink-faint">Amenities</p>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-ink">
              <Checkbox
                checked={Boolean(form.amenities.wifi)}
                onCheckedChange={(checked) =>
                  setForm((f) => ({ ...f, amenities: { ...f.amenities, wifi: checked === true } }))
                }
              />
              Wifi
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <Checkbox
                checked={Boolean(form.amenities.petFriendly)}
                onCheckedChange={(checked) =>
                  setForm((f) => ({ ...f, amenities: { ...f.amenities, petFriendly: checked === true } }))
                }
              />
              Pet friendly
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              label="Parking"
              value={form.amenities.parking ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, amenities: { ...f.amenities, parking: v || undefined } }))}
            />
            <FormField
              label="Seating"
              value={form.amenities.seating ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, amenities: { ...f.amenities, seating: v || undefined } }))}
            />
            <FormField
              label="Amenity notes"
              value={form.amenities.notes ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, amenities: { ...f.amenities, notes: v || undefined } }))}
            />
          </div>
          {error && <p className="border-l-2 border-clay bg-clay/5 px-2 py-1 text-xs text-clay-deep">{error}</p>}
          <div className="flex justify-end gap-3 text-[11px]">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy} size="sm">
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </SectionShell>
    )
  }

  return (
    <SectionShell
      title="Venue facts"
      subtitle="address, contact, hours, amenities"
      headerAction={
        <Button variant="link" size="sm" onClick={startEdit} className="h-auto p-0 text-[11px] text-clay font-medium hover:text-clay-deep">
          Edit
        </Button>
      }
    >
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

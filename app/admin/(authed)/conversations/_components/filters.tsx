'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FollowUpButton } from './follow-up-button'

// Venue + guest pickers. Filter state lives in the URL (?venue=&guest=) so
// reload preserves view and links are shareable. shadcn Select (TAC-306) —
// the URL-navigation behavior is unchanged; only the control is reskinned.
// Direct register: terse labels, no placeholder copy beyond what's needed to
// disambiguate.

// Radix Select forbids an empty-string item value (it's reserved for the
// placeholder), so the "clear to none" option rides a sentinel that maps back
// to null at the URL boundary — preserving the native select's clearable
// behavior.
const NONE_VALUE = '__none__'

interface FiltersProps {
  venues: Array<{ id: string; slug: string; name: string }>
  // Guests for the currently-selected venue (passed in by parent server fetch).
  // Empty when no venue selected.
  guests: Array<{ id: string; firstName: string | null; lastName: string | null; phoneNumber: string }>
  selectedVenueId: string | null
  selectedGuestId: string | null
}

export function Filters({ venues, guests, selectedVenueId, selectedGuestId }: FiltersProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  function setParams(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    startTransition(() => {
      router.replace(`/admin/conversations?${next.toString()}`)
    })
  }

  return (
    // First row of the conversations layout (FullShell in page.tsx).
    // Fixed h-14 (3.5rem) matches TopBar height for visual rhythm. Sticky
    // top-0 keeps filters reachable as the page scrolls past the
    // conversation block to reveal context cards + transactions (PR-5);
    // z-20 stacks over content scrolling beneath. Solid bg-paper masks
    // anything passing under the band during scroll. items-center centers
    // the label-above-select pair vertically within the bar.
    <div className="sticky top-0 z-20 h-14 shrink-0 bg-paper flex items-center gap-4 px-6 border-b border-stone-light/60">
      <Field label="Venue">
        <Select
          value={selectedVenueId ?? NONE_VALUE}
          onValueChange={(v) =>
            // Changing venue clears guest — guest IDs aren't unique across venues
            // and the previous selection won't apply.
            setParams({ venue: v === NONE_VALUE ? null : v, guest: null })
          }
          disabled={isPending}
        >
          <SelectTrigger className="min-w-[14rem]">
            <SelectValue placeholder="— pick venue —" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>— pick venue —</SelectItem>
            {venues.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Guest">
        <Select
          value={selectedGuestId ?? NONE_VALUE}
          onValueChange={(v) => setParams({ guest: v === NONE_VALUE ? null : v })}
          disabled={!selectedVenueId || isPending}
        >
          <SelectTrigger className="min-w-[18rem]">
            <SelectValue placeholder="— pick guest —" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>— pick guest —</SelectItem>
            {guests.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {formatGuestLabel(g)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {/* Manual outbound trigger. Only meaningful with both filters set —
          requires a {venueId, guestId} for the API call. Aligned to the
          right via ml-auto inside the button so the bar stays balanced
          when the button is hidden (pre-filter / venue-only states). */}
      {selectedVenueId && selectedGuestId && (
        <FollowUpButton venueId={selectedVenueId} guestId={selectedGuestId} />
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  // <div> not <label>: the control is now a Radix Select trigger (a button),
  // and wrapping a button in a <label> would forward stray clicks into it.
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-ink-soft uppercase tracking-wider">{label}</span>
      {children}
    </div>
  )
}

function formatGuestLabel(g: {
  firstName: string | null
  lastName: string | null
  phoneNumber: string
}): string {
  const name = [g.firstName, g.lastName].filter(Boolean).join(' ').trim()
  return name ? `${name} · ${g.phoneNumber}` : g.phoneNumber
}

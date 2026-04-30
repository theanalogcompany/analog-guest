'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'

// Venue + guest pickers. Filter state lives in the URL (?venue=&guest=) so
// reload preserves view and links are shareable. Native <select> elements —
// no custom dropdowns. Direct register: terse labels, no placeholder copy
// beyond what's needed to disambiguate.

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
    // Sticky to the top of <main> so filters stay reachable while the page
    // scrolls past the conversation row to expose the venue/guest context
    // cards. z-20 stacks above the conversation row (z-10) so they don't
    // visually overlap if rendering quirks ever push them past each other.
    // Solid bg-paper masks scrolling content beneath the sticky band.
    //
    // Fixed h-16 (4rem) so the conversation row's sticky top offset can be a
    // single magic number without measuring at runtime. items-center centers
    // the label-above-select pair vertically within the bar.
    <div className="sticky top-0 z-20 h-16 bg-paper flex items-center gap-4 px-6 border-b border-stone-light/60">
      <Field label="Venue">
        <select
          value={selectedVenueId ?? ''}
          onChange={(e) => {
            // Changing venue clears guest — guest IDs aren't unique across venues
            // and the previous selection won't apply.
            setParams({ venue: e.target.value || null, guest: null })
          }}
          className="text-sm border border-stone-light rounded px-2 py-1.5 bg-paper min-w-[14rem]"
          disabled={isPending}
        >
          <option value="">— pick venue —</option>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Guest">
        <select
          value={selectedGuestId ?? ''}
          onChange={(e) => setParams({ guest: e.target.value || null })}
          disabled={!selectedVenueId || isPending}
          className="text-sm border border-stone-light rounded px-2 py-1.5 bg-paper min-w-[18rem] disabled:bg-stone-light/30 disabled:text-ink-soft"
        >
          <option value="">— pick guest —</option>
          {guests.map((g) => (
            <option key={g.id} value={g.id}>
              {formatGuestLabel(g)}
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-ink-soft uppercase tracking-wider">{label}</span>
      {children}
    </label>
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

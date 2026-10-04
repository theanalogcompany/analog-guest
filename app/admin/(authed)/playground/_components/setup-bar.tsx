'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { VenueListRow } from '../../_lib/load-venues'

// Setup bar: venue picker + mode toggle. Mirrors the conversations filter
// bar's visual rhythm (h-14, sticky, bg-paper over the scroll), but state
// lives in the parent client component rather than the URL - a playground
// session is deliberately ephemeral, not shareable.

const NONE_VALUE = '__none__'

export type PlaygroundMode = 'sandbox' | 'replay'

export function SetupBar({
  venues,
  selectedVenueId,
  mode,
  busy,
  onVenueChange,
  onModeChange,
}: {
  venues: VenueListRow[]
  selectedVenueId: string | null
  mode: PlaygroundMode
  /** A run is in flight; switching venue mid-run would orphan it. */
  busy: boolean
  onVenueChange: (venueId: string | null) => void
  onModeChange: (mode: PlaygroundMode) => void
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-4 border-b border-stone-light/60 bg-paper px-6">
      <div className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wider text-ink-soft">
          Venue
        </span>
        <Select
          value={selectedVenueId ?? NONE_VALUE}
          onValueChange={(v) => onVenueChange(v === NONE_VALUE ? null : v)}
          disabled={busy}
        >
          <SelectTrigger className="min-w-[14rem]" size="sm">
            <SelectValue placeholder="pick venue" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>pick venue</SelectItem>
            {venues.map((v) => (
              <SelectItem key={v.venueId} value={v.venueId}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wider text-ink-soft">
          Mode
        </span>
        <div className="flex rounded-[2px] border border-stone-light/60">
          <ModeButton
            label="Sandbox guest"
            active={mode === 'sandbox'}
            disabled={busy}
            onClick={() => onModeChange('sandbox')}
          />
          <ModeButton
            label="Replay real guest"
            active={mode === 'replay'}
            disabled={busy}
            onClick={() => onModeChange('replay')}
          />
        </div>
      </div>

      <p className="ml-auto max-w-xs text-right text-xs text-ink-faint">
        Dry run. Reads prod data, calls real models, writes nothing.
      </p>
    </div>
  )
}

function ModeButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string
  active: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`px-3 py-1.5 text-xs font-medium cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'bg-clay text-paper'
          : 'bg-paper text-ink-soft hover:bg-parchment'
      }`}
    >
      {label}
    </button>
  )
}

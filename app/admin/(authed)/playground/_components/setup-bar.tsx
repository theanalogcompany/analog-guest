'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { VenueListRow } from '../../_lib/load-venues'
import type { SavedConversationSummary } from '../_lib/types'

// Setup bar: venue picker, mode toggle, and - in sandbox - the saved
// conversation picker. Mirrors the conversations filter bar's visual rhythm
// (h-14, sticky, bg-paper over the scroll). Live state lives in the parent
// client component rather than the URL; a SAVE is the one piece that outlives
// the tab (migration 074).

const NONE_VALUE = '__none__'

export type PlaygroundMode = 'sandbox' | 'replay'

export function SetupBar({
  venues,
  selectedVenueId,
  mode,
  busy,
  compareV1,
  saved,
  savedError,
  savedHasMore,
  onVenueChange,
  onModeChange,
  onCompareV1Change,
  onLoadConversation,
  onDeleteConversation,
}: {
  venues: VenueListRow[]
  selectedVenueId: string | null
  mode: PlaygroundMode
  /** A run is in flight; switching venue mid-run would orphan it. */
  busy: boolean
  /** Run the v1 arm beside v2. OFF by default - see onCompareV1Change. */
  compareV1: boolean
  saved: SavedConversationSummary[]
  savedError: string | null
  /** Saves exist beyond the listed window; the picker says so rather than implying completeness. */
  savedHasMore: boolean
  onVenueChange: (venueId: string | null) => void
  onModeChange: (mode: PlaygroundMode) => void
  onCompareV1Change: (next: boolean) => void
  onLoadConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
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

      {/* OFF BY DEFAULT, and the default is the whole point. The v1 arm is a
          second full generation per turn - classify + embed + generate on top
          of v2's four calls - so a playground that ran it unconditionally
          would double every operator's model spend whether or not they were
          comparing anything. The first version of this had no toggle and did
          exactly that. */}
      <div className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wider text-ink-soft">
          Compare
        </span>
        <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={compareV1}
            disabled={busy}
            onChange={(e) => onCompareV1Change(e.target.checked)}
            className="size-3.5 cursor-pointer accent-clay disabled:cursor-not-allowed"
          />
          {/* The cost rides the CONTROL, not the note on the right. That note
              lives in a fixed h-14 bar with four columns beside it, so any
              copy long enough to explain the cost gets squeezed into a narrow
              column and spills out of the bar - which is exactly what a
              conditional longer string did here once already. */}
          also run v1 · 2× spend
        </label>
      </div>

      {mode === 'sandbox' && selectedVenueId !== null && (
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider text-ink-soft">
            Saved
          </span>
          <div className="flex items-center gap-2">
            <Select
              value={NONE_VALUE}
              onValueChange={(v) => {
                if (v !== NONE_VALUE) onLoadConversation(v)
              }}
              disabled={busy || saved.length === 0}
            >
              <SelectTrigger className="min-w-[14rem]" size="sm">
                <SelectValue
                  placeholder={
                    saved.length === 0 ? 'no saves yet' : 'load a conversation'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>
                  {saved.length === 0 ? 'no saves yet' : 'load a conversation'}
                </SelectItem>
                {saved.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} · {c.turnCount} turn
                    {c.turnCount === 1 ? '' : 's'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {saved.length > 0 && (
              <button
                type="button"
                title="Delete the most recent save"
                disabled={busy}
                onClick={() => onDeleteConversation(saved[0].id)}
                className="cursor-pointer whitespace-nowrap text-[11px] text-ink-faint underline decoration-dotted underline-offset-2 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
              >
                delete newest
              </button>
            )}
          </div>
        </div>
      )}

      {/* NO DRY-RUN NOTE HERE any more. With four controls in a fixed h-14 bar
          there is no width left for it: `ml-auto` collapsed it to nothing and
          it rendered as invisible dead markup. The same statement lives in the
          page subtitle, which has the room. The cost of running v1 rides the
          checkbox label instead, where it is next to the thing that causes it. */}
      <div className="ml-auto flex flex-col items-end gap-0.5">
        {savedError !== null && (
          <p className="text-right text-[11px] text-destructive">
            saved conversations: {savedError}
          </p>
        )}
        {savedHasMore && (
          <p className="text-right text-[11px] italic text-ink-faint">
            showing the newest 50 saves
          </p>
        )}
      </div>
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
  // whitespace-nowrap: "Replay real guest" was wrapping to three lines and
  // clipping against the bar's fixed h-14. Pre-existing, fixed here because it
  // sits next to the copy this change touched.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`cursor-pointer whitespace-nowrap px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'bg-clay text-paper'
          : 'bg-paper text-ink-soft hover:bg-parchment'
      }`}
    >
      {label}
    </button>
  )
}

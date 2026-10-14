'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { PlaygroundTurn } from '../_lib/types'
import {
  GuestBubbles,
  OutreachMarker,
  TurnReply,
  V1ActualReply,
  V1ComparisonCaveat,
  V1V2Columns,
} from './bubbles'

// Sandbox chat: the operator plays the guest, each send runs one full v2
// turn. Also renders replay results (same turn shape, plus the v1
// comparison), so the left pane reads as one conversation either way.

function RewindButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string
  title: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer whitespace-nowrap text-[11px] text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  )
}

/** Default save name: the opening guest message, trimmed to something readable. */
const NAME_FROM_FIRST_MESSAGE_CHARS = 60

/**
 * Default hours-quiet for an outreach turn: roughly "yesterday afternoon",
 * the same ~21 the golden harness authors (run-turn.ts outreach doc).
 */
const DEFAULT_HOURS_QUIET = '21'

/** Bounds mirror the run route's schema; out of range would 400 there. */
const HOURS_QUIET_MIN = 1
const HOURS_QUIET_MAX = 336

export function ChatPane({
  turns,
  selectedTurnId,
  canSend,
  busy,
  emptyHint,
  showComposer,
  prefill,
  onSend,
  onSelectTurn,
  onRewind,
  savableTurnCount,
  saving,
  onSaveConversation,
  outreachDisabledReason,
  onOutreach,
}: {
  turns: PlaygroundTurn[]
  selectedTurnId: string | null
  canSend: boolean
  busy: boolean
  emptyHint: string
  /** Replay mode hides the composer - sends come from the timeline. */
  showComposer: boolean
  /** Rewind-to-edit hands the rewound inbound back via seq bump. */
  prefill: { seq: number; text: string } | null
  onSend: (text: string) => void
  onSelectTurn: (id: string) => void
  /** Discards this turn and everything after; 'rerun' re-sends it as-is. */
  onRewind: (turnId: string, mode: 'rerun' | 'edit') => void
  /** How many turns a save would actually carry; 0 hides the control. */
  savableTurnCount: number
  saving: boolean
  onSaveConversation: (name: string) => void
  /** Why "Venue writes first" cannot fire right now, or null when it can. */
  outreachDisabledReason: string | null
  onOutreach: (hoursQuiet: number) => void
}) {
  const [draft, setDraft] = useState('')
  const [savingOpen, setSavingOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [hoursQuietDraft, setHoursQuietDraft] = useState(DEFAULT_HOURS_QUIET)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Stable identity: TurnReply calls this from an effect on every bubble
  // reveal, so a fresh closure each render would re-fire it on every paint.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [turns, scrollToBottom])

  // Adopt a rewound inbound exactly once per seq bump - the documented
  // adjust-state-during-render pattern, not an effect, so the composer
  // repaints with the text in the same pass.
  const [seenPrefillSeq, setSeenPrefillSeq] = useState(0)
  if (prefill !== null && prefill.seq !== seenPrefillSeq) {
    setSeenPrefillSeq(prefill.seq)
    setDraft(prefill.text)
  }

  const send = () => {
    const text = draft.trim()
    if (text.length === 0 || !canSend || busy) return
    setDraft('')
    onSend(text)
  }

  const hoursQuiet = Number(hoursQuietDraft)
  const hoursQuietValid =
    Number.isFinite(hoursQuiet) &&
    hoursQuiet >= HOURS_QUIET_MIN &&
    hoursQuiet <= HOURS_QUIET_MAX

  const fireOutreach = () => {
    if (outreachDisabledReason !== null || !hoursQuietValid) return
    onOutreach(hoursQuiet)
  }

  const openSave = () => {
    const first = turns.find((t) => t.mode === 'sandbox')?.request.inbound[0]
    setSaveName((first ?? '').slice(0, NAME_FROM_FIRST_MESSAGE_CHARS))
    setSavingOpen(true)
  }

  const commitSave = () => {
    const name = saveName.trim()
    if (name.length === 0 || saving) return
    onSaveConversation(name)
    setSavingOpen(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {turns.length === 0 ? (
          <p className="pt-8 text-center text-sm italic text-ink-faint">
            {emptyHint}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {turns.map((turn) => (
              <div key={turn.id} className="group flex flex-col gap-1.5">
                {/* Stacked, never a flex row: a row wrapper makes GuestBubbles
                    content-sized, and the bubble's max-w-[75%] then resolves
                    against a collapsing parent - one character per line. */}
                {turn.request.outreach !== undefined ? (
                  <OutreachMarker
                    hoursQuiet={turn.request.outreach.hoursQuiet}
                  />
                ) : (
                  <GuestBubbles texts={turn.request.inbound} />
                )}
                {turn.mode === 'sandbox' && (
                  <span className="flex gap-3 opacity-0 transition-opacity group-hover:opacity-100">
                    <RewindButton
                      label="rerun from here"
                      title="Discard everything after this message and run it again fresh"
                      disabled={busy}
                      onClick={() => onRewind(turn.id, 'rerun')}
                    />
                    {/* No edit on an outreach turn: there is no inbound to put
                        back in the composer, and prefilling it empty would
                        leave the pane in a state Send cannot leave. */}
                    {turn.request.outreach === undefined && (
                      <RewindButton
                        label="edit from here"
                        title="Discard everything from this message on and put it back in the composer"
                        disabled={busy}
                        onClick={() => onRewind(turn.id, 'edit')}
                      />
                    )}
                  </span>
                )}
                {/* One or the other, never both: the comparison block carries
                    v2's reply in its own column, so rendering TurnReply above
                    it would print the same reply twice. TurnReply still owns
                    the running / failed / restored states, which the
                    comparison has nothing to show for - and it keeps the
                    staggered reveal, which the comparison deliberately does
                    not take (see V1V2Columns). */}
                {turn.status === 'done' && turn.response?.v1 != null ? (
                  <>
                    <V1V2Columns
                      turn={turn}
                      selected={turn.id === selectedTurnId}
                      onSelect={() => onSelectTurn(turn.id)}
                    />
                    <V1ComparisonCaveat />
                  </>
                ) : (
                  <TurnReply
                    turn={turn}
                    selected={turn.id === selectedTurnId}
                    onSelect={() => onSelectTurn(turn.id)}
                    onReveal={scrollToBottom}
                  />
                )}
                {turn.mode === 'replay' && turn.status === 'done' && (
                  <>
                    <V1ActualReply bubbles={turn.v1Reply ?? null} />
                    <p className="text-[11px] italic text-ink-faint">
                      Replay uses transcript-only context for v2: profile,
                      memory and state start empty at the replay point. v1
                      builds its own context from the guest&apos;s real row, so
                      it sees their recognition band and visits.
                    </p>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showComposer && turns.some((t) => t.mode === 'sandbox') && (
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-1">
          <p className="text-[11px] italic text-ink-faint">
            Hover a guest message to rerun or edit from that point - later turns
            are discarded, and the session rewinds with them.
          </p>
          {savableTurnCount > 0 && !savingOpen && (
            <button
              type="button"
              onClick={openSave}
              disabled={busy || saving}
              className="shrink-0 cursor-pointer whitespace-nowrap text-[11px] text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving
                ? 'saving'
                : `save conversation (${savableTurnCount} turn${savableTurnCount === 1 ? '' : 's'})`}
            </button>
          )}
        </div>
      )}

      {showComposer && savingOpen && (
        <div className="flex shrink-0 items-center gap-2 border-t border-stone-light/60 bg-parchment/40 px-4 py-2">
          <input
            type="text"
            value={saveName}
            autoFocus
            maxLength={120}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitSave()
              }
              if (e.key === 'Escape') setSavingOpen(false)
            }}
            placeholder="Name this conversation"
            className="h-8 flex-1 rounded-[2px] border border-stone-light bg-paper px-2 text-xs text-ink outline-none focus:border-clay/60"
          />
          <Button
            type="button"
            size="sm"
            onClick={commitSave}
            disabled={saveName.trim().length === 0 || saving}
          >
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setSavingOpen(false)}
          >
            Cancel
          </Button>
        </div>
      )}

      {showComposer && (
        <div className="flex shrink-0 items-end gap-2 border-t border-stone-light/60 bg-paper px-4 py-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={
              canSend ? 'Message as the guest' : 'Pick a venue first'
            }
            disabled={!canSend || busy}
            className="min-h-9 max-h-32 flex-1 resize-none"
            rows={1}
          />
          <Button
            type="button"
            size="sm"
            onClick={send}
            disabled={!canSend || busy || draft.trim().length === 0}
          >
            {busy ? 'Running' : 'Send'}
          </Button>
          {/* The outreach control: fire a turn with NO guest message. A plain
              <button> rather than <Button> because shadcn's disabled
              pointer-events-none swallows hover, and the title explaining WHY
              it is disabled is the whole point of disabling instead of
              hiding. */}
          <div className="flex shrink-0 items-center gap-1.5 border-l border-stone-light/60 pl-2">
            <label className="flex items-center gap-1 whitespace-nowrap text-[11px] text-ink-faint">
              <input
                type="number"
                min={HOURS_QUIET_MIN}
                max={HOURS_QUIET_MAX}
                value={hoursQuietDraft}
                onChange={(e) => setHoursQuietDraft(e.target.value)}
                disabled={outreachDisabledReason !== null}
                aria-label="hours quiet"
                className="h-8 w-14 rounded-[2px] border border-stone-light bg-paper px-1.5 text-xs text-ink outline-none focus:border-clay/60 disabled:cursor-not-allowed disabled:opacity-50"
              />
              hours quiet
            </label>
            <button
              type="button"
              onClick={fireOutreach}
              disabled={outreachDisabledReason !== null || !hoursQuietValid}
              title={
                outreachDisabledReason ??
                (hoursQuietValid
                  ? 'Run an outreach turn: the venue writes first after this many quiet hours'
                  : `hours quiet must be ${HOURS_QUIET_MIN}-${HOURS_QUIET_MAX}`)
              }
              className="cursor-pointer whitespace-nowrap rounded-[2px] border border-stone-light/60 bg-paper px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-parchment disabled:cursor-not-allowed disabled:opacity-50"
            >
              Venue writes first
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

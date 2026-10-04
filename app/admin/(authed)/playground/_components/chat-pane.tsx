'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { PlaygroundTurn } from '../_lib/types'
import { GuestBubbles, TurnReply, V1ActualReply } from './bubbles'

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
}) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

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
                <GuestBubbles texts={turn.request.inbound} />
                {turn.mode === 'sandbox' && (
                  <span className="flex gap-3 opacity-0 transition-opacity group-hover:opacity-100">
                    <RewindButton
                      label="rerun from here"
                      title="Discard everything after this message and run it again fresh"
                      disabled={busy}
                      onClick={() => onRewind(turn.id, 'rerun')}
                    />
                    <RewindButton
                      label="edit from here"
                      title="Discard everything from this message on and put it back in the composer"
                      disabled={busy}
                      onClick={() => onRewind(turn.id, 'edit')}
                    />
                  </span>
                )}
                <TurnReply
                  turn={turn}
                  selected={turn.id === selectedTurnId}
                  onSelect={() => onSelectTurn(turn.id)}
                />
                {turn.mode === 'replay' && turn.status === 'done' && (
                  <>
                    <V1ActualReply bubbles={turn.v1Reply ?? null} />
                    <p className="text-[11px] italic text-ink-faint">
                      Replay uses transcript-only context: profile, memory and
                      state start empty at the replay point.
                    </p>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showComposer && turns.some((t) => t.mode === 'sandbox') && (
        <p className="shrink-0 px-4 pb-1 text-[11px] italic text-ink-faint">
          Hover a guest message to rerun or edit from that point - later turns
          are discarded, and the session rewinds with them.
        </p>
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
        </div>
      )}
    </div>
  )
}

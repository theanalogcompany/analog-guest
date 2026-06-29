'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'

// Operator-initiated manual outbound. Lives in the Filters bar (right side)
// and only renders when both venueId and guestId are set.
//
// State machine:
//   idle    → button. Click → open.
//   open    → shadcn Popover anchored under the button: optional textarea +
//             Send / Cancel. Empty hint is fine; the agent picks the topic.
//   sending → POST in flight. Send/Cancel disabled, label "Sending…".
//   sent    → ✓ Sent. Auto-collapses to idle after 3s. Realtime subscription
//             on conversations-client renders the new message; we don't need
//             to push it from here.
//   error   → inline error text inside the open panel; user can retry or
//             cancel.
//
// Dismissal (TAC-306): the Popover owns outside-click + Escape. Every close
// path routes through `cancel()` — it NEVER triggers a send. Outside-click is
// suppressed mid-flight (`onInteractOutside` preventDefault while sending) so
// closing the panel can't orphan the in-flight request from its UI signal;
// Escape is still allowed mid-flight (the request completes server-side and
// Realtime surfaces the result) — matching the pre-reskin behavior. The send
// call + its confirm step (Send button / Cmd+Enter) are unchanged.
//
// Keyboard:
//   Esc           → cancel (close panel; Popover-handled).
//   Cmd/Ctrl+Enter → send (when textarea focused).
//
// HTTP contract:
//   POST /admin/conversations/api/follow-up { venueId, guestId, hint }
//   (Colocated under /admin/* so the host-gating middleware lets it through
//   on admin.theanalog.company. Mirrors the existing trace fetch route at
//   /admin/conversations/api/trace/[traceId].)
//   200 → { success: true, messageId }
//   422 → { error: 'refused', detail, attemptScores }   — voice fidelity floor
//   429 → { error: 'rate limited', detail }             — 1/5min rate limit
//   403 → { error: 'guest opted out' | 'venue not allowed' }
//   404 → { error: 'guest not found at venue' }
//   502 → { error: 'pipeline failed', stage, detail }   — send/persist crash
//   400/500 — generic; show detail to the operator.

const MAX_HINT_LENGTH = 500
const SUCCESS_DISPLAY_MS = 3000

interface FollowUpButtonProps {
  venueId: string
  guestId: string
}

type Status = 'idle' | 'open' | 'sending' | 'sent' | 'error'

interface ApiErrorBody {
  error?: string
  detail?: string
  stage?: string
  attemptScores?: number[]
}

export function FollowUpButton({ venueId, guestId }: FollowUpButtonProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [hint, setHint] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)

  const isOpenLike = status === 'open' || status === 'sending' || status === 'error'
  const sending = status === 'sending'
  const overLimit = hint.length > MAX_HINT_LENGTH

  // Auto-collapse after a successful send. Cleared on unmount or status change.
  useEffect(() => {
    if (status !== 'sent') return
    const t = setTimeout(() => {
      setStatus('idle')
      setHint('')
    }, SUCCESS_DISPLAY_MS)
    return () => clearTimeout(t)
  }, [status])

  async function send() {
    setStatus('sending')
    setErrorText(null)
    const trimmed = hint.trim()
    try {
      const res = await fetch('/admin/conversations/api/follow-up', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          venueId,
          guestId,
          hint: trimmed.length > 0 ? trimmed : null,
        }),
      })
      if (res.ok) {
        setStatus('sent')
        setHint('')
        return
      }
      let body: ApiErrorBody = {}
      try {
        body = (await res.json()) as ApiErrorBody
      } catch {
        // ignore — fall back to status text
      }
      setErrorText(formatError(res.status, body))
      setStatus('error')
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'request failed')
      setStatus('error')
    }
  }

  function open() {
    setStatus('open')
    setErrorText(null)
  }

  function cancel() {
    setStatus('idle')
    setErrorText(null)
  }

  // Popover open/close. Opening routes to open(); every close path routes to
  // cancel() — never send(). (Outside-click while sending is suppressed below
  // via onInteractOutside, so this only fires for Escape / trigger re-click.)
  function handleOpenChange(next: boolean) {
    if (next) open()
    else cancel()
  }

  if (status === 'sent') {
    return (
      <div className="ml-auto self-end mb-1.5">
        <span className="inline-flex items-center gap-1.5 text-sm text-clay-deep px-3 py-1.5">
          <span aria-hidden>✓</span>
          <span>Sent</span>
        </span>
      </div>
    )
  }

  return (
    <div className="ml-auto self-end mb-1.5">
      <Popover open={isOpenLike} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            // Locked mid-flight, matching the pre-reskin trigger: prevents a
            // trigger re-click from collapsing the panel while a send is in
            // flight (Escape is still allowed; the request completes and
            // Realtime surfaces the result).
            disabled={sending}
            className="border-clay text-clay hover:bg-clay hover:text-paper"
          >
            Follow up
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          // Don't let an outside click tear down the panel mid-flight — the
          // request is in-flight and closing would orphan it from the UI.
          onInteractOutside={(e) => {
            if (sending) e.preventDefault()
          }}
          className="w-[22rem] p-3 flex flex-col gap-2"
          aria-label="Compose follow-up"
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-soft uppercase tracking-wider">
              Note (optional)
            </span>
            <Textarea
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !sending && !overLimit) {
                  e.preventDefault()
                  void send()
                }
              }}
              disabled={sending}
              rows={3}
              placeholder="What should the agent address?"
              className="resize-none text-sm"
            />
            <span
              className={`text-xs tabular-nums self-end ${
                overLimit ? 'text-clay-deep' : 'text-ink-faint'
              }`}
            >
              {hint.length}/{MAX_HINT_LENGTH}
            </span>
          </label>

          {errorText && (
            <div className="text-xs text-clay-deep bg-clay-soft/30 border border-clay-soft rounded px-2 py-1.5">
              {errorText}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={cancel}
              disabled={sending}
              className="text-ink-soft hover:text-ink"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void send()}
              disabled={sending || overLimit}
            >
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function formatError(httpStatus: number, body: ApiErrorBody): string {
  const label = body.error ?? `HTTP ${httpStatus}`
  if (body.detail) return `${label}: ${body.detail}`
  if (httpStatus === 422) return 'Voice fidelity below send floor — try a different hint or retry.'
  if (httpStatus === 429) return 'Rate limited — try again in a few minutes.'
  if (httpStatus === 403 && body.error === 'guest opted out') {
    return 'Guest has opted out — cannot send.'
  }
  return label
}

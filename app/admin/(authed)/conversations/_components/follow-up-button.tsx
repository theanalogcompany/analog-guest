'use client'

import { useEffect, useRef, useState } from 'react'

// Operator-initiated manual outbound. Lives in the Filters bar (right side)
// and only renders when both venueId and guestId are set.
//
// State machine:
//   idle    → button. Click → open.
//   open    → small popover anchored under the button: optional textarea +
//             Send / Cancel. Empty hint is fine; the agent picks the topic.
//   sending → POST in flight. Send/Cancel disabled, label "Sending…".
//   sent    → ✓ Sent. Auto-collapses to idle after 3s. Realtime subscription
//             on conversations-client renders the new message; we don't need
//             to push it from here.
//   error   → inline error text inside the open panel; user can retry or
//             cancel.
//
// Keyboard:
//   Esc           → cancel (close panel).
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
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const isOpenLike = status === 'open' || status === 'sending' || status === 'error'

  // Focus the textarea on open. Tied to status so re-opening focuses again.
  useEffect(() => {
    if (status === 'open') textareaRef.current?.focus()
  }, [status])

  // Auto-collapse after a successful send. Cleared on unmount or status change.
  useEffect(() => {
    if (status !== 'sent') return
    const t = setTimeout(() => {
      setStatus('idle')
      setHint('')
    }, SUCCESS_DISPLAY_MS)
    return () => clearTimeout(t)
  }, [status])

  // Click-outside dismiss while open. Skipped during 'sending' — closing
  // mid-flight would orphan the in-flight request from the UI signal; finish
  // first.
  useEffect(() => {
    if (status !== 'open' && status !== 'error') return
    function onDocClick(e: MouseEvent) {
      if (!popoverRef.current) return
      if (!popoverRef.current.contains(e.target as Node)) {
        setStatus('idle')
        setErrorText(null)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [status])

  // Esc to cancel — even mid-flight Esc is safe (the request still completes
  // server-side; we just stop showing the panel and rely on Realtime to
  // surface the resulting message). Allowing escape during 'sending' beats
  // trapping the operator. (isOpenLike already includes 'sending'.)
  useEffect(() => {
    if (!isOpenLike) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setStatus('idle')
        setErrorText(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpenLike])

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

  if (status === 'idle') {
    return (
      <div className="ml-auto self-end mb-1.5">
        <button
          type="button"
          onClick={open}
          className="text-sm border border-clay text-clay rounded px-3 py-1.5 bg-paper hover:bg-clay hover:text-paper transition-colors"
        >
          Follow up
        </button>
      </div>
    )
  }

  // open / sending / error all share the popover shell.
  const sending = status === 'sending'
  const overLimit = hint.length > MAX_HINT_LENGTH

  return (
    <div className="ml-auto self-end mb-1.5 relative">
      <button
        type="button"
        disabled
        className="text-sm border border-clay text-clay rounded px-3 py-1.5 bg-paper opacity-60 cursor-default"
      >
        Follow up
      </button>
      <div
        ref={popoverRef}
        role="dialog"
        aria-label="Compose follow-up"
        className="absolute right-0 top-full mt-1 w-[22rem] z-30 bg-paper border border-stone-light rounded shadow-sm p-3 flex flex-col gap-2"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-soft uppercase tracking-wider">
            Note (optional)
          </span>
          <textarea
            ref={textareaRef}
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
            className="text-sm border border-stone-light rounded px-2 py-1.5 bg-paper resize-none focus:outline-none focus:border-clay disabled:bg-stone-light/30"
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
          <button
            type="button"
            onClick={cancel}
            disabled={sending}
            className="text-sm text-ink-soft px-2 py-1 hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || overLimit}
            className="text-sm border border-clay bg-clay text-paper rounded px-3 py-1.5 hover:bg-clay-deep hover:border-clay-deep transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
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

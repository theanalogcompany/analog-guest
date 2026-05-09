'use client'

import { formatInTimeZone } from 'date-fns-tz'
import { useState } from 'react'
import type { Json } from '@/db/types'
import { type MessageCategory } from '@/lib/ai/types'
import { type MessageReview, MessageReviewSchema } from '@/lib/schemas'
import { Eyebrow } from '@/lib/ui'
import {
  buildReviewPayload,
  canSaveReview,
  type ReviewFormState,
} from './build-review-payload'

// Per-message review form (THE-235). Sits below the trace panel inside the
// vertical-split SidePanel for outbound messages. Submits to PR-A's
// /admin/conversations/api/review/[messageId] PUT endpoint.
//
// Pre-fill behavior:
//   - On mount, state initializes from messages.response_review JSONB via
//     safeParse so a malformed blob (e.g. manually edited via SQL) doesn't
//     crash the form — falls back to "not reviewed."
//   - Disclosures auto-open when their field has content, so a re-loaded
//     review shows everything in place.
//   - When the operator opens "Add an edit" with no prior content, the
//     editedMessage textarea pre-fills with the original message body so
//     they have something to revise (rather than staring at a blank box).
//   - Collapsing a disclosure clears its field. The form's mental model is
//     "what you see is what you'll save"; ghost state hidden behind a
//     collapsed disclosure would be confusing on save.
//
// Selection-change resets state by remount. The parent SidePanel passes
// `key={selected.id}` so React tears the form down and mounts a fresh one
// when the operator clicks a different message. Cleaner than a setState-
// in-effect; matches the same pattern conversations/page.tsx uses for
// ConversationsClient on (venue, guest) changes. Silent-discard of
// unsaved edits is the explicit trade-off — alternative is friction we
// don't want on a rapid-investigation surface.
//
// Save behavior is await + spinner, no optimistic update. The Realtime
// echo from PR-A's UPDATE handler arrives ~500ms after success and lights
// the bubble's reviewed indicator. Voyage failures (502 from the route)
// surface as an error row; the form keeps state for retry.

const CATEGORY_OPTIONS: MessageCategory[] = [
  'welcome',
  'follow_up',
  'reply',
  'new_question',
  'opt_out',
  'perk_unlock',
  'perk_inquiry',
  'event_invite',
  'event_question',
  'manual',
  'acknowledgment',
  'comp_complaint',
  'mechanic_request',
  'recommendation_request',
  'casual_chatter',
  'personal_history_question',
  'unknown',
]

const EMPTY_STATE: ReviewFormState = {
  category: '',
  comment: '',
  editedMessage: '',
  rule: '',
  expectedFailure: '',
}

function preFillFromReview(
  review: Json | null,
  fallbackCategory: string | null,
): { state: ReviewFormState; parsed: MessageReview | null } {
  if (review !== null) {
    const result = MessageReviewSchema.safeParse(review)
    if (result.success) {
      const r = result.data
      return {
        state: {
          category: r.category ?? fallbackCategory ?? '',
          comment: r.comment ?? '',
          editedMessage: r.editedMessage ?? '',
          rule: r.rule ?? '',
          expectedFailure: r.expectedFailure ?? '',
        },
        parsed: r,
      }
    }
    console.warn('[review-form] response_review parse failed, treating as unreviewed')
  }
  return {
    state: { ...EMPTY_STATE, category: fallbackCategory ?? '' },
    parsed: null,
  }
}

interface ReviewFormProps {
  messageId: string
  messageBody: string
  messageCategory: string | null
  responseReview: Json | null
  operatorMap: Record<string, string>
  venueTimezone: string
}

export function ReviewForm({
  messageId,
  messageBody,
  messageCategory,
  responseReview,
  operatorMap,
  venueTimezone,
}: ReviewFormProps) {
  // Lazy initializers — selection change forces a remount via the parent's
  // `key={selected.id}`, so these run with the latest props on each new
  // message. No useEffect needed; Realtime echoes for the SAME message
  // don't clobber in-progress edits because there's no listener.
  const initial = preFillFromReview(responseReview, messageCategory)
  const [state, setState] = useState<ReviewFormState>(() => initial.state)
  const [parsedReview] = useState<MessageReview | null>(() => initial.parsed)
  const [showEdit, setShowEdit] = useState(() => initial.state.editedMessage !== '')
  const [showRule, setShowRule] = useState(() => initial.state.rule !== '')
  const [showExpectedFailure, setShowExpectedFailure] = useState(
    () => initial.state.expectedFailure !== '',
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function update<K extends keyof ReviewFormState>(field: K, value: string) {
    setState((s) => ({ ...s, [field]: value }))
  }

  function toggleEdit() {
    if (showEdit) {
      // Collapse → clear. Re-open will pre-fill with the original body again.
      setState((s) => ({ ...s, editedMessage: '' }))
    } else if (state.editedMessage === '') {
      setState((s) => ({ ...s, editedMessage: messageBody }))
    }
    setShowEdit((p) => !p)
  }

  function toggleRule() {
    if (showRule) setState((s) => ({ ...s, rule: '' }))
    setShowRule((p) => !p)
  }

  function toggleExpectedFailure() {
    if (showExpectedFailure) setState((s) => ({ ...s, expectedFailure: '' }))
    setShowExpectedFailure((p) => !p)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSaveReview(state) || saving) return
    setSaving(true)
    setSaveError(null)
    const body = buildReviewPayload(state)
    try {
      const res = await fetch(
        `/admin/conversations/api/review/${encodeURIComponent(messageId)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null
        const msg =
          errBody?.detail ?? errBody?.error ?? `${res.status} ${res.statusText}`
        setSaveError(msg)
        return
      }
      // Success — bubble indicator updates via Realtime echo. Form keeps
      // its content (last saved) so the operator can see what they wrote.
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'request failed')
    } finally {
      setSaving(false)
    }
  }

  const canSave = canSaveReview(state) && !saving

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 p-4 text-[13px] text-ink"
    >
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>Review</Eyebrow>
        <StatusRow
          parsed={parsedReview}
          operatorMap={operatorMap}
          venueTimezone={venueTimezone}
        />
      </div>

      <fieldset disabled={saving} className="flex flex-col gap-3 disabled:opacity-60">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.18em] text-ink-soft">
            Category
          </span>
          <select
            value={state.category}
            onChange={(e) => update('category', e.target.value)}
            className="border border-stone-light bg-paper px-2 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-clay/40"
          >
            <option value="">(none)</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.18em] text-ink-soft">
            Comment <span className="text-clay">*</span>
          </span>
          <textarea
            value={state.comment}
            onChange={(e) => update('comment', e.target.value)}
            rows={3}
            placeholder="What did you notice? Required."
            className="border border-stone-light bg-paper px-2 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-clay/40"
          />
        </label>

        <Disclosure
          label="Add an edit"
          expanded={showEdit}
          onToggle={toggleEdit}
        >
          <textarea
            value={state.editedMessage}
            onChange={(e) => update('editedMessage', e.target.value)}
            rows={4}
            className="w-full border border-stone-light bg-paper px-2 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-clay/40"
          />
          <p className="mt-1 text-[11px] text-ink-soft">
            Pre-filled with the original. Only this corrected text is embedded into the corpus.
          </p>
        </Disclosure>

        <Disclosure
          label="Add a rule"
          expanded={showRule}
          onToggle={toggleRule}
        >
          <textarea
            value={state.rule}
            onChange={(e) => update('rule', e.target.value)}
            rows={2}
            placeholder="rule: don't apologize twice"
            className="w-full border border-stone-light bg-paper px-2 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-clay/40"
          />
        </Disclosure>

        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showExpectedFailure}
              onChange={toggleExpectedFailure}
            />
            <span className="text-[12px]">Expected failure</span>
          </label>
          {showExpectedFailure ? (
            <input
              type="text"
              value={state.expectedFailure}
              onChange={(e) => update('expectedFailure', e.target.value)}
              placeholder="Reason — short note about why this is an acceptable miss"
              className="border border-stone-light bg-paper px-2 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-clay/40"
            />
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          {saveError ? (
            <span className="text-[12px] text-red-700" role="alert">
              {saveError}
            </span>
          ) : null}
          <button
            type="submit"
            disabled={!canSave}
            className="border border-clay bg-clay px-3 py-1.5 text-[12px] uppercase tracking-[0.18em] text-paper transition-opacity disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save review'}
          </button>
        </div>
      </fieldset>
    </form>
  )
}

interface StatusRowProps {
  parsed: MessageReview | null
  operatorMap: Record<string, string>
  venueTimezone: string
}

function StatusRow({ parsed, operatorMap, venueTimezone }: StatusRowProps) {
  if (!parsed) {
    return <span className="text-[11px] text-ink-soft tabular-nums">Not reviewed</span>
  }
  const reviewerLabel = operatorMap[parsed.reviewedBy] ?? parsed.reviewedBy.slice(0, 8)
  const date = new Date(parsed.reviewedAt)
  const formattedDate = Number.isNaN(date.getTime())
    ? parsed.reviewedAt
    : formatInTimeZone(date, venueTimezone, 'MMM d, h:mm a')
  return (
    <span className="text-[11px] text-ink-soft tabular-nums">
      Reviewed {formattedDate} · {reviewerLabel}
    </span>
  )
}

interface DisclosureProps {
  label: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}

function Disclosure({ label, expanded, onToggle, children }: DisclosureProps) {
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 text-left text-[12px] text-ink-soft hover:text-ink"
      >
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        <span>{label}</span>
      </button>
      {expanded ? <div>{children}</div> : null}
    </div>
  )
}

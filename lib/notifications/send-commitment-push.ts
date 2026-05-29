// TAC-297 commitment-arrival push orchestrator. Companion to send.ts (the
// draft-flagged push for TAC-212 review queue). Same APNs primitive, same
// privacy invariant (no message contents in the payload), same fail-soft
// posture (never throws, RAGResult-typed at the http level).
//
// Two fire sites:
//   - lib/agent/handle-inbound.ts → imminent transition winner (CAS rowcount=1
//     in transitionToPendingAck), fired via waitUntil for fire-and-forget
//     keep-alive coverage.
//   - lib/guests/commitments-due.ts → cron-fired scheduled transitions, same
//     CAS gate, same waitUntil pattern from the cron route handler.
//
// Payload contract (Contract-bound for TAC-298):
//   { aps: { alert: { title, body }, badge, sound: "default" },
//     commitmentId, guestId, operatorId }
// custom data fields: commitmentId + guestId + operatorId. TAC-298 routes
// the tap handler to the heads-up card identified by commitmentId.
//
// Body format: "{firstName} arriving {context} — {typeLabel}{ code}"
//   - context: "now" for imminent; "{morning|afternoon|evening}" for scheduled.
//   - typeLabel: "comp" / "hold" / "discount" / "ready" (for rec).
//   - code: ", code XXXX" when populated (comp/hold/discount); omitted for rec.
// Example: "Jaipal coming now — comp, code 7K2P".
//
// Note: the commitment description itself is NOT in the payload. The
// description is operator-chosen content (e.g. "oat latte"), not the guest's
// inbound text — but TAC-207's privacy invariant ("no message contents") is
// stricter than necessary here. We keep the body to type + code only so the
// payload schema stays content-free across BOTH push surfaces; description
// rendering is the operator-card client's job (TAC-298).
//
// Helpers duplicated from lib/notifications/send.ts (loadRecipients,
// countPendingForOperator, nullOperatorToken). Extraction into a shared
// lib/notifications/recipients.ts module is a follow-up — duplicating now
// to keep the TAC-297 change scoped and unblock TAC-298.

import {
  capturePushSent,
  capturePushTokenInvalid,
} from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import type {
  ArrivalSignal,
  CommitmentType,
} from '@/lib/schemas/guest-commitment'
import { sendApnsRequest } from './apns/client'

const APNS_TOKEN_INVALID_STATUS = 410
const APNS_BAD_DEVICE_TOKEN_STATUS = 400
// Larger than the 40-char budget in send.ts because the commitment body
// format ("{firstName} arriving {context} — {typeLabel}{ code}") naturally
// runs longer than the draft-flagged format ("Reply to {firstName} —
// {context}"). 80 keeps a typical first-name + scheduled context + code
// intact while still preventing pathological payloads from a malformed
// firstName.
const MAX_PUSH_BODY_CHARS = 80

// Categorical labels per commitment type — operator-glance signal for what
// kind of heads-up this is. Keys MUST stay aligned with
// CommitmentTypeSchema enum.
const TYPE_LABEL: Record<CommitmentType, string> = {
  comp: 'comp',
  hold: 'hold',
  discount: 'discount',
  recommendation: 'ready',
}

export interface SendCommitmentArrivalPushInput {
  commitmentId: string
  venueId: string
  guestId: string
  /** guests.first_name. Null when unknown — falls back to "a guest". */
  guestFirstName: string | null
  type: CommitmentType
  code: string | null
  /** ISO string from guest_commitments.expected_arrival. Null = unknown. */
  expectedArrival: string | null
  arrivalSignal: ArrivalSignal
  /** Used to bucket expected_arrival into morning/afternoon/evening. */
  venueTimezone: string
  /** Optional. Set when the push fires off an inbound CAS-win (the agent run
   * ID is available there). Omit when firing from the cron (no agent run). */
  agentRunId?: string | null
}

/**
 * Returns a context string for the push body — "now" for imminent, time-bucket
 * for scheduled. Falls back to "soon" when scheduled but expected_arrival is
 * missing or unparseable (defensive — shouldn't happen if the row was
 * scheduled correctly).
 */
export function buildArrivalContext(
  arrivalSignal: ArrivalSignal,
  expectedArrival: string | null,
  venueTimezone: string,
): string {
  if (arrivalSignal === 'imminent') return 'now'
  if (!expectedArrival) return 'soon'
  const dt = new Date(expectedArrival)
  if (Number.isNaN(dt.getTime())) return 'soon'
  // Hour-of-day in venue timezone; bucket into morning (<12) / afternoon (12-17)
  // / evening (>=17). Intl.DateTimeFormat with hour12=false renders 24h.
  const hourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: venueTimezone,
    hour: '2-digit',
    hour12: false,
  }).format(dt)
  const hour = Number(hourStr)
  if (Number.isNaN(hour)) return 'soon'
  if (hour < 12) return 'this morning'
  if (hour < 17) return 'this afternoon'
  return 'this evening'
}

export function buildCommitmentPushBody(
  firstName: string | null,
  type: CommitmentType,
  code: string | null,
  context: string,
): string {
  const trimmed = firstName?.trim() ?? ''
  const namePart = trimmed ? trimmed : 'a guest'
  const typeLabel = TYPE_LABEL[type]
  const codeFragment = code ? `, code ${code}` : ''
  const full = `${namePart} arriving ${context} — ${typeLabel}${codeFragment}`
  if (full.length <= MAX_PUSH_BODY_CHARS) return full
  // Over budget — trim the name first.
  if (trimmed) {
    const overhead = ` arriving ${context} — ${typeLabel}${codeFragment}`.length
    const maxNameChars = Math.max(1, MAX_PUSH_BODY_CHARS - overhead)
    return `${trimmed.slice(0, maxNameChars).trim()} arriving ${context} — ${typeLabel}${codeFragment}`
  }
  return full.slice(0, MAX_PUSH_BODY_CHARS)
}

interface OperatorRecipient {
  id: string
  apnsDeviceToken: string
}

async function loadRecipients(venueId: string): Promise<OperatorRecipient[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('operator_venues')
    .select('operator:operators!inner(id, apns_device_token)')
    .eq('venue_id', venueId)
    .not('operator.apns_device_token', 'is', null)
  if (error || !data) {
    console.error('[apns] commitment loadRecipients query failed', {
      venueId,
      error: error?.message,
    })
    return []
  }
  const seen = new Set<string>()
  const out: OperatorRecipient[] = []
  for (const row of data) {
    const op = row.operator
    if (!op) continue
    if (!op.apns_device_token) continue
    if (seen.has(op.id)) continue
    seen.add(op.id)
    out.push({ id: op.id, apnsDeviceToken: op.apns_device_token })
  }
  return out
}

/**
 * Operator-scoped badge count combining pending drafts (review_state='pending')
 * and pending_ack commitments. Single source of truth for the operator app's
 * badge across BOTH push surfaces. Mirrors the predicate in send.ts +
 * extends it with the commitments side.
 */
async function countBadgeForOperator(operatorId: string): Promise<number> {
  const supabase = createAdminClient()
  const { data: venues, error: venuesError } = await supabase
    .from('operator_venues')
    .select('venue_id')
    .eq('operator_id', operatorId)
  if (venuesError || !venues || venues.length === 0) {
    return 0
  }
  const venueIds = venues.map((v) => v.venue_id)
  const [draftsResult, commitmentsResult] = await Promise.all([
    supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('review_state', 'pending')
      .in('venue_id', venueIds),
    supabase
      .from('guest_commitments')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending_ack')
      .in('venue_id', venueIds),
  ])
  if (draftsResult.error) {
    console.error('[apns] commitment countBadgeForOperator drafts failed', {
      operatorId,
      error: draftsResult.error.message,
    })
  }
  if (commitmentsResult.error) {
    console.error('[apns] commitment countBadgeForOperator commitments failed', {
      operatorId,
      error: commitmentsResult.error.message,
    })
  }
  return (draftsResult.count ?? 0) + (commitmentsResult.count ?? 0)
}

async function nullOperatorToken(operatorId: string): Promise<void> {
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('operators')
    .update({ apns_device_token: null, apns_token_updated_at: null })
    .eq('id', operatorId)
  if (error) {
    console.error('[apns] commitment nullOperatorToken failed', {
      operatorId,
      error: error.message,
    })
  }
}

/**
 * Top-level commitment-arrival push orchestrator. Never throws.
 *
 * Idempotency posture (TAC-297 design call #4): the caller MUST already have
 * a CAS-won transition (transitionToPendingAck returned transitioned=true).
 * This function does NOT re-check the row's status — it trusts the gate at
 * its boundary. Calling it without a CAS win would mean a double-push.
 *
 * Surface tag in PostHog events (`surface: 'commitment_arrival'`) lets the
 * draft-flagged and commitment surfaces be analyzed separately.
 */
export async function sendCommitmentArrivalPush(
  input: SendCommitmentArrivalPushInput,
): Promise<void> {
  const baseFields = {
    commitmentId: input.commitmentId,
    venueId: input.venueId,
    guestId: input.guestId,
    type: input.type,
    arrivalSignal: input.arrivalSignal,
  }
  console.log('[apns] sendCommitmentArrivalPush called', baseFields)

  const recipients = await loadRecipients(input.venueId)
  if (recipients.length === 0) {
    console.log('[apns] commitment skipped: no operators with apns token for venue', {
      ...baseFields,
    })
    return
  }
  console.log('[apns] commitment fanout begin', {
    ...baseFields,
    recipientCount: recipients.length,
    recipientIds: recipients.map((r) => r.id),
  })

  const context = buildArrivalContext(
    input.arrivalSignal,
    input.expectedArrival,
    input.venueTimezone,
  )
  const body = buildCommitmentPushBody(
    input.guestFirstName,
    input.type,
    input.code,
    context,
  )

  for (const recipient of recipients) {
    const badge = await countBadgeForOperator(recipient.id)
    const payload = {
      aps: {
        alert: { title: 'Guest arriving', body },
        badge,
        sound: 'default',
      },
      commitmentId: input.commitmentId,
      guestId: input.guestId,
      operatorId: recipient.id,
    }

    const result = await sendApnsRequest({
      deviceToken: recipient.apnsDeviceToken,
      body: payload,
    })

    if (!result.ok) {
      console.error('[apns] commitment send failed (transport)', {
        ...baseFields,
        operatorId: recipient.id,
        error: result.error,
        detail: result.detail,
      })
      await capturePushSent({
        agentRunId: input.agentRunId ?? null,
        venueId: input.venueId,
        guestId: input.guestId,
        operatorId: recipient.id,
        draftId: input.commitmentId,
        primaryTrigger: 'commitment_arrival',
        ok: false,
        status: null,
        error: result.error,
        errorDetail: result.detail,
        badge,
        surface: 'commitment_arrival',
      })
      continue
    }

    const { status, reason } = result.response
    const tokenInvalid =
      status === APNS_TOKEN_INVALID_STATUS ||
      (status === APNS_BAD_DEVICE_TOKEN_STATUS && reason === 'BadDeviceToken')

    if (status === 200) {
      console.log('[apns] commitment send ok', {
        ...baseFields,
        operatorId: recipient.id,
        badge,
      })
    } else {
      console.warn('[apns] commitment APNs returned non-200', {
        ...baseFields,
        operatorId: recipient.id,
        status,
        reason,
        tokenInvalid,
      })
    }

    if (tokenInvalid) {
      await nullOperatorToken(recipient.id)
      await capturePushTokenInvalid({
        agentRunId: input.agentRunId ?? null,
        venueId: input.venueId,
        guestId: input.guestId,
        operatorId: recipient.id,
        draftId: input.commitmentId,
        primaryTrigger: 'commitment_arrival',
        status,
        reason,
        surface: 'commitment_arrival',
      })
    }

    await capturePushSent({
      agentRunId: null,
      venueId: input.venueId,
      guestId: input.guestId,
      operatorId: recipient.id,
      draftId: input.commitmentId,
      primaryTrigger: 'commitment_arrival',
      ok: status === 200,
      status,
      error: status === 200 ? null : 'apns_status_non_200',
      errorDetail: reason ?? null,
      badge,
      surface: 'commitment_arrival',
    })
  }
}

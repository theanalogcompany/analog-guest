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
// Body format (TAC-532):
//   "{firstName} arriving {context}, {typeLabel}{ for {description}}{, code XXXX}"
//   - context: "now" for imminent; "{morning|afternoon|evening}" for scheduled.
//   - typeLabel: "comp" / "hold" / "discount" / "ready" (for rec).
//   - description: the commitment's own text, sanitized. Omitted when empty or
//     when the budget leaves no useful room for it.
//   - code: ", code XXXX" when populated (comp/hold/discount); omitted for rec.
// Example: "Jaipal arriving now, comp for oat latte, code 7K2P".
//
// TAC-532 added the description and dropped the em dash. The description is
// what tells two same-type commitments for one guest apart; before this the
// body carried type and code only, so two recommendations (which carry no
// code) pushed identically. It is agent or operator chosen text about our own
// commitment, NOT the guest's words, so it does not carry the lock-screen
// concern that gates quoting in send.ts. This file's earlier note said the
// description was withheld only to keep the payload shape uniform across both
// surfaces and called TAC-207's invariant "stricter than necessary here";
// ruled 2026-09-23 that the uniformity was not worth the collision.
//
// The guest's inbound text still never appears here.
//
// (The paragraph that stood here said loadRecipients, countPendingForOperator
// and nullOperatorToken were duplicated from send.ts and that extracting them
// was a follow-up. TAC-473 did it: this file imports them from ./recipients
// six lines below. Corrected in TAC-532 rather than left contradicting the
// import directly beneath it.)

import {
  capturePushSent,
  capturePushTokenInvalid,
} from '@/lib/analytics/posthog'
import { loadPushRecipients, countOperatorBadge, clearOperatorPushToken } from './recipients'
import type {
  ArrivalSignal,
  CommitmentType,
} from '@/lib/schemas/guest-commitment'
import { sendApnsRequest } from './apns/client'

const APNS_TOKEN_INVALID_STATUS = 410
const APNS_BAD_DEVICE_TOKEN_STATUS = 400
// TAC-532 raised this from 80, which predated the description. A typical
// first name, a scheduled context, the type, a description and a code have to
// fit intact; the description is what gives way first when they do not, and
// is dropped whole below MIN_DESCRIPTION_CHARS. Still a bound against a
// pathological payload from a malformed firstName or description.
const MAX_PUSH_BODY_CHARS = 120
// Below this a description fragment says nothing useful, so it is dropped
// whole rather than rendered as a word and an ellipsis.
const MIN_DESCRIPTION_CHARS = 8

/**
 * The description is MODEL-WRITTEN text, so it is flattened and capped before
 * it reaches a notification. Mirrors sanitizeCardDescription in
 * lib/operator/queue.ts (TAC-527), which does the same job for the operator
 * card, including stripping em and en dashes: this body is read fast on a
 * phone mid-shift, the same rule REVIEW_REASON_LABELS follows.
 *
 * Deliberately a local copy rather than an import: lib/operator/queue.ts pulls
 * the operator query layer, which has no business loading on the push path.
 */
function sanitizeDescription(raw: string, max: number): string {
  const flattened = raw.replace(/[\u2014\u2013]/g, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= max) return flattened
  const cut = flattened.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()
}

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
  /**
   * TAC-532. guest_commitments.description, the thing the venue owes. Required
   * rather than optional so both call sites decide: an optional field would let
   * either default to "no description" silently, which is the collision this
   * ticket removes. Empty string is the honest value when a row has none.
   */
  description: string
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
  description: string,
): string {
  const trimmed = firstName?.trim() ?? ''
  const namePart = trimmed ? trimmed : 'a guest'
  const typeLabel = TYPE_LABEL[type]
  const codeFragment = code ? `, code ${code}` : ''
  const withoutDescription = `${namePart} arriving ${context}, ${typeLabel}${codeFragment}`

  // The description is trimmed FIRST and dropped before anything else is
  // touched: the name, the type and the code are what an operator acts on at
  // the counter, and the description only distinguishes two commitments of the
  // same type for the same guest.
  const room = MAX_PUSH_BODY_CHARS - withoutDescription.length - ' for '.length
  const shown = room >= MIN_DESCRIPTION_CHARS ? sanitizeDescription(description, room) : ''
  if (shown.length > 0) {
    return `${namePart} arriving ${context}, ${typeLabel} for ${shown}${codeFragment}`
  }

  if (withoutDescription.length <= MAX_PUSH_BODY_CHARS) return withoutDescription
  // Still over with no description at all: trim the name, as before TAC-532.
  if (trimmed) {
    const overhead = ` arriving ${context}, ${typeLabel}${codeFragment}`.length
    const maxNameChars = Math.max(1, MAX_PUSH_BODY_CHARS - overhead)
    return `${trimmed.slice(0, maxNameChars).trim()} arriving ${context}, ${typeLabel}${codeFragment}`
  }
  return withoutDescription.slice(0, MAX_PUSH_BODY_CHARS)
}

// TAC-473: these three moved to ./recipients when a third push surface
// arrived. Thin local aliases keep this file's call sites and its log lines
// exactly as they were; the prefixes are passed in for that reason.
const loadRecipients = (venueId: string) =>
  loadPushRecipients(venueId, { logPrefix: '[apns] commitment loadRecipients' })
const countBadgeForOperator = countOperatorBadge
const nullOperatorToken = (operatorId: string) =>
  clearOperatorPushToken(operatorId, { logPrefix: '[apns] commitment nullOperatorToken failed' })

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
    input.description,
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

    const { status, reason, apnsId } = result.response
    const tokenInvalid =
      status === APNS_TOKEN_INVALID_STATUS ||
      (status === APNS_BAD_DEVICE_TOKEN_STATUS && reason === 'BadDeviceToken')

    // Mirrors the draft-flagged surface in send.ts: ONE unconditional line
    // carrying status + reason + apnsId on every response, success included.
    // Kept symmetric on purpose — asymmetric logging across the two push
    // surfaces makes a UAT run ambiguous about which one actually fired.
    const responseFields = {
      ...baseFields,
      operatorId: recipient.id,
      badge,
      status,
      reason: reason ?? null,
      apnsId: apnsId ?? null,
      tokenInvalid,
    }
    if (status === 200) {
      console.log('[apns] commitment apns response', responseFields)
    } else {
      console.warn('[apns] commitment apns response', responseFields)
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

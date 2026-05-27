// Push orchestration for the TAC-212 approval queue (TAC-207).
//
// Called fire-and-forget from handle-inbound.ts + handle-followup.ts whenever
// applyApprovalPolicyStage returns action='queue' AND persist succeeded. The
// caller wraps in `waitUntil(...)` so the keep-alive window covers the
// network round-trip without blocking the agent's return.
//
// Trigger filter (operator-approved, TAC-207 plan revision 1):
//   model_flagged                    → fire push  ("needs review")
//   comp_regex_backstop              → fire push  ("comp request")
//   fidelity_below_auto_send_floor   → fire push  ("low fidelity")
//   previous_pending_held            → skip — regen of an already-pushed
//                                       draft; original push is the
//                                       notification, Realtime updates the
//                                       card live.
//
// Payload contract (locked at plan review w/ TAC-288):
//   { aps: { alert: { title, body }, badge, sound: "default" },
//     draftId, guestId, operatorId }
// custom data fields: draftId + guestId + operatorId. TAC-288's tap handler
// routes to /conversation/[guestId]; draftId is informational.
//
// Privacy: no message contents (guest body, draft body) ever land in the
// payload. Title is static, body is "Reply to {firstName} — {context}" with
// context = a categorical trigger label, not free text. Asserted in tests.

import { createAdminClient } from '@/lib/db/admin'
import {
  capturePushSent,
  capturePushTokenInvalid,
} from '@/lib/analytics/posthog'
import { sendApnsRequest } from './apns/client'

const APNS_TOKEN_INVALID_STATUS = 410
const APNS_BAD_DEVICE_TOKEN_STATUS = 400
const MAX_PUSH_BODY_CHARS = 40

// Categorical labels mapped from approval.primaryTrigger. Keys MUST stay in
// sync with APPROVAL_TRIGGERS in lib/agent/stages.ts. A trigger that lands
// here without a mapping fires push with no context dash (defensive
// fallback, see buildPushBody) — the missing entry is the bug to fix.
const CONTEXT_BY_TRIGGER: Record<string, string> = {
  model_flagged: 'needs review',
  comp_regex_backstop: 'comp request',
  fidelity_below_auto_send_floor: 'low fidelity',
}

const SHOULD_PUSH_TRIGGERS = new Set(Object.keys(CONTEXT_BY_TRIGGER))

export interface SendDraftFlaggedPushInput {
  agentRunId: string
  venueId: string
  guestId: string
  /** guests.first_name. Null when unknown — falls back to "a guest". */
  guestFirstName: string | null
  /** messages.id of the pending draft. */
  draftId: string
  /** approval.primaryTrigger from applyApprovalPolicyStage. */
  primaryTrigger: string
}

/**
 * Returns true if primaryTrigger should fire a push. Used by the caller as a
 * pre-flight check so we don't even take the supabase round-trip when the
 * trigger is filtered out.
 */
export function shouldSendDraftFlaggedPush(primaryTrigger: string): boolean {
  return SHOULD_PUSH_TRIGGERS.has(primaryTrigger)
}

export function buildPushBody(
  firstName: string | null,
  primaryTrigger: string,
): string {
  const trimmed = firstName?.trim() ?? ''
  const namePart = trimmed ? `Reply to ${trimmed}` : 'Reply to a guest'
  const context = CONTEXT_BY_TRIGGER[primaryTrigger]
  const full = context ? `${namePart} — ${context}` : namePart
  if (full.length <= MAX_PUSH_BODY_CHARS) return full
  if (context && trimmed) {
    const overhead = 'Reply to  — '.length + context.length
    const maxNameChars = Math.max(1, MAX_PUSH_BODY_CHARS - overhead)
    return `Reply to ${trimmed.slice(0, maxNameChars).trim()} — ${context}`
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
    console.error('[apns] loadRecipients query failed', {
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
  // Diagnostic delta: rawRowCount > 0 with recipientCount === 0 means the
  // operator_venues rows exist but the embedded apns_device_token filter
  // dropped them all (or row.operator was unexpectedly null/array-shaped).
  // recipientCount === 0 with rawRowCount === 0 means no operator is
  // allowlisted for this venue.
  console.log('[apns] loadRecipients', {
    venueId,
    rawRowCount: data.length,
    recipientCount: out.length,
  })
  return out
}

/**
 * Pending-draft count for the operator's queue. Same predicate as
 * list_operator_queue (db/migrations/018_operator_review_state.sql:218-219)
 * scoped to the operator's allowed venues:
 *   review_state = 'pending' AND venue_id IN (operator's allowedVenueIds)
 *
 * Going through a subquery on operator_venues keeps the predicate the
 * literal same one the queue uses; if the queue's filter ever changes, this
 * needs to change alongside it.
 */
async function countPendingForOperator(operatorId: string): Promise<number> {
  const supabase = createAdminClient()
  const { data: venues, error: venuesError } = await supabase
    .from('operator_venues')
    .select('venue_id')
    .eq('operator_id', operatorId)
  if (venuesError || !venues || venues.length === 0) {
    return 0
  }
  const venueIds = venues.map((v) => v.venue_id)
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('review_state', 'pending')
    .in('venue_id', venueIds)
  if (error) {
    console.error('apns: countPendingForOperator failed', {
      operatorId,
      error: error.message,
    })
    return 0
  }
  return count ?? 0
}

async function nullOperatorToken(operatorId: string): Promise<void> {
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('operators')
    .update({ apns_device_token: null, apns_token_updated_at: null })
    .eq('id', operatorId)
  if (error) {
    console.error('apns: nullOperatorToken failed', {
      operatorId,
      error: error.message,
    })
  }
}

/**
 * Top-level push orchestrator. Never throws.
 *
 * 1. Pre-flight: skip when primaryTrigger isn't in SHOULD_PUSH_TRIGGERS.
 * 2. Find all operators whose allowlist includes venueId AND who have a
 *    non-null apns_device_token.
 * 3. For each: compute their pending-count badge (operator-scoped same as
 *    list_operator_queue), build the payload, POST to APNs, route response.
 * 4. 410 Gone (or 400 with reason=BadDeviceToken) → null both token columns
 *    on the operator + fire push.token_invalid event (Slack-relayed).
 * 5. Every send (success or transport-level failure) fires a single
 *    push.sent event with ok:boolean.
 */
export async function sendDraftFlaggedPush(
  input: SendDraftFlaggedPushInput,
): Promise<void> {
  // Entry log is unconditional so Vercel logs surface every invocation
  // before any early-return path. PostHog events also fire downstream, but
  // those aren't visible alongside agent logs and surface ~minutes late.
  const baseFields = {
    agentRunId: input.agentRunId,
    venueId: input.venueId,
    guestId: input.guestId,
    draftId: input.draftId,
    primaryTrigger: input.primaryTrigger,
  }
  console.log('[apns] sendDraftFlaggedPush called', baseFields)

  if (!shouldSendDraftFlaggedPush(input.primaryTrigger)) {
    console.log('[apns] skipped: primaryTrigger not in fire set', baseFields)
    return
  }

  const recipients = await loadRecipients(input.venueId)
  if (recipients.length === 0) {
    console.log('[apns] skipped: no operators with apns_device_token for venue', {
      ...baseFields,
    })
    return
  }
  console.log('[apns] fanout begin', {
    ...baseFields,
    recipientCount: recipients.length,
    recipientIds: recipients.map((r) => r.id),
  })

  const body = buildPushBody(input.guestFirstName, input.primaryTrigger)

  for (const recipient of recipients) {
    const badge = await countPendingForOperator(recipient.id)
    const payload = {
      aps: {
        alert: { title: 'New draft to review', body },
        badge,
        sound: 'default',
      },
      draftId: input.draftId,
      guestId: input.guestId,
      operatorId: recipient.id,
    }

    const result = await sendApnsRequest({
      deviceToken: recipient.apnsDeviceToken,
      body: payload,
    })

    if (!result.ok) {
      // Transport-level failure: no APNs status (we never got a response).
      // The detail field carries which env var was missing or which
      // network step failed. Vercel External APIs panel will show no
      // outgoing api.push.apple.com request in this case, by design — the
      // failure happened before http2.connect.
      console.error('[apns] send failed (transport)', {
        ...baseFields,
        operatorId: recipient.id,
        error: result.error,
        detail: result.detail,
      })
      await capturePushSent({
        agentRunId: input.agentRunId,
        venueId: input.venueId,
        guestId: input.guestId,
        operatorId: recipient.id,
        draftId: input.draftId,
        primaryTrigger: input.primaryTrigger,
        ok: false,
        status: null,
        error: result.error,
        errorDetail: result.detail,
        badge,
      })
      continue
    }

    const { status, reason } = result.response
    const tokenInvalid =
      status === APNS_TOKEN_INVALID_STATUS ||
      (status === APNS_BAD_DEVICE_TOKEN_STATUS && reason === 'BadDeviceToken')

    if (status === 200) {
      console.log('[apns] send ok', { ...baseFields, operatorId: recipient.id, badge })
    } else {
      console.warn('[apns] APNs returned non-200', {
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
        agentRunId: input.agentRunId,
        venueId: input.venueId,
        guestId: input.guestId,
        operatorId: recipient.id,
        draftId: input.draftId,
        primaryTrigger: input.primaryTrigger,
        status,
        reason,
      })
    }

    await capturePushSent({
      agentRunId: input.agentRunId,
      venueId: input.venueId,
      guestId: input.guestId,
      operatorId: recipient.id,
      draftId: input.draftId,
      primaryTrigger: input.primaryTrigger,
      ok: status === 200,
      status,
      error: status === 200 ? null : 'apns_status_non_200',
      errorDetail: reason ?? null,
      badge,
    })
  }
}

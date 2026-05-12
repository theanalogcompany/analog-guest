// Shared "send the pending draft via Sendblue and update the existing row"
// helper for the mobile operator approve + edit endpoints (TAC-258). The
// inbound/followup agent paths INSERT new outbound rows via persistOutbound;
// here we UPDATE an existing draft that was created with review_state='pending'
// (by TAC-212's runtime flag policy, once that lands). Same Sendblue primitive
// (lib/messaging/send.ts); different persistence contract.
//
// Concurrency contract: optimistic UPDATE flips review_state pending→target
// before calling Sendblue. Rowcount=0 means another caller already acted —
// caller-route should look up the current row and return 200 with
// 'already_acted'. Rowcount=1 means we won the race; we call Sendblue, then
// a second UPDATE stamps status='sent', sent_at, provider_message_id. Per
// the design discussion: no explicit transaction; the conditional UPDATE is
// itself atomic; the small post-UPDATE pre-Sendblue window is acceptable
// (v1 trade-off — Sendblue failure recovery deferred to a follow-up ticket
// per the plan's failure-modes section).
//
// originalBody is captured from the SELECT (before the UPDATE) and returned
// so the edit route can fold it into response_review.originalAiBody. TOCTOU
// safe because if review_state='pending' at SELECT, body is the AI draft
// (no prior edits applied) — the captured value is correct regardless of
// which way the subsequent UPDATE resolves.
//
// No corpus write or response_review stamp inside this helper. The edit
// route owns those steps explicitly (mirrors the cc-review route's serial
// chain pattern); skip route doesn't use this helper at all (no Sendblue
// dispatch); approve route stamps neither.

import { createAdminClient } from '@/lib/db/admin'
import { sendMessage } from '@/lib/messaging/send'

export type DispatchAction = 'approve' | 'edit'

export interface DispatchOperatorOutboundInput {
  messageId: string
  operatorId: string
  allowedVenueIds: string[]
  action: DispatchAction
  /** Required when action === 'edit'. Becomes messages.body. */
  editedBody?: string
}

export interface DispatchSuccessSent {
  ok: true
  outcome: 'sent'
  messageId: string
  venueId: string
  guestId: string
  category: string | null
  voiceFidelity: number | null
  providerMessageId: string
  /** messages.created_at as ISO string. Used for PostHog timeToActionMs. */
  createdAt: string
  /**
   * messages.body as it stood at the SELECT before the optimistic UPDATE.
   * For action='approve' this equals the dispatched text (no edit applied).
   * For action='edit' this is the AI draft (pre-edit) — caller folds it into
   * response_review.originalAiBody.
   */
  originalBody: string
}

export interface DispatchSuccessAlreadyActed {
  ok: true
  outcome: 'already_acted'
  messageId: string
  venueId: string
  guestId: string
  category: string | null
  voiceFidelity: number | null
  /** Current review_state on the row — whatever the first caller settled it to. */
  currentReviewState: string | null
}

export type DispatchErrorCode =
  | 'message_not_found'
  | 'opted_out'
  | 'venue_misconfigured'
  | 'sendblue_failed'
  | 'db_error'
  | 'invalid_input'

export interface DispatchFailure {
  ok: false
  errorCode: DispatchErrorCode
  error: string
}

export type DispatchOperatorOutboundResult =
  | DispatchSuccessSent
  | DispatchSuccessAlreadyActed
  | DispatchFailure

export async function dispatchOperatorOutbound(
  input: DispatchOperatorOutboundInput,
): Promise<DispatchOperatorOutboundResult> {
  if (input.action === 'edit') {
    const edited = input.editedBody?.trim()
    if (edited === undefined || edited.length === 0) {
      return {
        ok: false,
        errorCode: 'invalid_input',
        error: 'editedBody is required and must be non-empty for action=edit',
      }
    }
  }

  const supabase = createAdminClient()

  // ---- 1. read the draft (also captures the pre-update body for originalAiBody) ----
  const { data: row, error: readErr } = await supabase
    .from('messages')
    .select(
      'id, venue_id, guest_id, body, category, voice_fidelity, direction, review_state, created_at',
    )
    .eq('id', input.messageId)
    .maybeSingle()
  if (readErr) {
    return { ok: false, errorCode: 'db_error', error: readErr.message }
  }

  // venue allowlist: returning message_not_found (not 403) intentionally; per
  // the ticket "ACL: use 404 for messages outside their allowlist — don't
  // leak existence." Same code-path for "doesn't exist at all".
  if (!row || row.direction !== 'outbound') {
    return {
      ok: false,
      errorCode: 'message_not_found',
      error: 'message not found',
    }
  }
  if (
    input.allowedVenueIds.length > 0 &&
    !input.allowedVenueIds.includes(row.venue_id)
  ) {
    return {
      ok: false,
      errorCode: 'message_not_found',
      error: 'message not found',
    }
  }

  // ---- 2. if already-acted, surface that to the caller (no Sendblue) ----
  if (row.review_state !== 'pending') {
    return {
      ok: true,
      outcome: 'already_acted',
      messageId: row.id,
      venueId: row.venue_id,
      guestId: row.guest_id,
      category: row.category,
      voiceFidelity: row.voice_fidelity,
      currentReviewState: row.review_state,
    }
  }

  // ---- 3. opt-out check (defensive — TAC-212's flag policy should already filter) ----
  const { data: guestRow, error: guestErr } = await supabase
    .from('guests')
    .select('phone_number, opted_out_at')
    .eq('id', row.guest_id)
    .eq('venue_id', row.venue_id)
    .maybeSingle()
  if (guestErr) {
    return { ok: false, errorCode: 'db_error', error: guestErr.message }
  }
  if (!guestRow) {
    return {
      ok: false,
      errorCode: 'message_not_found',
      error: 'guest not found at venue',
    }
  }
  if (guestRow.opted_out_at !== null) {
    return { ok: false, errorCode: 'opted_out', error: 'guest opted out' }
  }

  // ---- 4. optimistic state flip (pending → approved | edited). On race, rowcount=0. ----
  const targetReviewState = input.action === 'approve' ? 'approved' : 'edited'
  const now = new Date().toISOString()

  const updatePayload: {
    review_state: string
    previous_review_state: string
    last_operator_action_at: string
    last_operator_id: string
    body?: string
  } = {
    review_state: targetReviewState,
    previous_review_state: 'pending',
    last_operator_action_at: now,
    last_operator_id: input.operatorId,
  }
  if (input.action === 'edit') {
    updatePayload.body = input.editedBody!.trim()
  }

  const { data: claimedRows, error: claimErr } = await supabase
    .from('messages')
    .update(updatePayload)
    .eq('id', row.id)
    .eq('review_state', 'pending')
    .select('id, venue_id, category, voice_fidelity, review_state')

  if (claimErr) {
    return { ok: false, errorCode: 'db_error', error: claimErr.message }
  }
  if (!claimedRows || claimedRows.length === 0) {
    // Lost the race. Re-read for the current state.
    const { data: current } = await supabase
      .from('messages')
      .select('id, venue_id, category, voice_fidelity, review_state')
      .eq('id', row.id)
      .maybeSingle()
    return {
      ok: true,
      outcome: 'already_acted',
      messageId: row.id,
      venueId: row.venue_id,
      guestId: row.guest_id,
      category: current?.category ?? row.category,
      voiceFidelity: current?.voice_fidelity ?? row.voice_fidelity,
      currentReviewState: current?.review_state ?? null,
    }
  }

  // ---- 5. dispatch via Sendblue ----
  const sendBody = input.action === 'edit' ? input.editedBody!.trim() : row.body
  const sendResult = await sendMessage({
    venueId: row.venue_id,
    to: guestRow.phone_number,
    body: sendBody,
  })

  if (!sendResult.ok) {
    // Known v1 gap: the row is now review_state=approved|edited with
    // provider_message_id=null. Surfaces via the failure mode documented in
    // CLAUDE.md "Operator API" section; recovery is manual SQL or the v2
    // failed_dispatch reconciliation ticket. We do NOT roll back the state
    // flip because doing so naively reintroduces double-send risk.
    return {
      ok: false,
      errorCode: 'sendblue_failed',
      error: sendResult.error,
    }
  }

  // ---- 6. stamp dispatch metadata ----
  const { error: stampErr } = await supabase
    .from('messages')
    .update({
      status: 'sent',
      sent_at: now,
      provider_message_id: sendResult.data.providerMessageId,
    })
    .eq('id', row.id)

  if (stampErr) {
    // Sendblue accepted but our row write failed — log the providerMessageId
    // via the error so an operator can hand-stitch the row if needed.
    return {
      ok: false,
      errorCode: 'db_error',
      error: `dispatch metadata stamp failed: ${stampErr.message} (providerMessageId=${sendResult.data.providerMessageId})`,
    }
  }

  return {
    ok: true,
    outcome: 'sent',
    messageId: row.id,
    venueId: row.venue_id,
    guestId: row.guest_id,
    category: row.category,
    voiceFidelity: row.voice_fidelity,
    providerMessageId: sendResult.data.providerMessageId,
    createdAt: row.created_at,
    originalBody: row.body,
  }
}

// Push orchestration for the TAC-212 approval queue (TAC-207).
//
// Called fire-and-forget from handle-inbound.ts + handle-followup.ts whenever
// applyApprovalPolicyStage returns action='queue' AND persist succeeded. The
// caller wraps in `waitUntil(...)` so the keep-alive window covers the
// network round-trip without blocking the agent's return.
//
// Trigger filter: DENY-LIST, owned by ./push-policy.ts. Every approval
// trigger pushes except an explicit 'skip' (today only previous_pending_held).
// The decision map there is TOTAL over ApprovalTrigger, so a new trigger fails
// tsc until someone decides. It used to be an allow-list keyed on the label
// map below, which silently dropped commitment_type_gated (ff653be) and
// hold_all_outbound (0c1515c) — see push-policy.ts for the full post-mortem.
//
// Payload contract (locked at plan review w/ TAC-288):
//   { aps: { alert: { title, body }, badge, sound: "default" },
//     draftId, guestId, operatorId }
// custom data fields: draftId + guestId + operatorId. TAC-288's tap handler
// routes to /conversation/[guestId]; draftId is informational.
//
// Privacy (TAC-532 changed this, read it carefully): the DRAFT body still
// never lands in the payload, and neither does any commitment description. The
// GUEST'S OWN MESSAGE now does, quoted, in aps.alert.body, ruled 2026-09-23 as
// the only thing that can tell one card from another when a guest has several
// waiting and they share a trigger. It is suppressed for comp_complaint and
// for an unresolved category (shouldQuoteGuest), so a complaint is never
// rendered on a lock screen. Title is categorical and never carries guest
// text. Asserted in tests against planted guest text, not against key names.

import { loadPushRecipients, countPendingDraftsForOperator, clearOperatorPushToken } from './recipients'
import {
  capturePushSent,
  capturePushTokenInvalid,
} from '@/lib/analytics/posthog'
import {
  APPROVAL_TRIGGERS,
  GENERATION_FAILED_REVIEW_REASON,
  type ApprovalTrigger,
} from '@/lib/agent/stages'
import type { MessageCategory } from '@/lib/ai/types'
import { sendApnsRequest } from './apns/client'
import { shouldSendDraftFlaggedPush } from './push-policy'

// Re-exported so the two orchestrator call sites (handle-inbound.ts,
// handle-followup.ts) keep importing it from here. The decision itself lives
// in ./push-policy.ts, deliberately separated from the label map below —
// coupling those two jobs to one constant is what caused the 2026-06-01
// silent-drop regression.
export { shouldSendDraftFlaggedPush }

const APNS_TOKEN_INVALID_STATUS = 410
const APNS_BAD_DEVICE_TOKEN_STATUS = 400
// TAC-532: the title carries guest and reason, the body carries the guest's
// own question. Two budgets because iOS renders the two differently: the title
// is one bold line, the body gets about two when collapsed. These are starting
// values confirmed on device (the ticket's QA route), not read off a spec.
const MAX_PUSH_TITLE_CHARS = 40
const MAX_PUSH_BODY_CHARS = 110

// TAC-532. Written as a literal rather than imported from
// lib/agent/dispatch-instagram-reply.ts, which would pull Instagram's outbound
// modules (window, send, send-target, reply-check) into this file
// transitively. This module is the SHARED draft push and loads on the SMS path
// too, and TAC-469 rule 1 is "branch by channel, don't converge".
// lib/operator/queue.ts carries the same literal for the same reason.
// send.test.ts binds the two so a rename cannot drift them apart.
const INSTAGRAM_SEND_FAILED_REASON = 'instagram_send_failed'

// TAC-532, ruled 2026-09-23. A complaint gets its own title phrase and NEVER
// quotes the guest.
//
// Keyed on the CLASSIFICATION CATEGORY, never on the trigger, and that is the
// load-bearing part. comp_complaint routes to a comp-forward draft by design,
// so the commonest complaint card's primaryTrigger is commitment_type_gated,
// which ranks 1st in PRIMARY_TRIGGER_PRIORITY while category_requires_approval
// ranks 22nd of 23. Suppressing on the trigger would have leaked the quote in
// exactly the commonest complaint case, which is the opposite of the ruling.
const COMPLAINT_CATEGORY = 'comp_complaint'
const COMPLAINT_REASON = 'something went wrong'

const BODY_COMPLAINT = 'Complaint waiting for review'
const BODY_NO_QUESTION = 'Draft ready to review'

// Used only for a reason this map does not know. The map is total over every
// value that can reach a push, so this is reachable only if primaryTrigger
// arrives as something nobody declared.
const FALLBACK_REASON = 'needs review'

/**
 * TAC-532. One short phrase per reason, read at a glance on a lock screen.
 * Approved as a set on 2026-09-23.
 *
 * TOTAL, unlike the partial map this replaces. That one was partial by design
 * and twelve reasons ended up with no label at all, pushing as a bare
 * "Reply to Alex" with nothing on them to tell one card from another. The
 * `satisfies Record<...>` clause is what makes a new trigger fail tsc here
 * rather than silently arrive unlabelled, the same discipline PUSH_POLICY
 * carries and for the same reason.
 *
 * Values stay CATEGORICAL. The guest's own words go in the BODY, gated by
 * shouldQuoteGuest; nothing in this map is ever built from guest text.
 */
export const REASON_BY_REVIEW_REASON = {
  [APPROVAL_TRIGGERS.COMMITMENT_TYPE_GATED]: 'offers something',
  [APPROVAL_TRIGGERS.COMMITMENT_CANCELLATION_GATED]: 'cancels a promise',
  [APPROVAL_TRIGGERS.MECHANIC_OFFER_BACKSTOP]: 'perk offered',
  [APPROVAL_TRIGGERS.PROSE_PROMISE_BACKSTOP]: 'promises something',
  [APPROVAL_TRIGGERS.PROSE_CANCELLATION_BACKSTOP]: 'claims a cancellation',
  [APPROVAL_TRIGGERS.UNRESOLVED_CANCELLATION_ID]: 'promise not found',
  [APPROVAL_TRIGGERS.KNOWLEDGE_GAP_BACKSTOP]: 'unverified claim',
  [APPROVAL_TRIGGERS.KNOWLEDGE_GAP]: 'needs an answer',
  [APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP]: 'comp request',
  [APPROVAL_TRIGGERS.MODEL_FLAGGED]: 'needs review',
  // Deliberately identical for the two closed-venue variants. They are the
  // same thing to an operator: the reply tells a guest to come to a venue that
  // is shut. Which check caught it is our business, not theirs.
  [APPROVAL_TRIGGERS.CLOSED_VENUE_ARRIVAL_EMITTED]: 'closed, says come by',
  [APPROVAL_TRIGGERS.CLOSED_VENUE_ARRIVAL_BACKSTOP]: 'closed, says come by',
  [APPROVAL_TRIGGERS.UNVERIFIED_URL]: 'link needs checking',
  [APPROVAL_TRIGGERS.SELF_TALK_DETECTED]: 'stray text in the draft',
  // Shadowed by COMPLAINT_REASON today, since this trigger only fires on a
  // complaint category. Written out anyway so it is correct the day
  // FLOOR_CATEGORIES widens beyond comp_complaint.
  [APPROVAL_TRIGGERS.COMPLAINT_COMMITMENT_FLOOR]: 'promise on a complaint',
  // Never renders: PUSH_POLICY skips this trigger. Present so the map is total.
  [APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD]: 'needs review',
  [APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR]: 'might not sound right',
  [APPROVAL_TRIGGERS.GROUNDING_CHECK_FAILED]: 'unverified, needs a look',
  // Never renders: it can never win primary, because it always co-fires below
  // GROUNDING_CHECK_FAILED. Present so the map is total.
  [APPROVAL_TRIGGERS.GROUNDING_CHECK_DEGRADED]: 'unverified, needs a look',
  [APPROVAL_TRIGGERS.PROSE_PROMISE_CHECK_FAILED]: 'unchecked, needs a look',
  [APPROVAL_TRIGGERS.PROSE_CANCELLATION_CHECK_FAILED]: 'unchecked, needs a look',
  // Generic on purpose: the trigger is generic. The complaint case it routes
  // today is carried by COMPLAINT_REASON instead, off the category.
  [APPROVAL_TRIGGERS.CATEGORY_REQUIRES_APPROVAL]: 'held for review',
  [APPROVAL_TRIGGERS.HOLD_ALL_OUTBOUND]: 'needs review',
  [GENERATION_FAILED_REVIEW_REASON]: "couldn't write it",
  [INSTAGRAM_SEND_FAILED_REASON]: "didn't send",
} as const satisfies Record<
  | ApprovalTrigger
  | typeof GENERATION_FAILED_REVIEW_REASON
  | typeof INSTAGRAM_SEND_FAILED_REASON,
  string
>

const REASON_LOOKUP: Record<string, string | undefined> = REASON_BY_REVIEW_REASON

/**
 * Whether the guest's own words may be quoted in the push body.
 *
 * Two cases suppress, and the null one is the safe direction: a null category
 * means classification did not complete, and we cannot then establish that the
 * message was not a complaint. The crash-card call site reaches exactly that
 * state, which is why it is modelled rather than assumed away.
 */
export function shouldQuoteGuest(category: MessageCategory | null): boolean {
  return category !== null && category !== COMPLAINT_CATEGORY
}

/** The phrase after the guest's name in the title. Always categorical. */
export function resolvePushReason(
  primaryTrigger: string,
  category: MessageCategory | null,
): string {
  if (category === COMPLAINT_CATEGORY) return COMPLAINT_REASON
  return REASON_LOOKUP[primaryTrigger] ?? FALLBACK_REASON
}

/**
 * Trims to `max` characters INCLUDING the ellipsis, at a word boundary where
 * one leaves a useful amount of text. A single very long word would otherwise
 * cut to almost nothing, so the break is only taken past the halfway mark.
 */
function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  const base = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut
  return `${base.trimEnd()}…`
}

export interface SendDraftFlaggedPushInput {
  agentRunId: string
  venueId: string
  guestId: string
  /** guests.first_name. Null when unknown, falls back to "A guest". */
  guestFirstName: string | null
  /** messages.id of the pending draft. */
  draftId: string
  /** approval.primaryTrigger from applyApprovalPolicyStage. */
  primaryTrigger: string
  /**
   * TAC-532. The guest's own inbound message, or null when there is none (a
   * followup). REQUIRED rather than optional so all four call sites have to
   * decide: an optional field would let every one of them default to "no
   * question" silently, which is the shape this ticket exists to remove.
   */
  guestQuestion: string | null
  /**
   * TAC-532. The classified category of that inbound, or null when
   * classification did not complete. Decides whether the guest may be quoted
   * and whether the title takes the complaint wording. Required for the same
   * reason as guestQuestion, and null is the safe value rather than an absent
   * one.
   */
  guestCategory: MessageCategory | null
}

export function buildPushTitle(
  firstName: string | null,
  primaryTrigger: string,
  category: MessageCategory | null,
): string {
  const trimmed = firstName?.trim() ?? ''
  const name = trimmed || 'A guest'
  const reason = resolvePushReason(primaryTrigger, category)
  const full = `${name}: ${reason}`
  if (full.length <= MAX_PUSH_TITLE_CHARS) return full
  // Over budget: trim the NAME and keep the reason whole. The reason is what
  // says which card this is; a shortened name is still recognisable beside it.
  const overhead = `: ${reason}`.length
  const maxNameChars = Math.max(1, MAX_PUSH_TITLE_CHARS - overhead)
  return `${name.slice(0, maxNameChars).trimEnd()}: ${reason}`
}

export function buildPushBody(
  guestQuestion: string | null,
  category: MessageCategory | null,
): string {
  if (!shouldQuoteGuest(category)) {
    return category === COMPLAINT_CATEGORY ? BODY_COMPLAINT : BODY_NO_QUESTION
  }
  // Whitespace collapsed so a multi-line inbound renders as one run of text.
  const question = (guestQuestion ?? '').replace(/\s+/g, ' ').trim()
  if (question.length === 0) return BODY_NO_QUESTION
  // The quotes are deliberate: they mark the text as the guest's words rather
  // than ours. They cost two of the budget, hence the -2.
  return `"${truncateAtWord(question, MAX_PUSH_BODY_CHARS - 2)}"`
}

// TAC-473: these three moved to ./recipients when a third push surface
// arrived. Thin local aliases keep this file's call sites and its log lines
// exactly as they were; the prefixes are passed in for that reason.
const loadRecipients = (venueId: string) =>
  loadPushRecipients(venueId, { logPrefix: '[apns] loadRecipients', verbose: true })
const countPendingForOperator = countPendingDraftsForOperator
const nullOperatorToken = (operatorId: string) =>
  clearOperatorPushToken(operatorId, { logPrefix: 'apns: nullOperatorToken failed' })

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

  const title = buildPushTitle(
    input.guestFirstName,
    input.primaryTrigger,
    input.guestCategory,
  )
  const body = buildPushBody(input.guestQuestion, input.guestCategory)

  for (const recipient of recipients) {
    const badge = await countPendingForOperator(recipient.id)
    const payload = {
      aps: {
        alert: { title, body },
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

    const { status, reason, apnsId } = result.response
    const tokenInvalid =
      status === APNS_TOKEN_INVALID_STATUS ||
      (status === APNS_BAD_DEVICE_TOKEN_STATUS && reason === 'BadDeviceToken')

    // ONE unconditional log line carrying status + reason on EVERY response,
    // success included. The 200 branch previously logged only the badge, so a
    // UAT run couldn't distinguish "APNs accepted it" from "we never got that
    // far" without waiting on PostHog. Severity still splits log/warn so
    // non-200s stay greppable. apnsId is Apple's per-notification UUID —
    // quote it verbatim when opening a support case.
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
      console.log('[apns] apns response', responseFields)
    } else {
      console.warn('[apns] apns response', responseFields)
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

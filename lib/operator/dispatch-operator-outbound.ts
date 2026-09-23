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

import { waitUntil } from '@vercel/functions'

import {
  captureCommitmentCancelled,
  captureIntentionPromptRaised,
  captureIntentionPromptRecordingFailed,
} from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { cancelCommitmentForGuest, createCommitmentFromPending } from '@/lib/guests/commitments'
import { sendMessage } from '@/lib/messaging/send'
import { PendingCancellationSchema, PendingCommitmentSchema } from '@/lib/schemas'
import { parseMessageChannel } from '@/lib/schemas/message-channel'
import {
  prepareInstagramOperatorSend,
  sendInstagramOperatorText,
  settleFailedInstagramOperatorSend,
  stampInstagramOperatorSend,
} from './dispatch-instagram-outbound'
// TAC-385 PR 1: imported BY PATH, not through a barrel. record.ts pulls
// classifyIntentionPrompts from @/lib/ai, and CLAUDE.md documents twice
// (emoji-cadence, VERIFY_GROUNDING_TRUNCATED_ERROR_CODE) what a barrel mock
// does to something a test needs for real.
import { parseRenderedIntentionsForRecording } from '@/lib/agent/intentions/rendered'
import { recordIntentionPrompts } from '@/lib/agent/intentions/record'
import { allowsVenue, type VenueScope } from '@/lib/auth/venue-scope'

export type DispatchAction = 'approve' | 'edit'

export interface DispatchOperatorOutboundInput {
  messageId: string
  operatorId: string
  venueScope: VenueScope
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
  // TAC-309: the card has no body to send. Either a knowledge-gap card the
  // operator hasn't written yet, or an edit submitted blank. Refused BEFORE
  // the optimistic review_state flip, so the card stays in the queue.
  | 'empty_body'
  // TAC-467: the guest has no phone number (they came in on Instagram), and
  // this path can only send by text. Refused BEFORE the flip, like
  // empty_body. The routes map it to the same 502 body as sendblue_failed,
  // so the operator API Contract does not change.
  | 'no_phone_number'
  // TAC-469: an Instagram card. The first four are refused BEFORE the flip,
  // so the card stays queued; instagram_send_failed is Meta refusing or not
  // answering after it. All map to the existing 502 body with a plain-words
  // detail, so the operator API Contract does not change.
  | 'no_instagram_id'
  | 'over_byte_cap'
  | 'instagram_window_closed'
  | 'channel_unresolved'
  | 'instagram_send_failed'

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
  // TAC-297: SELECT pending_commitment so we can materialize the
  // guest_commitments row after Sendblue dispatch + the second UPDATE
  // succeed. The carrier is the agent's commitment intent, threaded
  // through the approval queue by lib/agent/schedule-and-send.ts.
  const { data: row, error: readErr } = await supabase
    .from('messages')
    .select(
      'id, venue_id, guest_id, body, category, voice_fidelity, direction, review_state, created_at, pending_commitment, pending_cancellation, rendered_intentions, channel',
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
  // TAC-530: allowsVenue is total over VenueScope -- an empty grant list
  // allows nothing, and fleet-wide allows everything. The old
  // `allowedVenueIds.length > 0 && !includes(...)` form read an empty
  // allowlist as "no restriction", which is the cookie path's meaning, and
  // let a grantless operator bearer approve or edit any card in the fleet.
  if (!allowsVenue(input.venueScope, row.venue_id)) {
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

  // ---- 3-. TAC-469: which transport. The card's own channel decides: it was
  // written for the conversation it belongs to. Nothing routes on an unknown
  // one, and that is refused before the flip too.
  const channel = parseMessageChannel(row.channel)
  if (channel === null) {
    return {
      ok: false,
      errorCode: 'channel_unresolved',
      error: "This card's channel can't be determined, so it can't be sent.",
    }
  }

  // ---- 3a. TAC-467: refuse a guest with no phone BEFORE the optimistic flip. ----
  // sendMessage refuses a null recipient too, but after the flip below, which
  // would strand the card exactly as step 3b describes. Nothing queues a card
  // for such a guest today (the Command Center Follow Up refuses them, and the
  // Instagram handler does not run the agent); this keeps a future path from
  // stranding one. Replying over Instagram is the outbound ticket's job.
  // Text arm only (TAC-469): an Instagram card is sent to the guest's scoped
  // ID, and its checks are in step 3c.
  const recipientPhone = guestRow.phone_number
  if (channel === 'text' && recipientPhone === null) {
    return {
      ok: false,
      errorCode: 'no_phone_number',
      error: 'guest has no phone number',
    }
  }

  // ---- 3b. TAC-309: refuse an empty body BEFORE the optimistic flip. ----
  //
  // `sendMessage` also refuses an empty body, but that check fires too late to
  // be the guard here. The flip below sets review_state='approved', which
  // REMOVES THE CARD FROM THE QUEUE; a failure after it leaves the row
  // approved with provider_message_id null, nothing sent, and no way for the
  // operator to get the card back. That is the module's known v1 recovery gap
  // (see the Sendblue branch below) — and knowledge-gap cards, which persist
  // deliberately blank since TAC-309, make it reachable on an ordinary
  // swipe-right rather than only during a provider outage.
  //
  // The text that matters is what would actually be dispatched: the operator's
  // edit when they supplied one, otherwise the stored draft body. Trimmed, to
  // match the send-layer check — a lone space is not an answer.
  const bodyToDispatch = input.action === 'edit' ? (input.editedBody ?? '') : row.body
  if (bodyToDispatch.trim() === '') {
    return {
      ok: false,
      errorCode: 'empty_body',
      error:
        input.action === 'edit'
          ? 'cannot send an empty message'
          : 'this card has no draft yet — open it and write the answer',
    }
  }

  // ---- 3c. TAC-469: an Instagram card's checks, BEFORE the flip, so a
  // refused card stays in the queue: the byte cap (sent verbatim, never split),
  // the account and token, and the 24-hour window.
  let instagramTarget: Awaited<ReturnType<typeof prepareInstagramOperatorSend>> | null = null
  if (channel === 'instagram') {
    instagramTarget = await prepareInstagramOperatorSend(supabase, {
      venueId: row.venue_id,
      guestId: row.guest_id,
      body: input.action === 'edit' ? input.editedBody!.trim() : row.body,
      now: new Date(),
    })
    if (!instagramTarget.ok) {
      return { ok: false, errorCode: instagramTarget.errorCode, error: instagramTarget.error }
    }
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

  // ---- 5. dispatch ----
  const sendBody = input.action === 'edit' ? input.editedBody!.trim() : row.body

  // TAC-469: the Instagram arm sends, writes the mid, and returns here; the
  // text arm below is unchanged. Steps 7 and 8 are shared, so they run after
  // either transport.
  let providerMessageId: string
  if (instagramTarget !== null && instagramTarget.ok) {
    const sent = await sendInstagramOperatorText(instagramTarget.target, sendBody)
    if (!sent.ok) {
      // Meta definitely refused: nothing reached the guest, so the card goes
      // back in the queue (rule 4). An unknown outcome stays out, as on
      // Sendblue, because it may already be in the thread.
      return {
        ok: false,
        errorCode: 'instagram_send_failed',
        error: await settleFailedInstagramOperatorSend(supabase, {
          messageId: row.id,
          flippedTo: targetReviewState,
          sent,
        }),
      }
    }
    const stamped = await stampInstagramOperatorSend(supabase, {
      messageId: row.id,
      venueId: row.venue_id,
      guestId: row.guest_id,
      mid: sent.mid,
      sentAt: now,
    })
    if (!stamped.ok) {
      return {
        ok: false,
        errorCode: 'db_error',
        // No mid in the message, unlike the Sendblue arm below: a mid encodes
        // the account, conversation and message IDs, and this string reaches
        // the route's 500 body (TAC-458). The row id identifies the card.
        error: `dispatch metadata stamp failed for message=${row.id}: ${stamped.error}`,
      }
    }
    providerMessageId = sent.mid
  } else {
    const sendResult = await sendMessage({
      venueId: row.venue_id,
      // Never null here: step 3a refused a guest with no phone before the flip.
      to: recipientPhone,
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
    providerMessageId = sendResult.data.providerMessageId
  }

  // ---- 7. TAC-297: materialize the commitment row if intent was carried ----
  // The message is now SENT. Materialize the guest_commitments row from the
  // jsonb carrier. Failure is LOGGED but does NOT roll back the dispatch —
  // the operator's draft has gone out, and rolling the message back would be
  // worse than the operator-side gap of a missing heads-up card. Reconciliation
  // ticket if pilot surfaces this failure mode.
  if (row.pending_commitment !== null) {
    const parsedPending = PendingCommitmentSchema.safeParse(row.pending_commitment)
    if (!parsedPending.success) {
      console.warn(
        `[operator] dispatch-operator-outbound: malformed pending_commitment on message=${row.id}: ${parsedPending.error.message}. Skipping commitment materialization.`,
      )
    } else {
      const commitmentResult = await createCommitmentFromPending({
        guestId: row.guest_id,
        venueId: row.venue_id,
        pendingCommitment: parsedPending.data,
        sourceMessageId: row.id,
        now: new Date(),
      })
      if (!commitmentResult.ok) {
        console.warn(
          `[operator] dispatch-operator-outbound: commitment materialization failed for message=${row.id}: ${commitmentResult.error}. Message already sent.`,
        )
      }
    }
  }

  // ---- 7b. TAC-513: cancel the commitment this reply says is cancelled ----
  // The message is now SENT, so the guest believes the promise is off. This is
  // the moment the ledger has to agree with them, and it is the whole ticket:
  // on 2026-09-21 comp GWPZ stayed `open` while a guest was told it was gone.
  //
  // Sits beside step 7 and shares its posture exactly: failure is LOGGED and
  // does NOT roll back the dispatch, because the reply has gone out and
  // unsending it is not on the table.
  //
  // SKIP NEEDS NO CODE. A skipped draft never reaches this function at all, so
  // "on skip, nothing changes" holds by construction rather than by a branch
  // somebody has to maintain.
  //
  // The carrier was resolved against the guest's own open commitments before
  // it was written (lib/schemas/guest-commitment.ts, resolveCancellation), and
  // cancelCommitmentForGuest scopes its UPDATE to this venue and guest again,
  // so a row that somehow carried a foreign id still cannot cancel anything.
  // `== null` covers BOTH null and undefined, deliberately. An absent field is
  // `undefined`, and `undefined !== null` is true, so a `!== null` guard here
  // would send a row that simply has no column into safeParse and log it as
  // malformed. CLAUDE.md records the same trap on isKnowledgeGapCard's
  // pending_until check.
  if (row.pending_cancellation != null) {
    const parsedCancellation = PendingCancellationSchema.safeParse(row.pending_cancellation)
    if (!parsedCancellation.success) {
      console.warn(
        `[operator] dispatch-operator-outbound: malformed pending_cancellation on message=${row.id}: ${parsedCancellation.error.message}. Skipping cancellation.`,
      )
    } else {
      const cancelResult = await cancelCommitmentForGuest({
        commitmentId: parsedCancellation.data.commitmentId,
        venueId: row.venue_id,
        guestId: row.guest_id,
        now: new Date(),
      })
      if (!cancelResult.ok) {
        console.warn(
          `[operator] dispatch-operator-outbound: cancellation failed for message=${row.id}, commitment=${parsedCancellation.data.commitmentId}: ${cancelResult.error}. Message already sent.`,
        )
      } else {
        // Relayed on BOTH outcomes, deliberately. transitioned=false means the
        // row had already left open/pending_ack between the draft being
        // written and the operator approving it, and the guest has now been
        // told it is cancelled either way. A guest told something is cancelled
        // when it is not is precisely what this ticket exists to surface, so it
        // must not be the quiet branch.
        await captureCommitmentCancelled({
          venueId: row.venue_id,
          guestId: row.guest_id,
          commitmentId: parsedCancellation.data.commitmentId,
          commitmentType: cancelResult.data.row?.type ?? 'unknown',
          sourceMessageId: row.id,
          via: input.action === 'edit' ? 'operator_edit' : 'operator_approve',
          transitioned: cancelResult.data.transitioned,
        })
      }
    }
  }

  // ---- 8. TAC-385 PR 1: record the ask ----
  //
  // An intention is ASKED when the message carrying it reaches the guest —
  // auto-sent, operator-approved and operator-edited-then-sent alike (ruled
  // 2026-09-15). handle-inbound records the auto-sent path; this is the other
  // two, which recorded nothing: 13 of 34 sent replies at Le Mil's in the 30
  // days to 2026-09-14, and TAC-380 made it seven intentions per guest.
  //
  // `sendBody` is THE DISPATCHED TEXT, never `row.body`. That is the whole
  // mechanism behind "read the ask from what was sent, not what was drafted":
  // the classifier judges the words that actually went out, so a question the
  // operator edited OUT is simply not returned and not recorded. No diffing.
  // Known limit, accepted: a question the operator writes IN that the model
  // never rendered cannot be returned either, because the key set is a
  // per-call enum over the offered set. It stays open and may be asked again.
  //
  // PR 1 changes nothing about WHEN an intention closes — raising still closes,
  // exactly as before. It changes which sends count as raising.
  //
  // waitUntil, not awaited, unlike step 7: this is a Haiku call on the
  // operator's approve tap. The message has already gone out, so a recording
  // failure must never turn a successful dispatch into a 502.
  //
  // Wrapped, even though every branch of the parser is written to drop rather
  // than throw: this runs AFTER the guest has the message, and it is the only
  // synchronous work left before the return. Anything that threw here would
  // reject dispatchOperatorOutbound and 500 the operator's approve on a send
  // that already succeeded.
  let renderedIntentions: ReturnType<typeof parseRenderedIntentionsForRecording> = []
  try {
    renderedIntentions = parseRenderedIntentionsForRecording(row.rendered_intentions)
  } catch (e) {
    console.error('[operator] rendered_intentions parse threw; recording nothing', {
      messageId: row.id,
      error: e instanceof Error ? e.message : String(e),
    })
  }
  if (renderedIntentions.length > 0) {
    const venueId = row.venue_id
    const guestId = row.guest_id
    const messageId = row.id
    const via = input.action === 'edit' ? ('operator_edit' as const) : ('operator_approve' as const)
    waitUntil(
      recordIntentionPrompts({
        venueId,
        guestId,
        messageId,
        sentBody: sendBody,
        openIntentions: renderedIntentions,
        now: new Date(),
      })
        .then(async (outcome) => {
          if (outcome.kind === 'recorded') {
            console.log('[operator] dispatch intention prompts recorded', {
              messageId,
              action: input.action,
              raisedKeys: outcome.raisedKeys,
              classifierAttempts: outcome.classifierAttempts,
            })
            // TAC-436 ruling 5: same event the auto-send path fires, with `via`
            // carrying which tap it was. `agentRunId` is null here because this
            // draft's run ended when it queued, possibly hours ago — the same
            // reason the failure event below passes null.
            await captureIntentionPromptRaised({
              agentRunId: null,
              via,
              venueId,
              guestId,
              messageId,
              raisedKeys: outcome.raisedKeys,
              offeredKeys: renderedIntentions.map((o) => o.key),
              classifierAttempts: outcome.classifierAttempts,
              sentBody: sendBody,
            })
          } else if (outcome.kind === 'closed_pessimistically') {
            // TAC-380 ruling 4: nothing re-asks, but these closed without a
            // verdict. On the edit path the offered set came from the model's
            // draft, which the operator may have rewritten — so a pessimistic
            // closure here can be wrong in a way the auto-send path is not.
            console.warn(
              '[operator] intention classifier failed twice; rendered intentions closed',
              { messageId, action: input.action, closedKeys: outcome.closedKeys, error: outcome.classifierError },
            )
            await captureIntentionPromptRecordingFailed({
              agentRunId: null,
              via,
              venueId,
              guestId,
              messageId,
              outcome: 'closed_pessimistically',
              keys: outcome.closedKeys,
              error: outcome.classifierError,
            })
          } else if (outcome.kind === 'write_failed') {
            console.warn('[operator] intention prompt write failed', {
              messageId,
              action: input.action,
              keys: outcome.keys,
              source: outcome.source,
              error: outcome.error,
            })
            await captureIntentionPromptRecordingFailed({
              agentRunId: null,
              via,
              venueId,
              guestId,
              messageId,
              outcome: 'write_failed',
              keys: outcome.keys,
              source: outcome.source,
              error: outcome.error,
            })
          }
        })
        .catch((e) => {
          console.error('[operator] recordIntentionPrompts threw unexpectedly', {
            messageId,
            error: e instanceof Error ? e.message : String(e),
          })
        }),
    )
  }

  return {
    ok: true,
    outcome: 'sent',
    messageId: row.id,
    venueId: row.venue_id,
    guestId: row.guest_id,
    category: row.category,
    voiceFidelity: row.voice_fidelity,
    providerMessageId,
    createdAt: row.created_at,
    originalBody: row.body,
  }
}

// TAC-469: send an agent reply to an Instagram guest.
//
// The Instagram arm of lib/agent/dispatch-reply.ts. The text arm is
// scheduleAndSend, unchanged; nothing here runs for a text conversation, and
// nothing in scheduleAndSend knows Instagram exists. Branch by channel, don't
// converge: the window, the byte cap and the reply check are Instagram's
// constraints and stay on this side (window-import-guard.test.ts enforces it).
//
// Only a reply to something the guest just did comes through here: an inbound
// reply, the crisis-safety reply, the knowledge-gap holding message. Scheduled
// follow-ups never do (TAC-469 rule 2): handleFollowup refuses an Instagram
// conversation before generating, and the engine records them as operator
// tasks instead.
//
// In order:
//   1. Split into messages exactly as the text arm does (resolveDispatchBubbles),
//      then keep every message under Instagram's 1000-byte cap by repacking
//      WHOLE sentences. Never truncated: a reply that can't be repacked (one
//      sentence over the cap, or more than MAX_BUBBLES_PER_RESPONSE messages)
//      is not sent at all and becomes a card.
//   2. Load the venue's account, the guest's scoped ID and the token. Missing
//      any of them: a card.
//   3. The window (a guard, not a router: an inbound reply is inside it by
//      definition). Closed: a card. Unreadable: sent anyway, and Meta decides.
//   4. The reply check (rule 3): if the guest's message already has a reply,
//      usually one staff typed in the Instagram app, send nothing. The
//      crisis-safety reply is exempt (ruled 2026-09-19): silencing it leaves
//      someone in crisis with nothing, while a duplicate gives them resources
//      twice. Unreadable: sent anyway, since two answers beat none.
//   5. Send each message, re-checking the window before each one, and save it.
//      Our own row usually lands first; when Meta's echo got there first, the
//      insert collides on provider_message_id and we fill in that echo row
//      instead (rule 6). The mid only exists once Meta answers, so there is
//      nothing to save before sending.
//   6. Whatever didn't go out becomes a card (rule 4), never a retry loop: the
//      whole reply when nothing went out, the rest of it when part did.
//
// No read receipt and no typing indicator: Sendblue's must never be sent for
// an Instagram message (they would go to the guest's phone, if they have one),
// and Meta's sender actions are not built.

import { randomUUID } from 'node:crypto'

import type { Database } from '@/db/types'
import type { GenerateMessageResult } from '@/lib/ai'
import { captureInstagramReplySuperseded, captureInstagramSendFailed } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { findReplyToInbound } from '@/lib/messaging/instagram/reply-check'
import {
  fitsInstagramTextCap,
  sendInstagramText,
  sendOutcomeUnknown,
  type InstagramSendFailureKind,
  type InstagramSendResult,
} from '@/lib/messaging/instagram/send'
import { loadInstagramSendTarget, type InstagramSendTargetResult } from '@/lib/messaging/instagram/send-target'
import { instagramWindowState, loadLastGuestActionAt } from '@/lib/messaging/instagram/window'
import type { GraphFailure } from '@/lib/messaging/instagram/graph'
import { fireRedAlert } from './alerts'
import type { OpenIntention } from './intentions/derive'
import { buildRenderedIntentionsPayload } from './intentions/rendered'
import { decideSlotAction, draftCommitmentIdentity, EMPTY_PENDING_ROWS, loadPendingRowsBySlot } from './pending-slots'
import { buildOutboundInsert, materializeInlineCommitment, persistOrRegenQueuedDraft } from './schedule-and-send'
import { resolveDispatchBubbles, splitIntoSentences } from './sentence-split'
import { collapseToSingleMessage, INTER_BUBBLE_GAP_MS, MAX_BUBBLES_PER_RESPONSE } from './split-message'
import type { RuntimeContext } from './types'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>
type MessageInsert = Database['public']['Tables']['messages']['Insert']
type MessageUpdate = Database['public']['Tables']['messages']['Update']

/**
 * `messages.review_reason` on a card written because an Instagram reply did
 * not go out. Outside APPROVAL_TRIGGERS: the gate had already said send.
 * lib/operator/queue.ts carries its copy.
 */
export const INSTAGRAM_SEND_FAILED_REVIEW_REASON = 'instagram_send_failed' as const

/** Migration 006's unique constraint on messages.provider_message_id. */
export const PROVIDER_MESSAGE_ID_UNIQUE_CONSTRAINT = 'messages_provider_message_id_unique'

const PG_UNIQUE_VIOLATION = '23505'

// ---------------------------------------------------------------------------
// The byte cap
// ---------------------------------------------------------------------------

export type FitResult =
  | { ok: true; bubbles: string[] }
  | { ok: false; reason: 'sentence_over_cap' | 'too_many_messages' }

/**
 * Pure. Keep every message under Instagram's 1000-byte cap without dropping a
 * character. Messages already under it are returned unchanged. Otherwise the
 * whole reply is re-split into sentences and packed greedily, whole sentences
 * only, in order, one space between them. A sentence that alone is over the
 * cap, or a reply that would need more than MAX_BUBBLES_PER_RESPONSE messages,
 * can't be sent this way at all: the caller cards it rather than cut it.
 */
export function fitBubblesToInstagramCap(bubbles: readonly string[], reply: string): FitResult {
  if (bubbles.every(fitsInstagramTextCap)) return { ok: true, bubbles: [...bubbles] }

  const sentences = splitIntoSentences(reply)
  if (sentences.some((sentence) => !fitsInstagramTextCap(sentence))) {
    return { ok: false, reason: 'sentence_over_cap' }
  }
  const packed: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const candidate = current === '' ? sentence : `${current} ${sentence}`
    if (fitsInstagramTextCap(candidate)) {
      current = candidate
    } else {
      packed.push(current)
      current = sentence
    }
  }
  if (current !== '') packed.push(current)
  if (packed.length > MAX_BUBBLES_PER_RESPONSE) return { ok: false, reason: 'too_many_messages' }
  return { ok: true, bubbles: packed }
}

// ---------------------------------------------------------------------------
// Saving a sent message when the echo may already have
// ---------------------------------------------------------------------------

/**
 * The columns our send knows and the echo doesn't. Written onto an echo row
 * that beat our insert. Deliberately NOT the body, media, provider_sent_at,
 * created_at or channel: those are the echo's record of what reached the guest,
 * and provider_sent_at is Meta's own time, which our row would not have.
 */
function agentColumns(payload: MessageInsert): MessageUpdate {
  return {
    status: payload.status,
    generated_by: payload.generated_by ?? null,
    voice_fidelity: payload.voice_fidelity ?? null,
    prompt_version: payload.prompt_version ?? null,
    category: payload.category ?? null,
    reply_to_message_id: payload.reply_to_message_id ?? null,
    langfuse_trace_id: payload.langfuse_trace_id ?? null,
    generation_id: payload.generation_id ?? null,
    review_state: payload.review_state ?? null,
    review_reason: payload.review_reason ?? null,
    sent_at: payload.sent_at ?? null,
    rendered_intentions: payload.rendered_intentions ?? null,
  }
}

/**
 * Save the row for a message Meta accepted. When the insert collides on
 * provider_message_id, the echo got here first (rule 6): fill in that echo
 * row, matched on the same mid, outbound, this guest at this venue, and still
 * without generated_by. Anything else that collides is a failure, not a match.
 */
export async function insertOrReconcileEcho(
  supabase: AdminSupabaseClient,
  payload: MessageInsert,
): Promise<{ ok: true; id: string; reconciled: boolean } | { ok: false; error: string }> {
  const { data, error } = await supabase.from('messages').insert(payload).select('id').single()
  if (!error && data) return { ok: true, id: data.id, reconciled: false }
  if (!error) return { ok: false, error: 'insert returned no row' }
  if (error.code !== PG_UNIQUE_VIOLATION || !error.message.includes(PROVIDER_MESSAGE_ID_UNIQUE_CONSTRAINT)) {
    return { ok: false, error: error.message }
  }

  const mid = payload.provider_message_id
  if (typeof mid !== 'string') return { ok: false, error: 'duplicate key without a provider_message_id' }
  const { data: rows, error: updateError } = await supabase
    .from('messages')
    .update(agentColumns(payload))
    .eq('provider_message_id', mid)
    .eq('venue_id', payload.venue_id)
    .eq('guest_id', payload.guest_id)
    .eq('direction', 'outbound')
    .is('generated_by', null)
    .select('id')
  if (updateError) return { ok: false, error: updateError.message }
  if (!rows || rows.length !== 1) {
    return { ok: false, error: `provider_message_id collided with no echo row to fill in (${rows?.length ?? 0} matched)` }
  }
  return { ok: true, id: rows[0]!.id, reconciled: true }
}

// ---------------------------------------------------------------------------
// The card a reply becomes when it doesn't go out
// ---------------------------------------------------------------------------

export type SendFailureCardResult =
  | { ok: true; cardId: string }
  | { ok: false; skipped: 'opted_out' | 'slot_occupied' | 'write_failed'; error?: string }

/**
 * Write the reply that didn't go out as a card (rule 4). Never throws.
 *
 * Mirrors the crash card (persistGenerationFailureCard in handle-inbound.ts):
 *   - a guest who opted out gets no card;
 *   - the slot rule is `never_regen`. The gate had already said send, so its
 *     own slot held nothing it cared about, or a knowledge-gap card it lets an
 *     auto-send go out beside (TAC-308). Overwriting that card would destroy
 *     the operator's question, so the card is skipped instead and the Slack
 *     event carries the text;
 *   - the push is NOT fired here. Orchestrators fire pushes, as for every
 *     other card (handle-inbound does, for the card id this returns); a helper
 *     that pushed would also pull the push module into every path that
 *     imports this file.
 *
 * `carrier` keeps the draft's commitment and rendered intentions on the card,
 * so approving it creates the commitment and records the ask as an auto-send
 * would have. The REMAINDER of a split reply carries neither: the commitment
 * was created, and the ask recorded, when its first message went out.
 */
export async function writeInstagramSendFailureCard(input: {
  ctx: RuntimeContext
  generation: GenerateMessageResult
  carrier: boolean
  renderedIntentions?: readonly OpenIntention[]
}): Promise<SendFailureCardResult> {
  const { ctx } = input
  try {
    const supabase = createAdminClient()
    const { data: guestRow } = await supabase
      .from('guests')
      .select('opted_out_at')
      .eq('id', ctx.guest.id)
      .maybeSingle()
    if (guestRow?.opted_out_at) return { ok: false, skipped: 'opted_out' }

    const generation: GenerateMessageResult = input.carrier
      ? input.generation
      : { ...input.generation, commitment: {} }
    const rows = (await loadPendingRowsBySlot(ctx.venue.id, ctx.guest.id)) ?? EMPTY_PENDING_ROWS
    const decision = decideSlotAction({
      rows,
      draftCommitment: draftCommitmentIdentity(generation.commitment, false),
      isGapTurn: false,
      truncatedOnly: false,
      callerPolicy: 'never_regen',
    })
    if (decision.action === 'drop') return { ok: false, skipped: 'slot_occupied' }

    const persisted = await persistOrRegenQueuedDraft(ctx, generation, INSTAGRAM_SEND_FAILED_REVIEW_REASON, null, {
      callerPolicy: 'never_regen',
      renderedIntentions: input.carrier ? input.renderedIntentions : undefined,
    })
    if (persisted.action === 'dropped') return { ok: false, skipped: 'slot_occupied' }
    return { ok: true, cardId: persisted.outboundMessageId }
  } catch (e) {
    return { ok: false, skipped: 'write_failed', error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// The dispatch
// ---------------------------------------------------------------------------

export interface InstagramReplyOptions {
  skipHumanFeelDelay?: boolean
  reviewReason?: string
  rng?: () => number
  renderedIntentions?: readonly OpenIntention[]
  /** The guest message this reply answers, for the reply check; 'exempt' skips the check (crisis-safety). */
  replyCheck: { inboundMessageId: string } | 'exempt'
  /**
   * What a reply that didn't go out becomes. 'card' for an inbound reply;
   * 'none' for the holding message, whose knowledge-gap card already holds the
   * guest's place in the queue.
   */
  onUndelivered: 'card' | 'none'
}

export type InstagramReplyOutcome =
  | {
      kind: 'sent'
      outboundMessageId: string
      providerMessageId: string
      generationId: string
      bubbleCount: number
      /** The rest of a split reply that didn't go out, and the card it became. */
      undelivered: { reason: string; cardId: string | null } | null
    }
  | { kind: 'carded'; reason: string; cardId: string }
  | { kind: 'not_sent'; reason: string }
  | { kind: 'superseded'; byMessageId: string }
  /** At least one message went out but none could be saved. Its echo will record it. */
  | { kind: 'sent_unrecorded'; providerMessageId: string; reason: string }

/** Everything the dispatch reaches outside itself, replaceable in tests. */
export interface InstagramDispatchDeps {
  loadTarget: (venueId: string, guestId: string) => Promise<InstagramSendTargetResult>
  loadLastGuestActionAt: (venueId: string, guestId: string) => Promise<{ ok: true; value: Date | null } | { ok: false; error: string }>
  findReplyToInbound: (input: {
    venueId: string
    guestId: string
    inboundMessageId: string
  }) => Promise<{ ok: true; value: { id: string } | null } | { ok: false; error: string }>
  sendText: (input: { accountId: string; recipientId: string; token: string; text: string }) => Promise<InstagramSendResult>
  saveMessage: (payload: MessageInsert) => Promise<{ ok: true; id: string; reconciled: boolean } | { ok: false; error: string }>
  writeCard: typeof writeInstagramSendFailureCard
  materializeCommitment: typeof materializeInlineCommitment
  now: () => Date
  sleep: (ms: number) => Promise<void>
}

function defaultDeps(): InstagramDispatchDeps {
  // Built on first use, so a test that injects every database-facing
  // dependency never constructs a client (which reads env at call time).
  let client: AdminSupabaseClient | null = null
  const supabase = (): AdminSupabaseClient => (client ??= createAdminClient())
  return {
    loadTarget: (venueId, guestId) => loadInstagramSendTarget(supabase(), { venueId, guestId }),
    loadLastGuestActionAt: (venueId, guestId) => loadLastGuestActionAt(supabase(), venueId, guestId),
    findReplyToInbound: (input) => findReplyToInbound(supabase(), input),
    sendText: (input) => sendInstagramText({ ...input, fetchImpl: fetch }),
    saveMessage: (payload) => insertOrReconcileEcho(supabase(), payload),
    writeCard: writeInstagramSendFailureCard,
    materializeCommitment: materializeInlineCommitment,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

type Failure = {
  reason: string
  windowRemainingMs: number | null
  meta: GraphFailure | null
  outcomeUnknown: boolean
}

function failure(reason: string, windowRemainingMs: number | null = null): Failure {
  return { reason, windowRemainingMs, meta: null, outcomeUnknown: false }
}

function sendFailure(kind: InstagramSendFailureKind, meta: GraphFailure | null, windowRemainingMs: number | null): Failure {
  return { reason: kind, windowRemainingMs, meta, outcomeUnknown: sendOutcomeUnknown(kind) }
}

export async function dispatchInstagramReply(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  options: InstagramReplyOptions,
  injected: Partial<InstagramDispatchDeps> = {},
): Promise<InstagramReplyOutcome> {
  const deps: InstagramDispatchDeps = { ...defaultDeps(), ...injected }
  const reply = collapseToSingleMessage(generation.body)
  const split = resolveDispatchBubbles(generation.body, options.rng ?? Math.random)

  // Report and card what didn't go out. `sent` messages went out; everything
  // after them is `undelivered`.
  const report = async (
    why: Failure,
    scope: 'whole_reply' | 'remainder',
    undeliveredBody: string,
    bubbleCount: number,
    delivered: number,
  ): Promise<SendFailureCardResult | null> => {
    let card: SendFailureCardResult | null = null
    if (options.onUndelivered === 'card' && undeliveredBody.trim() !== '') {
      card = await deps.writeCard({
        ctx,
        generation: scope === 'whole_reply' ? generation : { ...generation, body: undeliveredBody },
        carrier: scope === 'whole_reply',
        renderedIntentions: options.renderedIntentions,
      })
    }
    await captureInstagramSendFailed({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      reason: why.reason,
      scope,
      bubbleCount,
      deliveredBubbles: delivered,
      windowRemainingMs: why.windowRemainingMs,
      metaCode: why.meta?.reason === 'graph_error' ? why.meta.code : null,
      metaSubcode: why.meta?.reason === 'graph_error' ? why.meta.subcode : null,
      fbtraceId: why.meta?.reason === 'graph_error' ? why.meta.fbtraceId : null,
      outcomeUnknown: why.outcomeUnknown,
      cardId: card?.ok ? card.cardId : null,
      cardSkipped: card === null ? (options.onUndelivered === 'none' ? 'not_carded_on_this_path' : 'empty') : card.ok ? null : card.skipped,
      undeliveredBody,
    })
    return card
  }

  const wholeReplyFailed = async (why: Failure, bubbleCount: number): Promise<InstagramReplyOutcome> => {
    const card = await report(why, 'whole_reply', reply, bubbleCount, 0)
    return card?.ok ? { kind: 'carded', reason: why.reason, cardId: card.cardId } : { kind: 'not_sent', reason: why.reason }
  }

  if (split.length === 0) return wholeReplyFailed(failure('empty_body'), 0)

  const fit = fitBubblesToInstagramCap(split, reply)
  if (!fit.ok) return wholeReplyFailed(failure(fit.reason), split.length)
  const bubbles = fit.bubbles

  const target = await deps.loadTarget(ctx.venue.id, ctx.guest.id)
  if (!target.ok) return wholeReplyFailed(failure(target.problem), bubbles.length)

  const lastAction = await deps.loadLastGuestActionAt(ctx.venue.id, ctx.guest.id)
  if (!lastAction.ok) {
    console.warn('[agent] instagram window unreadable; sending and letting Meta decide', {
      agentRunId: ctx.agentRunId,
      error: lastAction.error,
    })
  } else {
    const state = instagramWindowState(lastAction.value, deps.now())
    if (!state.open) return wholeReplyFailed(failure('window_closed_by_gate', state.remainingMs), bubbles.length)
  }

  if (options.replyCheck !== 'exempt') {
    const answered = await deps.findReplyToInbound({
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      inboundMessageId: options.replyCheck.inboundMessageId,
    })
    if (!answered.ok) {
      console.warn('[agent] instagram reply check unreadable; sending anyway', {
        agentRunId: ctx.agentRunId,
        error: answered.error,
      })
    } else if (answered.value !== null) {
      await captureInstagramReplySuperseded({
        agentRunId: ctx.agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        inboundMessageId: options.replyCheck.inboundMessageId,
        answeredByMessageId: answered.value.id,
      })
      return { kind: 'superseded', byMessageId: answered.value.id }
    }
  }

  const generationId = randomUUID()
  const persistedIds: string[] = []
  let firstMid: string | null = null
  let sentCount = 0
  let stopped: Failure | null = null

  for (let index = 0; index < bubbles.length; index += 1) {
    if (index > 0 && options.skipHumanFeelDelay !== true) await deps.sleep(INTER_BUBBLE_GAP_MS)

    let remainingMs: number | null = null
    if (lastAction.ok) {
      const state = instagramWindowState(lastAction.value, deps.now())
      remainingMs = state.remainingMs
      if (!state.open) {
        stopped = failure('window_closed_by_gate', state.remainingMs)
        break
      }
    }

    const sent = await deps.sendText({ ...target.target, text: bubbles[index]! })
    if (!sent.ok) {
      stopped = sendFailure(sent.kind, sent.failure, remainingMs)
      break
    }
    sentCount += 1
    firstMid ??= sent.mid

    const saved = await deps.saveMessage(
      buildOutboundInsert(ctx, generation, {
        body: bubbles[index]!,
        generation_id: generationId,
        status: 'sent',
        review_state: 'auto_sent',
        review_reason: options.reviewReason ?? null,
        sent_at: deps.now().toISOString(),
        provider_message_id: sent.mid,
        // First row of the response only, as on the text arm (TAC-436).
        rendered_intentions:
          index === 0 && options.renderedIntentions !== undefined
            ? buildRenderedIntentionsPayload(options.renderedIntentions)
            : null,
      }),
    )
    if (!saved.ok) {
      // It reached the guest, and its echo will record it as an outbound row
      // without our details. Stop here, as the text arm does, rather than send
      // more messages whose rows might not save either.
      await fireRedAlert({
        agentRunId: ctx.agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: ctx.followupTrigger ? 'followup' : 'inbound',
        stage: 'persist',
        errorMessage: saved.error,
        extra: { channel: 'instagram', generationId, bubbleIndex: index, bubbleCount: bubbles.length },
      })
      stopped = failure('persist_failed')
      break
    }
    persistedIds.push(saved.id)
  }

  if (sentCount === 0) return wholeReplyFailed(stopped ?? failure('unknown'), bubbles.length)

  if (persistedIds.length > 0) await deps.materializeCommitment(ctx, generation, persistedIds[0]!)

  const remainder = bubbles.slice(sentCount)
  let undelivered: { reason: string; cardId: string | null } | null = null
  if (remainder.length > 0) {
    const why = stopped ?? failure('unknown')
    const card = await report(why, 'remainder', remainder.join(' '), bubbles.length, sentCount)
    undelivered = { reason: why.reason, cardId: card?.ok ? card.cardId : null }
  }

  if (persistedIds.length === 0) {
    return { kind: 'sent_unrecorded', providerMessageId: firstMid!, reason: stopped?.reason ?? 'persist_failed' }
  }
  return {
    kind: 'sent',
    outboundMessageId: persistedIds[0]!,
    providerMessageId: firstMid!,
    generationId,
    bubbleCount: persistedIds.length,
    undelivered,
  }
}

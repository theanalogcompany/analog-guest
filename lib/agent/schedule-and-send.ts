import { createAdminClient } from '@/lib/db/admin'
import type { Database } from '@/db/types'
import type { GenerateMessageResult } from '@/lib/ai'
import { markAsRead, sendMessage, sendTypingIndicator } from '@/lib/messaging'
import { fireRedAlert } from './alerts'
import { sampleTiming } from './timing'
import type { RuntimeContext } from './types'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>
type MessageInsert = Database['public']['Tables']['messages']['Insert']

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function alertKind(ctx: RuntimeContext): 'inbound' | 'followup' {
  return ctx.followupTrigger ? 'followup' : 'inbound'
}

/**
 * Single source of truth for the outbound message row shape. Both
 * scheduleAndSend (auto-send path) and persistQueuedDraft (TAC-212 queue
 * path) call this so the column set never drifts between the two.
 *
 * Caller layers in path-specific fields via `overrides`:
 *   - Auto-send: { status:'sent', review_state:'auto_sent', sent_at, provider_message_id }
 *   - Queue:     { status:'pending_review', review_state:'pending', review_reason }
 *
 * langfuse_trace_id (THE-200) is empty-string when observability is no-op;
 * null out at insert time so the partial index `WHERE langfuse_trace_id IS
 * NOT NULL` only includes real traces.
 */
function buildOutboundInsert(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  overrides: Partial<MessageInsert>,
): MessageInsert {
  return {
    venue_id: ctx.venue.id,
    guest_id: ctx.guest.id,
    direction: 'outbound',
    category: ctx.classification?.category ?? null,
    body: generation.body,
    generated_by: 'llm',
    voice_fidelity: generation.voiceFidelity,
    prompt_version: generation.promptVersion,
    reply_to_message_id: ctx.currentMessage?.id ?? null,
    langfuse_trace_id: ctx.trace.id || null,
    ...overrides,
  }
}

async function persistOutbound(
  supabase: AdminSupabaseClient,
  payload: MessageInsert,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .insert(payload)
      .select('id')
      .single()
    if (error) return { ok: false, error: error.message }
    if (!data) return { ok: false, error: 'insert returned no row' }
    return { ok: true, id: data.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Execute the human-feel send sequence for a generated reply, then persist
 * the outbound row to the messages table.
 *
 * Server-only. Uses the admin DB client. Sequence:
 *   sample timing → sleep markAsReadGap → markAsRead (inbound only) →
 *   sleep preTypingPause → typing indicator → sleep typingDuration → send →
 *   persist.
 *
 * Failure handling:
 *   - markAsRead and sendTypingIndicator failures are cosmetic — logged via
 *     console.warn and the flow continues.
 *   - sendMessage failure fires a red alert (stage='send') and throws. The
 *     outbound row is not persisted because the message did not go out.
 *   - sendMessage success followed by a persist failure fires a red alert
 *     (stage='persist') with the providerMessageId in extra so we can
 *     manually backfill, then throws. The message went out; the DB just
 *     doesn't know about it yet.
 *
 * No retries. v1 is fail-fast. The thrown error is mapped to AgentResult by
 * the caller (handle-inbound / handle-followup).
 *
 * `options.skipHumanFeelDelay`: when true, all sleeps + the typing indicator
 * are bypassed. Send + persist still happen. Used by the Command Center
 * Follow Up button — operator clicked "send" expecting a fast result, and
 * a manual outbound is by definition not a "natural" reply where typing-
 * indicator theatre belongs.
 */
export async function scheduleAndSend(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  options: { skipHumanFeelDelay?: boolean } = {},
): Promise<{ outboundMessageId: string; providerMessageId: string }> {
  const skipDelay = options.skipHumanFeelDelay === true

  if (!skipDelay) {
    const plan = sampleTiming()

    await sleep(plan.markAsReadGapMs)

    if (ctx.currentMessage) {
      const r = await markAsRead({
        venueId: ctx.venue.id,
        to: ctx.guest.phoneNumber,
        messageHandle: ctx.currentMessage.providerMessageId,
      }).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        errorCode: 'unexpected_throw' as const,
      }))
      if (!r.ok) {
        console.warn('scheduleAndSend: markAsRead failed (cosmetic)', {
          agentRunId: ctx.agentRunId,
          error: r.error,
          errorCode: r.errorCode,
        })
      }
    }

    await sleep(plan.preTypingPauseMs)

    {
      const r = await sendTypingIndicator({
        venueId: ctx.venue.id,
        to: ctx.guest.phoneNumber,
      }).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        errorCode: 'unexpected_throw' as const,
      }))
      if (!r.ok) {
        console.warn('scheduleAndSend: sendTypingIndicator failed (cosmetic)', {
          agentRunId: ctx.agentRunId,
          error: r.error,
          errorCode: r.errorCode,
        })
      }
    }

    await sleep(plan.typingDurationMs)
  }

  // SEND — failures fire alert + throw
  const sendResult = await sendMessage({
    venueId: ctx.venue.id,
    to: ctx.guest.phoneNumber,
    body: generation.body,
  }).catch((e: unknown) => ({
    ok: false as const,
    error: e instanceof Error ? e.message : String(e),
    errorCode: 'unexpected_throw' as const,
  }))

  if (!sendResult.ok) {
    await fireRedAlert({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      kind: alertKind(ctx),
      stage: 'send',
      errorMessage: sendResult.error,
      extra: { errorCode: sendResult.errorCode },
    })
    throw new Error(`scheduleAndSend: sendMessage failed: ${sendResult.error}`)
  }

  const providerMessageId = sendResult.data.providerMessageId

  // PERSIST — failures fire alert with providerMessageId + throw.
  // Row shape is centralized in buildOutboundInsert; auto-send overrides
  // layer in status='sent', review_state='auto_sent' (TAC-258), sent_at,
  // provider_message_id. The queue path lives in persistQueuedDraft below.
  const supabase = createAdminClient()
  const insertResult = await persistOutbound(
    supabase,
    buildOutboundInsert(ctx, generation, {
      status: 'sent',
      review_state: 'auto_sent',
      sent_at: new Date().toISOString(),
      provider_message_id: providerMessageId,
    }),
  )

  if (!insertResult.ok) {
    await fireRedAlert({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      kind: alertKind(ctx),
      stage: 'persist',
      errorMessage: insertResult.error,
      extra: { providerMessageId },
    })
    throw new Error(`scheduleAndSend: persist failed: ${insertResult.error}`)
  }

  return { outboundMessageId: insertResult.id, providerMessageId }
}

/**
 * TAC-212 queue path. Persist the generated draft as a pending review row
 * — no Sendblue dispatch, no timing sleeps. Mirrors the auto-send INSERT
 * site (same buildOutboundInsert helper) but with the operator-review
 * column set:
 *   - status='pending_review' (migration 001 CHECK enum)
 *   - review_state='pending'  (TAC-258 migration 018; partial index hot path)
 *   - review_reason=primaryTrigger (already-existing migration 003 column)
 *   - sent_at + provider_message_id stay null until dispatchOperatorOutbound
 *     (lib/operator/dispatch-operator-outbound.ts) stamps them on approve/edit
 *
 * No alert here on success — captureDraftQueued (PostHog) is the
 * observability event, fired by the orchestrator. Persist failure fires
 * the same red alert shape as scheduleAndSend's persist branch and throws;
 * caller (handle-inbound / handle-followup) catches and maps to
 * AgentResult.failed.
 */
export async function persistQueuedDraft(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  primaryTrigger: string,
): Promise<{ outboundMessageId: string }> {
  const supabase = createAdminClient()
  const insertResult = await persistOutbound(
    supabase,
    buildOutboundInsert(ctx, generation, {
      status: 'pending_review',
      review_state: 'pending',
      review_reason: primaryTrigger,
    }),
  )

  if (!insertResult.ok) {
    await fireRedAlert({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      kind: alertKind(ctx),
      stage: 'persist',
      errorMessage: insertResult.error,
      extra: { primaryTrigger },
    })
    throw new Error(`persistQueuedDraft: persist failed: ${insertResult.error}`)
  }

  return { outboundMessageId: insertResult.id }
}
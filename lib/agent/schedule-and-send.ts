import { createAdminClient } from '@/lib/db/admin'
import type { Database } from '@/db/types'
import type { GenerateMessageResult } from '@/lib/ai'
import { markAsRead, sendMessage, sendTypingIndicator } from '@/lib/messaging'
import { fireRedAlert } from './alerts'
import { sampleTiming } from './timing'
import type { RuntimeContext } from './types'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>
type MessageInsert = Database['public']['Tables']['messages']['Insert']
type MessageUpdate = Database['public']['Tables']['messages']['Update']

// Postgres unique_violation. Surfaces as `error.code === '23505'` on
// PostgREST responses for INSERTs that violate the migration 020 partial
// unique index `idx_messages_one_pending_per_guest`. Recovery path
// re-fetches the existing pending row and routes to UPDATE in place.
const PG_UNIQUE_VIOLATION = '23505'

// Bound on the race-recovery loop. INSERT→UPDATE→INSERT ping-pong should
// converge in one or two attempts; three is enough headroom for the rare
// case where the operator dispatches the existing pending row between our
// SELECT and our UPDATE (rowcount=0), forcing a final INSERT. Exceeding
// this means the (venue, guest) pair is in a pathological state — bail and
// alert rather than spin.
const RACE_RECOVERY_MAX_ATTEMPTS = 3

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function alertKind(ctx: RuntimeContext): 'inbound' | 'followup' {
  return ctx.followupTrigger ? 'followup' : 'inbound'
}

/**
 * Single source of truth for the outbound message row shape. Both
 * scheduleAndSend (auto-send path) and persistOrRegenQueuedDraft (TAC-212
 * + TAC-264 queue path) call this so the column set never drifts between
 * the two.
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
 * indicator theatre belongs. TAC-284 also passes this for demo guests.
 *
 * `options.reviewReason`: when set, written to `messages.review_reason` on
 * the auto-sent row. The auto-send path normally leaves `review_reason`
 * null (it's a queue-path field — see persistOrRegenQueuedDraft). TAC-284
 * uses it to stamp `'demo_bypass'` so a demo-bypassed auto-send is
 * self-describing in the conversation viewer + SQL forensics without a
 * PostHog cross-reference.
 */
export async function scheduleAndSend(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  options: { skipHumanFeelDelay?: boolean; reviewReason?: string } = {},
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
  // provider_message_id. review_reason is null on a normal auto-send and
  // 'demo_bypass' when TAC-284's demo bypass routed this draft here.
  // The queue path lives in persistOrRegenQueuedDraft below.
  const supabase = createAdminClient()
  const insertResult = await persistOutbound(
    supabase,
    buildOutboundInsert(ctx, generation, {
      status: 'sent',
      review_state: 'auto_sent',
      review_reason: options.reviewReason ?? null,
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
 * TAC-212 + TAC-264 queue path. Persist the generated draft as a pending
 * review row — no Sendblue dispatch, no timing sleeps. Two modes:
 *
 *   1. INSERT — when there's no existing pending row for (venue, guest).
 *      `existingPendingDraftId === null` AND the migration 020 partial
 *      unique index doesn't fire. Status quo behavior, mirrors the
 *      auto-send INSERT site (same buildOutboundInsert helper) but with
 *      the operator-review column set:
 *        - status='pending_review'  (migration 001 CHECK enum)
 *        - review_state='pending'   (migration 018; partial index hot path)
 *        - review_reason=primaryTrigger
 *        - sent_at + provider_message_id stay null until dispatchOperatorOutbound
 *          (lib/operator/dispatch-operator-outbound.ts) stamps them on
 *          approve/edit
 *
 *   2. UPDATE in place (regenerate) — when `existingPendingDraftId !== null`,
 *      surfaced by `findPendingDraft` inside applyApprovalPolicyStage. The
 *      no-demotion-on-regeneration invariant per TAC-264: a pending draft
 *      can't auto-send out from under an operator. Captured prior
 *      review_reason is returned to the caller so the analytics event can
 *      log the trigger transition.
 *
 *      Columns UPDATED on regen (the "current state of the draft" subset):
 *        body, voice_fidelity, prompt_version, category, reply_to_message_id,
 *        langfuse_trace_id, review_reason
 *      Columns PRESERVED on regen (operator-visible history, queue order):
 *        status='pending_review', review_state='pending' (no demotion),
 *        created_at (FIFO queue position), last_operator_action_at,
 *        last_operator_id, previous_review_state, id, venue_id, guest_id,
 *        direction, generated_by, response_review
 *      updated_at is auto-bumped by trg_messages_updated_at.
 *
 * Race recovery (TAC-264):
 *   - INSERT path: a concurrent inbound for the same (venue, guest) can win
 *     the unique-index race; the losing INSERT receives `code='23505'`. We
 *     re-fetch the now-existing pending row and recurse into UPDATE.
 *   - UPDATE path: a TOCTOU race vs. dispatchOperatorOutbound can clear the
 *     pending slot between our findPendingDraft + our UPDATE; the conditional
 *     UPDATE gated on `review_state='pending'` returns rowcount=0. We drop
 *     `existingPendingDraftId` and recurse into a fresh INSERT.
 *   - Bounded by RACE_RECOVERY_MAX_ATTEMPTS to avoid pathological spin.
 *
 * No alert here on success — captureDraftQueued / captureDraftRegenerated
 * (PostHog) are the observability events, fired by the orchestrator based
 * on the returned `action` field. Persist failure fires the same red alert
 * shape as scheduleAndSend's persist branch and throws; caller
 * (handle-inbound / handle-followup) catches and maps to AgentResult.failed.
 *
 * `priorReviewReason` is captured pre-UPDATE on the regen path so analytics
 * can observe trigger transitions (the row is overwritten in place; the
 * old value is otherwise lost). Always null on the INSERT path.
 */
export async function persistOrRegenQueuedDraft(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  primaryTrigger: string,
  initialExistingPendingDraftId: string | null,
): Promise<{
  outboundMessageId: string
  action: 'inserted' | 'updated'
  priorReviewReason: string | null
}> {
  const supabase = createAdminClient()
  let existingId: string | null = initialExistingPendingDraftId

  for (let attempt = 0; attempt < RACE_RECOVERY_MAX_ATTEMPTS; attempt++) {
    if (existingId !== null) {
      const upd = await tryRegenUpdate(supabase, ctx, generation, primaryTrigger, existingId)
      if (upd.kind === 'updated') {
        return {
          outboundMessageId: upd.id,
          action: 'updated',
          priorReviewReason: upd.priorReviewReason,
        }
      }
      if (upd.kind === 'rowcount_zero') {
        // TOCTOU vs. dispatchOperatorOutbound: row was approved/edited/skipped
        // between findPendingDraft and our UPDATE. The pending slot is now
        // empty — drop the ID and retry as INSERT on the next loop tick.
        existingId = null
        continue
      }
      // upd.kind === 'failed' — alert and throw.
      // attemptedPendingDraftId names the in-loop value (which may differ
      // from initialExistingPendingDraftId after a 23505 race-recovery
      // promoted a different row into the slot).
      await fireRedAlert({
        agentRunId: ctx.agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: alertKind(ctx),
        stage: 'persist',
        errorMessage: upd.error,
        extra: { primaryTrigger, attemptedPendingDraftId: existingId, regen: true },
      })
      throw new Error(`persistOrRegenQueuedDraft: regen update failed: ${upd.error}`)
    }

    const ins = await tryQueueInsert(supabase, ctx, generation, primaryTrigger)
    if (ins.kind === 'inserted') {
      return { outboundMessageId: ins.id, action: 'inserted', priorReviewReason: null }
    }
    if (ins.kind === 'unique_violation') {
      // A concurrent inbound for the same (venue, guest) just won the race;
      // the migration 020 partial unique index caught us. Find the racing
      // row and route to UPDATE on the next loop tick.
      console.warn(
        `[agent] persistOrRegenQueuedDraft: 23505 race on attempt=${attempt} venue=${ctx.venue.id} guest=${ctx.guest.id} — recovering via UPDATE`,
      )
      const found = await findOpenPendingRow(supabase, ctx.venue.id, ctx.guest.id)
      if (found !== null) {
        existingId = found.id
        continue
      }
      // The racing pending row vanished between our INSERT and our SELECT
      // (operator dispatched it immediately). Retry INSERT — pending slot
      // is open again.
      continue
    }
    // ins.kind === 'failed' — alert and throw.
    await fireRedAlert({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      kind: alertKind(ctx),
      stage: 'persist',
      errorMessage: ins.error,
      extra: { primaryTrigger, regen: false },
    })
    throw new Error(`persistOrRegenQueuedDraft: insert failed: ${ins.error}`)
  }

  // Exceeded race-recovery loop. Pathological state — surface and alert.
  const errMsg = `exceeded ${RACE_RECOVERY_MAX_ATTEMPTS} race-recovery attempts for venue=${ctx.venue.id} guest=${ctx.guest.id}`
  await fireRedAlert({
    agentRunId: ctx.agentRunId,
    venueId: ctx.venue.id,
    guestId: ctx.guest.id,
    kind: alertKind(ctx),
    stage: 'persist',
    errorMessage: errMsg,
    extra: { primaryTrigger },
  })
  throw new Error(`persistOrRegenQueuedDraft: ${errMsg}`)
}

/**
 * Attempt a queue-path INSERT. Distinguishes the 23505 unique_violation
 * (recoverable via UPDATE) from other failures (alertable + fatal).
 */
async function tryQueueInsert(
  supabase: AdminSupabaseClient,
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  primaryTrigger: string,
): Promise<
  | { kind: 'inserted'; id: string }
  | { kind: 'unique_violation' }
  | { kind: 'failed'; error: string }
> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .insert(
        buildOutboundInsert(ctx, generation, {
          status: 'pending_review',
          review_state: 'pending',
          review_reason: primaryTrigger,
        }),
      )
      .select('id')
      .single()
    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) {
        return { kind: 'unique_violation' }
      }
      return { kind: 'failed', error: error.message }
    }
    if (!data) return { kind: 'failed', error: 'insert returned no row' }
    return { kind: 'inserted', id: data.id }
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Attempt a regen UPDATE on an existing pending row. Gated on
 * `review_state='pending'` so a race vs. dispatchOperatorOutbound (which
 * flips the same column to 'approved'/'edited'/'skipped') produces
 * rowcount=0 rather than corrupting the operator's just-dispatched body.
 *
 * Captures `priorReviewReason` via a SELECT before the UPDATE so the
 * analytics event can observe the trigger transition. Two round-trips per
 * regen is acceptable v1 — the alternative (RETURNING with old values) is
 * not in PostgREST's Supabase wrapper, and CTE manual SQL would bypass the
 * row-level guarantees of the conditional UPDATE.
 */
async function tryRegenUpdate(
  supabase: AdminSupabaseClient,
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  primaryTrigger: string,
  existingPendingDraftId: string,
): Promise<
  | { kind: 'updated'; id: string; priorReviewReason: string | null }
  | { kind: 'rowcount_zero' }
  | { kind: 'failed'; error: string }
> {
  try {
    // Capture priorReviewReason for the analytics event. If the row is
    // gone (operator already acted), bail to rowcount_zero.
    const { data: priorRow, error: priorError } = await supabase
      .from('messages')
      .select('review_reason')
      .eq('id', existingPendingDraftId)
      .eq('review_state', 'pending')
      .maybeSingle()
    if (priorError) {
      return { kind: 'failed', error: priorError.message }
    }
    if (!priorRow) {
      return { kind: 'rowcount_zero' }
    }
    const priorReviewReason = priorRow.review_reason

    // Conditional UPDATE gated on review_state='pending'. Mirrors the
    // TAC-258 dispatchOperatorOutbound TOCTOU pattern: optimistic flip,
    // rowcount=0 means the row was acted on between SELECT and UPDATE.
    const updatePayload: MessageUpdate = {
      body: generation.body,
      voice_fidelity: generation.voiceFidelity,
      prompt_version: generation.promptVersion,
      category: ctx.classification?.category ?? null,
      reply_to_message_id: ctx.currentMessage?.id ?? null,
      langfuse_trace_id: ctx.trace.id || null,
      review_reason: primaryTrigger,
    }
    const { data: updated, error: updateError } = await supabase
      .from('messages')
      .update(updatePayload)
      .eq('id', existingPendingDraftId)
      .eq('review_state', 'pending')
      .select('id')
      .maybeSingle()
    if (updateError) {
      return { kind: 'failed', error: updateError.message }
    }
    if (!updated) {
      return { kind: 'rowcount_zero' }
    }
    return { kind: 'updated', id: updated.id, priorReviewReason }
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Race-recovery helper: look up the open pending row for a (venue, guest)
 * pair after a 23505 unique-violation on INSERT. Mirrors the read shape
 * inside findPendingDraft in lib/agent/stages.ts but is local to the
 * persist layer so it doesn't reach across module boundaries for the
 * recovery path. Returns null if the row vanished between violation and
 * read (operator dispatched in the gap) — caller retries INSERT.
 */
async function findOpenPendingRow(
  supabase: AdminSupabaseClient,
  venueId: string,
  guestId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('direction', 'outbound')
    .eq('review_state', 'pending')
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn(
      `[agent] findOpenPendingRow lookup degraded for venue=${venueId} guest=${guestId}: ${error.message}`,
    )
    return null
  }
  return data
}
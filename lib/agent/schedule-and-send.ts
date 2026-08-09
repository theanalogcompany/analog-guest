import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import type { Database } from '@/db/types'
import type { GenerateMessageResult } from '@/lib/ai'
import { createCommitmentFromPending } from '@/lib/guests/commitments'
import { markAsRead, sendMessage, sendTypingIndicator } from '@/lib/messaging'
import { type PendingCommitment, pendingFromEmission } from '@/lib/schemas'
import { fireRedAlert } from './alerts'
import { resolveDispatchBubbles } from './sentence-split'
import { INTER_BUBBLE_GAP_MS, collapseToSingleMessage } from './split-message'
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
 * TAC-308 options for the queue-path persist.
 *
 * `pendingUntil` is deliberately three-state rather than `Date | null`:
 *   - a Date        → stamp it (INSERT and UPDATE alike)
 *   - undefined     → leave the column ALONE. On INSERT that means null; on
 *                     UPDATE it means an existing clock survives untouched.
 * There is no "clear it" value here on purpose. The only thing that clears
 * `pending_until` is the timer's CAS claim, which is what makes that claim
 * the single writer of the fired/not-fired state.
 */
export interface PersistQueuedDraftOptions {
  pendingUntil?: Date
  /**
   * TAC-308: refuse to fall back to INSERT when the target row is gone.
   *
   * The default race-recovery behavior — UPDATE misses, so INSERT a fresh
   * pending row — is right for the orchestrators, where the draft still needs
   * somewhere to live. It is WRONG for the timeout regen, which is only
   * trying to freshen the body of a card that already exists. If an operator
   * approves that card mid-regen, the UPDATE matches nothing and an INSERT
   * would create a phantom: a new pending row answering a question the guest
   * was already answered, carrying review_reason='knowledge_gap' (so
   * isKnowledgeGapCard protects it forever, silently dropping later drafts)
   * with pending_until null (so the timer never touches it) and no push (the
   * orchestrators fire those, not this helper). Nothing would surface it
   * until the operator next opened the queue.
   *
   * With this set, a vanished row returns `action: 'skipped'` instead. The
   * caller's contract already treats a failed regen as best-effort.
   */
  updateOnly?: boolean
  /**
   * TAC-309: persist the card with NO body, discarding whatever the model
   * wrote.
   *
   * The discard happens HERE rather than at generation because the generation
   * genuinely needs real text: `body: z.string().min(1)` is still required,
   * the dash regex operates on it, and `voiceFidelity` is self-assessed
   * against it. Blanking at the persist boundary means the discarded guess
   * never reaches the database, is never stashed on the row, and is never
   * surfaced to the operator as a hint — which is the whole point. TAC-308
   * prefilled these cards and the first live one read "Not sure on the
   * specific matcha we source. I can find out if that matters for your
   * order." A visible guess is something you swipe, not something you replace.
   *
   * `voice_fidelity` is nulled alongside it. A blank card carrying 0.85 would
   * be claiming a voice score for text that doesn't exist. (Distinct from the
   * TAC-308 holding-message fallback, which persists 0 because there the body
   * IS what shipped.)
   */
  blankBody?: boolean
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
    // TAC-313: the DEFAULT is the delimiter-free single-message form, which is
    // what the queue path wants — a draft is one row an operator reads and
    // approves verbatim, and approve dispatches `messages.body` unchanged, so
    // a delimiter surviving here would go straight to a guest over text the
    // operator was never shown. The auto-send path overrides `body` with each
    // bubble's own text. Between them, no delimiter ever reaches the database.
    body: collapseToSingleMessage(generation.body),
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
 * the outbound row(s) to the messages table.
 *
 * Server-only. Uses the admin DB client. Sequence:
 *   split into bubbles → sample timing → sleep markAsReadGap →
 *   markAsRead (inbound only) → sleep preTypingPause → typing indicator →
 *   sleep typingDuration → [ send → persist ] → for each later bubble:
 *   typing indicator → sleep INTER_BUBBLE_GAP_MS → send → persist.
 *
 * TAC-313 shape, TAC-319 decision-maker: one generation may dispatch as up to
 * MAX_BUBBLES_PER_RESPONSE separate Sendblue messages, and EACH GETS ITS OWN
 * `messages` ROW sharing a `generation_id`. One row per bubble is forced by
 * evidence, not preference: the Sendblue status webhook resolves rows by
 * `provider_message_id` and every send returns its own handle, so a single
 * row covering two bubbles would leave the second bubble's
 * send/delivered/failed status with nowhere to land. WHETHER a reply splits
 * is decided here by resolveDispatchBubbles (sentence split + 50/50 flip),
 * not by the model — TAC-319 removed the model's R12 splitting rule after two
 * prompt-side rounds failed to make it fire.
 *
 * The opening sequence is untouched — `sampleTiming` supplies exactly the
 * numbers it always did, and no timing constant is read or changed here
 * (TAC-313 §6). Only the per-bubble gap is new, and it is a fixed constant
 * declared in ./split-message rather than derived from the opening delay.
 *
 * Failure handling. The boundary is "have we committed anything to the guest
 * yet," expressed as `persistedIds.length`, deliberately NOT as a bubble
 * index — the question is what the guest has already received, and an index
 * only answers that by coincidence.
 *
 *   - markAsRead and sendTypingIndicator failures are cosmetic — logged via
 *     console.warn and the flow continues.
 *   - NOTHING COMMITTED YET (no persisted row): unchanged from pre-TAC-313.
 *     sendMessage failure fires a red alert (stage='send') and throws, with no
 *     row persisted because the message did not go out. sendMessage success
 *     followed by a persist failure fires a red alert (stage='persist') with
 *     the providerMessageId in extra so we can manually backfill, then throws.
 *     Existing retry semantics are correct here: nothing reached the guest, so
 *     a retry cannot duplicate anything.
 *   - SOMETHING ALREADY COMMITTED (>= 1 persisted row): fire the red alert
 *     with the bubble index, stop the loop, and RETURN SUCCESSFULLY with the
 *     bubbles that landed. Throwing would map to AgentResult.failed, which for
 *     the follow-up engine calls releaseFollowupLogClaim and lets the next
 *     tick re-dispatch — sending the guest the first bubble a SECOND time. A
 *     truncated reply is a worse-than-intended message; a duplicated one reads
 *     as broken. The alert carries the truncation so it is never silent.
 *
 * No retries within a dispatch. The thrown error is mapped to AgentResult by
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
 *
 * `options.rng`: TAC-319 — the coin behind the deterministic split. Defaults
 * to Math.random at this boundary (the pure module takes it as a required
 * parameter so no randomness hides inside it); tests inject a constant to pin
 * either branch. See resolveDispatchBubbles for the full split rule.
 */
export async function scheduleAndSend(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  options: {
    skipHumanFeelDelay?: boolean
    reviewReason?: string
    rng?: () => number
  } = {},
): Promise<{
  outboundMessageId: string
  providerMessageId: string
  generationId: string
  bubbleCount: number
}> {
  const skipDelay = options.skipHumanFeelDelay === true

  // TAC-319: dispatch decides the split, not the model. Stray [[BREAK]]
  // markers are stripped as noise, the body is sentence-split, and a 2-3
  // sentence reply rides a fair coin flip — split into per-sentence bubbles
  // (terminal periods stripped) or sent as one block. Each bubble is
  // persisted with its own text, so no delimiter ever reaches the database
  // on this path.
  const bubbles = resolveDispatchBubbles(generation.body, options.rng ?? Math.random)
  if (bubbles.length === 0) {
    // Body was empty, whitespace-only, or nothing but delimiters. Nothing has
    // been sent, so this takes the ordinary send-failure path.
    await fireRedAlert({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      kind: alertKind(ctx),
      stage: 'send',
      errorMessage: 'generated body produced no sendable bubbles',
      extra: { rawBodyLength: generation.body.length },
    })
    throw new Error('scheduleAndSend: generated body produced no sendable bubbles')
  }

  // Shared by every row of this response. Minted fresh per dispatch rather
  // than reusing agentRunId: the Langfuse link already lives on
  // messages.langfuse_trace_id, and coupling the two would silently merge two
  // responses into one group if a run ever dispatched twice.
  const generationId = randomUUID()

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

  const supabase = createAdminClient()

  // Rows persisted so far, in dispatch order. Its length IS the "have we
  // committed anything to the guest yet" predicate that decides whether a
  // failure throws or truncates — see the failure-handling contract above.
  const persistedIds: string[] = []
  let firstProviderMessageId: string | null = null

  for (let index = 0; index < bubbles.length; index += 1) {
    const bubble = bubbles[index]!

    // Later bubbles get their own short typing beat. The first bubble's
    // opening sequence already ran above, untouched.
    if (index > 0 && !skipDelay) {
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
          bubbleIndex: index,
          error: r.error,
          errorCode: r.errorCode,
        })
      }
      await sleep(INTER_BUBBLE_GAP_MS)
    }

    // SEND
    const sendResult = await sendMessage({
      venueId: ctx.venue.id,
      to: ctx.guest.phoneNumber,
      body: bubble,
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
        extra: {
          errorCode: sendResult.errorCode,
          generationId,
          bubbleIndex: index,
          bubbleCount: bubbles.length,
          deliveredBubbles: persistedIds.length,
        },
      })
      if (persistedIds.length === 0) {
        throw new Error(`scheduleAndSend: sendMessage failed: ${sendResult.error}`)
      }
      // Already committed: truncate rather than throw. See the contract above
      // — throwing here re-dispatches and duplicates the earlier bubbles.
      break
    }

    const providerMessageId = sendResult.data.providerMessageId

    // PERSIST. Row shape is centralized in buildOutboundInsert; auto-send
    // overrides layer in status='sent', review_state='auto_sent' (TAC-258),
    // sent_at, provider_message_id. review_reason is null on a normal
    // auto-send and 'demo_bypass' when TAC-284's demo bypass routed this
    // draft here. The queue path lives in persistOrRegenQueuedDraft below.
    //
    // `body` is overridden to this bubble's text (buildOutboundInsert defaults
    // it to the full generated body, which is right for the single-row queue
    // path and wrong here).
    const insertResult = await persistOutbound(
      supabase,
      buildOutboundInsert(ctx, generation, {
        body: bubble,
        generation_id: generationId,
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
        extra: {
          providerMessageId,
          generationId,
          bubbleIndex: index,
          bubbleCount: bubbles.length,
          deliveredBubbles: persistedIds.length,
        },
      })
      if (persistedIds.length === 0) {
        throw new Error(`scheduleAndSend: persist failed: ${insertResult.error}`)
      }
      // This bubble reached the guest but has no row, so its delivery status
      // has nowhere to land. Accepted over re-dispatching the whole response;
      // the alert names the bubble.
      break
    }

    persistedIds.push(insertResult.id)
    if (firstProviderMessageId === null) firstProviderMessageId = providerMessageId
  }

  // Unreachable in practice: bubbles is non-empty, and every path that fails
  // before the first persist throws above. Narrowing for the type system.
  if (persistedIds.length === 0 || firstProviderMessageId === null) {
    throw new Error('scheduleAndSend: no bubble was persisted')
  }

  if (persistedIds.length < bubbles.length) {
    console.warn('scheduleAndSend: response truncated after partial dispatch', {
      agentRunId: ctx.agentRunId,
      generationId,
      sent: persistedIds.length,
      intended: bubbles.length,
    })
  }

  // TAC-297: inline commitment materialization on the auto-send path. For
  // recommendation-type commitments (ungated by COMMITMENT_TYPE_GATED, so
  // they flow through here in production) and for demo-bypassed comp/hold/
  // discount commitments (the demo flag short-circuits the approval gate
  // but the materialization still needs to happen), we write the
  // guest_commitments row inline after dispatch success. Pre-dispatch
  // would risk an orphan row if Sendblue fails; post-dispatch matches the
  // ticket's "create on send, not at draft" invariant.
  //
  // Commitment-write failure is LOGGED + accepted — the message has been
  // sent; rolling back here would just mean the operator never knows the
  // commitment was made. Reconciliation via a follow-up ticket if pilot
  // surfaces this failure mode.
  //
  // TAC-313: fires ONCE per response, not per bubble, and anchors to the first
  // bubble's row. One generation makes at most one commitment; anchoring to
  // the first row keeps `guest_commitments.source_message_id` pointing at the
  // start of the response regardless of how many bubbles it became.
  const firstMessageId = persistedIds[0]!
  const pending: PendingCommitment | null = pendingFromEmission(generation.commitment)
  if (pending !== null) {
    const commitmentResult = await createCommitmentFromPending({
      guestId: ctx.guest.id,
      venueId: ctx.venue.id,
      pendingCommitment: pending,
      sourceMessageId: firstMessageId,
      now: new Date(),
    })
    if (!commitmentResult.ok) {
      console.warn(
        `[agent] scheduleAndSend: inline commitment materialization failed for message=${firstMessageId}: ${commitmentResult.error}. Message already sent.`,
      )
    }
  }

  return {
    outboundMessageId: firstMessageId,
    providerMessageId: firstProviderMessageId,
    generationId,
    bubbleCount: persistedIds.length,
  }
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
// Overloads, so the widened return shape doesn't leak to callers that can
// never see it. Only an `updateOnly` caller can be told 'skipped'; everyone
// else keeps the original non-null contract and needs no narrowing.
export async function persistOrRegenQueuedDraft(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  primaryTrigger: string,
  initialExistingPendingDraftId: string | null,
  options: PersistQueuedDraftOptions & { updateOnly: true },
): Promise<{
  outboundMessageId: string | null
  action: 'inserted' | 'updated' | 'skipped'
  priorReviewReason: string | null
}>
export async function persistOrRegenQueuedDraft(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  primaryTrigger: string,
  initialExistingPendingDraftId: string | null,
  options?: PersistQueuedDraftOptions & { updateOnly?: false },
): Promise<{
  outboundMessageId: string
  action: 'inserted' | 'updated'
  priorReviewReason: string | null
}>
export async function persistOrRegenQueuedDraft(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  primaryTrigger: string,
  initialExistingPendingDraftId: string | null,
  options: PersistQueuedDraftOptions = {},
): Promise<{
  outboundMessageId: string | null
  action: 'inserted' | 'updated' | 'skipped'
  priorReviewReason: string | null
}> {
  const supabase = createAdminClient()
  let existingId: string | null = initialExistingPendingDraftId

  for (let attempt = 0; attempt < RACE_RECOVERY_MAX_ATTEMPTS; attempt++) {
    if (existingId !== null) {
      const upd = await tryRegenUpdate(
        supabase,
        ctx,
        generation,
        primaryTrigger,
        existingId,
        options,
      )
      if (upd.kind === 'updated') {
        return {
          outboundMessageId: upd.id,
          action: 'updated',
          priorReviewReason: upd.priorReviewReason,
        }
      }
      if (upd.kind === 'rowcount_zero') {
        // TOCTOU vs. dispatchOperatorOutbound: row was approved/edited/skipped
        // between findPendingDraft and our UPDATE.
        if (options.updateOnly === true) {
          // Update-only caller (the TAC-308 timeout regen). The row it wanted
          // to freshen is gone, which means an operator already handled it.
          // Inserting a replacement would be actively harmful — see the
          // updateOnly doc comment. Report and stop.
          return { outboundMessageId: null, action: 'skipped', priorReviewReason: null }
        }
        // The pending slot is now empty — drop the ID and retry as INSERT on
        // the next loop tick.
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

    const ins = await tryQueueInsert(supabase, ctx, generation, primaryTrigger, options)
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
  options: PersistQueuedDraftOptions,
): Promise<
  | { kind: 'inserted'; id: string }
  | { kind: 'unique_violation' }
  | { kind: 'failed'; error: string }
> {
  try {
    // TAC-297: thread the agent's commitment intent through the approval
    // queue via the pending_commitment jsonb carrier (migration 027).
    // Null when the emission isn't actionable (no-op `{}` or recommendation
    // type that already materialized inline on the auto-send path).
    const pendingCommitment = pendingFromEmission(generation.commitment)
    const { data, error } = await supabase
      .from('messages')
      .insert(
        buildOutboundInsert(ctx, generation, {
          status: 'pending_review',
          review_state: 'pending',
          review_reason: primaryTrigger,
          pending_commitment: pendingCommitment,
          // TAC-308: arms the holding-message timer. Undefined stays null —
          // only a knowledge-gap draft gets a clock.
          pending_until: options.pendingUntil?.toISOString() ?? null,
          // TAC-309: blank card. `pending_commitment` is nulled alongside the
          // body, deliberately. The carrier is NOT surfaced on QueueDraft, so
          // leaving it live would mean the operator types their own answer
          // into a blank card, sends, and dispatchOperatorOutbound
          // materializes a guest_commitments row for a comp the model
          // invented and they never saw. Pre-TAC-309 the body at least named
          // it. Given this repo's history with unauthorized comps, a model
          // that could not ground an answer does not get to bind one
          // invisibly.
          ...(options.blankBody === true
            ? { body: '', voice_fidelity: null, pending_commitment: null }
            : {}),
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
  options: PersistQueuedDraftOptions,
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
    //
    // TAC-297: pending_commitment joins the UPDATED column set (NOT
    // preserved). Per the plan-review call #1, regen overwrites the jsonb
    // wholesale — stale intent from the prior draft is replaced or nulled
    // when the new regen has no commitment. The carrier always reflects
    // the current draft's intent.
    const pendingCommitment = pendingFromEmission(generation.commitment)
    // TAC-309: same discard on the regen path. A second unanswerable question
    // refreshes the card in place and must leave it just as blank as the
    // first one did.
    const blank = options.blankBody === true
    const updatePayload: MessageUpdate = {
      // TAC-313: same strip as the INSERT path in buildOutboundInsert — a
      // regenerated draft is still a card an operator approves verbatim.
      body: blank ? '' : collapseToSingleMessage(generation.body),
      voice_fidelity: blank ? null : generation.voiceFidelity,
      prompt_version: generation.promptVersion,
      category: ctx.classification?.category ?? null,
      reply_to_message_id: ctx.currentMessage?.id ?? null,
      langfuse_trace_id: ctx.trace.id || null,
      review_reason: primaryTrigger,
      // See the INSERT path: a blank card must not carry an invisible
      // commitment the operator would unknowingly authorize on send.
      pending_commitment: blank ? null : pendingCommitment,
    }
    // TAC-308: pending_until is PRESERVE-BY-DEFAULT on regen — the key is
    // omitted from the payload unless the caller explicitly passed a new
    // clock. Two behaviors depend on the omission:
    //   - a guest asking a second unanswerable question refreshes the card's
    //     body but cannot push its deadline out
    //   - the timeout regen (which runs after the clock has fired and been
    //     cleared) cannot re-arm it, so the holding message stays one-shot
    // Contrast pending_commitment directly above, which is overwritten
    // wholesale by design (TAC-297 call #1). Different columns, opposite
    // policies, deliberately.
    if (options.pendingUntil !== undefined) {
      updatePayload.pending_until = options.pendingUntil.toISOString()
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
/**
 * Decision 0003, rewritten 2026-09-29: on the INBOUND path the five
 * post-generation checks run AFTER dispatch, off the guest's critical path.
 *
 * WHY. The verifier batch cost ~2-3s p50 on every auto-send inbound reply —
 * the largest serial cost after generation itself. The owner ruled
 * (2026-09-29) that a finding on a live channel is a Slack forward for an
 * upstream fix, not a hold: the active channels cannot recall a sent
 * message, so post-send the checks are detect-and-fix-upstream by
 * construction. The stages thread `disposition: 'sent'` into every capture,
 * so the Slack copy says the reply already went out rather than claiming a
 * hold that never happened.
 *
 * WHAT STAYS PRE-SEND, deliberately: every deterministic protection in
 * applyApprovalPolicyStage — fidelity floors, the model's own self-flag, the
 * comp regex, commitment-type gating, the PURE cancellation resolution
 * (triggers 13/16 still hold a draft whose emission cancels or dangles), the
 * structural closed-venue emission, unverified URLs, pending-slot rules,
 * per-category policy, hold_all_outbound. Only the five second-opinion LLM
 * checks defer.
 *
 * WHO STILL RUNS THEM PRE-SEND: handle-followup.ts and the holding message.
 * No guest is waiting on those turns, so they keep the fail-closed posture
 * unchanged (the stages' `disposition` parameter defaults to 'held').
 *
 * FAILS OPEN BY CONSTRUCTION. This module runs inside the webhook's
 * `waitUntil` window after the reply is gone. It never throws (outer catch),
 * and a failure here can only lose an alert, never a reply — the inverse of
 * the posture the same five calls keep on the pre-send paths.
 *
 * SPAN NAMES ARE UNCHANGED ('verify_grounding' and siblings) so existing
 * Langfuse queries keep working; each span's input carries
 * `disposition: 'sent'` to keep the two placements countable apart.
 */

import type { AgentSpanUpdate, AgentTrace } from '@/lib/observability'
import type { GenerateMessageResult } from '@/lib/ai'
import type { RuntimeContext } from './types'
import {
  verifyGroundingStage,
  verifyMechanicOfferStage,
  verifyProsePromiseStage,
  verifyCancellationClaimStage,
  verifyClosedVenueArrivalStage,
} from './stages'

export interface PostSendChecksArgs {
  ctx: RuntimeContext
  generation: GenerateMessageResult
  agentRunId: string
  /** The dispatched outbound row the findings describe. */
  outboundMessageId: string
  trace: AgentTrace
}

/**
 * Run the five checks against a reply that already reached the guest.
 * Never throws; never returns a verdict — the stages' own captures
 * (PostHog + Slack, disposition 'sent') are the entire output surface.
 */
export async function runPostSendChecks(
  args: PostSendChecksArgs,
): Promise<void> {
  const { ctx, generation, agentRunId, outboundMessageId, trace } = args
  try {
    const startedAt = Date.now()
    /** One check inside its own span, timed on its own call alone (TAC-540). */
    const timedCheck = async <T>(
      name: string,
      input: Record<string, unknown>,
      run: () => Promise<T>,
      describe: (value: T) => AgentSpanUpdate,
    ): Promise<T> => {
      const span = trace.span(name, {
        ...input,
        disposition: 'sent',
        outboundMessageId,
      })
      const checkStartedAt = Date.now()
      try {
        const value = await run()
        const described = describe(value)
        span.end({
          ...described,
          output: {
            ...(described.output as Record<string, unknown>),
            elapsedMs: Date.now() - checkStartedAt,
          },
        })
        return value
      } catch (e) {
        span.end({
          level: 'ERROR',
          statusMessage: e instanceof Error ? e.message : String(e),
          output: { elapsedMs: Date.now() - checkStartedAt },
        })
        throw e
      }
    }

    const gatedMechanicCount = ctx.mechanics.filter(
      (m) => m.requiresOperatorApproval,
    ).length
    // allSettled, not all, for the same reason the pre-send batch used it
    // (TAC-355): a hypothetical throw in one stage must not discard a
    // sibling's finding. Post-send there is no verdict to degrade to — the
    // rejection handlers below only keep the console trail honest.
    const [
      grounding,
      mechanicOffer,
      prosePromise,
      cancellation,
      closedVenueArrival,
    ] = await Promise.allSettled([
      timedCheck(
        'verify_grounding',
        { knowledgeGap: generation.knowledgeGap },
        () => verifyGroundingStage(ctx, generation, 'sent'),
        (value) => ({
          output: {
            ran: generation.knowledgeGap === false && ctx.guest.isDemo !== true,
            status: value.status,
            hasUngroundedClaim: value.status === 'flagged',
            claimCount: value.status === 'flagged' ? value.claims.length : 0,
          },
          content: trace.captureContent
            ? {
                ungroundedClaims:
                  value.status === 'flagged' ? value.claims : [],
              }
            : undefined,
        }),
      ),
      timedCheck(
        'verify_mechanic_offer',
        { gatedMechanicCount },
        () => verifyMechanicOfferStage(ctx, generation, 'sent'),
        (value) => ({ output: { status: value.status } }),
      ),
      timedCheck(
        'verify_prose_promise',
        {},
        () => verifyProsePromiseStage(ctx, generation, 'sent'),
        (value) => ({
          output: {
            status: value.status,
            namedCommitment:
              value.status === 'flagged' && value.commitment !== null,
          },
        }),
      ),
      timedCheck(
        'verify_cancellation_claim',
        {},
        () => verifyCancellationClaimStage(ctx, generation, 'sent'),
        (value) => ({
          output: { claim: value.claim, resolution: value.resolution.status },
        }),
      ),
      timedCheck(
        'verify_closed_venue_arrival',
        {},
        () => verifyClosedVenueArrivalStage(ctx, generation, 'sent'),
        (value) => ({ output: { status: value.status } }),
      ),
    ])

    const statusOf = (
      settled: PromiseSettledResult<{ status: string } | { claim: string }>,
    ): string => {
      if (settled.status === 'rejected') return 'threw'
      return 'status' in settled.value
        ? settled.value.status
        : settled.value.claim
    }
    for (const [name, settled] of [
      ['verify_grounding', grounding],
      ['verify_mechanic_offer', mechanicOffer],
      ['verify_prose_promise', prosePromise],
      ['verify_cancellation_claim', cancellation],
      ['verify_closed_venue_arrival', closedVenueArrival],
    ] as const) {
      if (settled.status === 'rejected') {
        console.warn(`[agent] post-send ${name} threw unexpectedly`, {
          agentRunId,
          outboundMessageId,
          error:
            settled.reason instanceof Error
              ? settled.reason.message
              : String(settled.reason),
        })
      }
    }
    // One line for the whole batch, so "what did the post-send checks find
    // for this sent reply" is a single log query.
    console.log('[agent] post-send checks complete', {
      agentRunId,
      outboundMessageId,
      allChecksElapsedMs: Date.now() - startedAt,
      grounding: statusOf(grounding),
      mechanicOffer: statusOf(mechanicOffer),
      prosePromise: statusOf(prosePromise),
      cancellationClaim: statusOf(cancellation),
      closedVenueArrival: statusOf(closedVenueArrival),
    })
    // The turn's own finally already flushed the trace before these spans
    // existed; flush again so they reach Langfuse from the waitUntil window.
    await trace.flushAsync()
  } catch (e) {
    // Fails open: an alert can be lost, a reply cannot be affected.
    console.error('[agent] runPostSendChecks failed', {
      agentRunId: args.agentRunId,
      outboundMessageId: args.outboundMessageId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
